import type { CatId } from '@cat-cafe/shared';
import { estimateTokens } from '../../../../../utils/token-counter.js';
import { buildRebuildContextReplay, REBUILD_CONTEXT_MAX_TOTAL_TOKENS } from '../../context/ContextAssembler.js';
import { compareCursors, cursorFor, parseCursor } from '../../stores/cursor.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import { canViewMessage, getTimelineOrderTime } from '../../stores/visibility.js';

const REPLAY_PAGE_SIZE = 100;
/**
 * Upper bound on rows read for one replay. Pages walk backwards from the
 * projection boundary, so unrelated newer rows can never consume this budget;
 * foreign whispers before the boundary can, but only up to this cap.
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
  let scanned = 0;
  // +1 with no beforeId includes every row sharing the anchor's timeline time;
  // the canonical comparison below drops the ones positioned after it.
  let pageTimestamp = getTimelineOrderTime(anchor) + 1;
  let pageBeforeId: string | undefined;

  while (scanned < INCREMENTAL_REBUILD_REPLAY_SCAN_LIMIT && candidateTokens < REPLAY_CANDIDATE_TOKEN_TARGET) {
    const requested = Math.min(REPLAY_PAGE_SIZE, INCREMENTAL_REBUILD_REPLAY_SCAN_LIMIT - scanned);
    const page = await store.getByThreadBefore(threadId, pageTimestamp, requested, pageBeforeId, userId);
    if (page.length === 0) break;
    scanned += page.length;
    const newestFirst = [...page].reverse();
    const candidates = newestFirst.filter((message) => !inPrompt.has(message.id) && canViewMessage(message, viewer));
    const positions = await Promise.all(candidates.map((message) => canonicalPosition(store, message, threadId)));
    candidates.forEach((message, index) => {
      const position = positions[index];
      if (position === undefined || compareCursors(position, boundaryId) > 0) return;
      selectedNewestFirst.push(message);
      candidateTokens += estimateTokens(message.content ?? '');
    });
    const oldest = page[0] as StoredMessage;
    pageTimestamp = getTimelineOrderTime(oldest);
    pageBeforeId = oldest.id;
    if (page.length < requested) break;
  }
  return buildRebuildContextReplay(selectedNewestFirst.reverse());
}
