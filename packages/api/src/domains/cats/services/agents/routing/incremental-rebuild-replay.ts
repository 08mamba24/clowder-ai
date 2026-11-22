import type { CatId } from '@cat-cafe/shared';
import { estimateTokens } from '../../../../../utils/token-counter.js';
import {
  buildRebuildContextReplay,
  isRebuildReplayEligible,
  REBUILD_CONTEXT_MAX_TOTAL_TOKENS,
} from '../../context/ContextAssembler.js';
import { compareCursors, cursorFor, parseCursor } from '../../stores/cursor.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import { canViewMessage, getTimelineOrderTime } from '../../stores/visibility.js';

const REPLAY_PAGE_SIZE = 100;
/**
 * Raw storage rows one replay may scan, charged by the store's own
 * scannedCount (canceled, foreign-owner and filtered rows included). Pages
 * walk backwards from the projection boundary, so rows newer than it never
 * consume this budget. When it runs out before replayable history is found,
 * the replay stays empty and the carrier fails closed.
 */
export const INCREMENTAL_REBUILD_REPLAY_SCAN_LIMIT = 1000;
/** Stop reading once candidates comfortably exceed the replay body budget. */
const REPLAY_CANDIDATE_TOKEN_TARGET = REBUILD_CONTEXT_MAX_TOTAL_TOKENS * 2;

export interface IncrementalRebuildReplayInput {
  readonly messageStore: IMessageStore;
  readonly userId: string;
  readonly threadId: string;
  readonly catId: CatId;
  readonly thinkingMode: 'debug' | 'play' | undefined;
  /** The visibility boundary this projection acks; nothing after it may be replayed. */
  readonly boundaryId: string | undefined;
  /** Messages already rendered into the current prompt (delta + explicit current turn). */
  readonly promptMessageIds: Iterable<string>;
}

function canonicalBoundaryMessageId(boundaryId: string | undefined): string | undefined {
  try {
    const parsed = parseCursor(boundaryId);
    return parsed?.version === 2 ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Canonical v2 position of a row, or undefined when it cannot be proven.
 * Legacy hashes may omit visibilitySeq; resolve them against the store's
 * visibility index. A row whose position stays undecidable is never replayed:
 * mixed-format comparison does not prove it precedes the boundary.
 */
async function canonicalPosition(
  store: IMessageStore,
  message: StoredMessage,
  threadId: string,
): Promise<string | undefined> {
  const cursor =
    message.visibilitySeq != null
      ? cursorFor(message)
      : store.canonicalizeCursor
        ? await store.canonicalizeCursor(message.id, threadId)
        : undefined;
  return cursor?.startsWith('v2:') ? cursor : undefined;
}

/**
 * Controlled replay for the production incremental entry.
 *
 * QueueProcessor routes carry only currentUserMessageId, so the prompt holds
 * just the unseen delta. An ACP carrier without session resume replaces its
 * session each turn and loses everything before that delta. Replay exactly
 * that part: canonical thread messages at or before the same boundary the
 * projection acks, visible to the same viewer (whisper rules), minus what the
 * prompt already contains. Own prior answers stay in, because the lost session
 * held them. Returns undefined when nothing qualifies; the carrier then fails
 * closed instead of starting an amnesiac replacement.
 */
export async function buildIncrementalRebuildReplay(input: IncrementalRebuildReplayInput): Promise<string | undefined> {
  const { messageStore: store, boundaryId, threadId, userId } = input;
  const anchorId = canonicalBoundaryMessageId(boundaryId);
  if (!boundaryId || !anchorId) return undefined;
  const anchor = await store.getById(anchorId);
  if (!anchor || anchor.threadId !== threadId) return undefined;

  const viewer =
    input.thinkingMode === 'debug' ? ({ type: 'user' } as const) : ({ type: 'cat', catId: input.catId } as const);
  const inPrompt = new Set(input.promptMessageIds);
  const selectedNewestFirst: StoredMessage[] = [];
  let candidateTokens = 0;
  let rawScanned = 0;
  // +1 with no beforeId includes every row sharing the anchor's timeline time;
  // the canonical comparison below drops the ones positioned after it.
  let pageTimestamp = getTimelineOrderTime(anchor) + 1;
  let pageBeforeId: string | undefined;

  while (rawScanned < INCREMENTAL_REBUILD_REPLAY_SCAN_LIMIT && candidateTokens < REPLAY_CANDIDATE_TOKEN_TARGET) {
    const page = await store.getByThreadBeforeBounded(
      threadId,
      pageTimestamp,
      REPLAY_PAGE_SIZE,
      pageBeforeId,
      userId,
      INCREMENTAL_REBUILD_REPLAY_SCAN_LIMIT - rawScanned,
    );
    rawScanned += page.scannedCount;
    const candidates = [...page.messages]
      .reverse()
      .filter(
        (message) => !inPrompt.has(message.id) && isRebuildReplayEligible(message) && canViewMessage(message, viewer),
      );
    const positions = await Promise.all(candidates.map((message) => canonicalPosition(store, message, threadId)));
    candidates.forEach((message, index) => {
      const position = positions[index];
      if (position === undefined || compareCursors(position, boundaryId) > 0) return;
      selectedNewestFirst.push(message);
      candidateTokens += estimateTokens(message.content ?? '');
    });
    // Continue from the store's raw continuation, not the last visible row: a
    // page whose rows were all filtered out is not proof the timeline ended.
    const next = page.nextCursor;
    if (page.exhausted || !next || (next.timestamp === pageTimestamp && next.id === pageBeforeId)) break;
    pageTimestamp = next.timestamp;
    pageBeforeId = next.id;
  }
  return buildRebuildContextReplay(selectedNewestFirst.reverse());
}
