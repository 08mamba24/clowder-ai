import type { CatId } from '@cat-cafe/shared';
import { buildRebuildContextReplay } from '../../context/ContextAssembler.js';
import { compareCursors, cursorFor } from '../../stores/cursor.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import { canViewMessage } from '../../stores/visibility.js';

/**
 * Upper bound on canonical rows read for one replay. The replay body itself is
 * capped by REBUILD_CONTEXT_MAX_TOTAL_TOKENS; this only bounds the store read.
 */
export const INCREMENTAL_REBUILD_REPLAY_FETCH_LIMIT = 200;

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
  const { boundaryId } = input;
  if (!boundaryId) return undefined;
  const viewer =
    input.thinkingMode === 'debug' ? ({ type: 'user' } as const) : ({ type: 'cat', catId: input.catId } as const);
  const inPrompt = new Set(input.promptMessageIds);
  const recent = await input.messageStore.getByThread(
    input.threadId,
    INCREMENTAL_REBUILD_REPLAY_FETCH_LIMIT,
    input.userId,
  );
  const prior = recent.filter(
    (message) =>
      !inPrompt.has(message.id) &&
      compareCursors(cursorFor(message), boundaryId) <= 0 &&
      canViewMessage(message, viewer),
  );
  return buildRebuildContextReplay(prior);
}
