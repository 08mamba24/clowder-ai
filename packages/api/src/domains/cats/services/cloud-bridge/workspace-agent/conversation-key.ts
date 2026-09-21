/**
 * F247 Workspace Agent (slice 1): stable outbound conversation key.
 *
 * The Workspace Agents Trigger API accepts a caller-defined
 * `conversation_key` that keeps server-side conversation continuity across
 * triggers. We derive it deterministically from the Clowder AI identity pair
 * so the same (workspace, thread) always resumes the same agent conversation
 * without any local URL binding — conversation continuity is owned by the
 * provider, not by thread metadata.
 *
 * Format: `clowder:{workspaceId}:{threadId}`
 */

const KEY_PREFIX = 'clowder';
const MAX_SEGMENT_LENGTH = 256;

export interface WorkspaceAgentConversationKeyInput {
  readonly workspaceId: string;
  readonly threadId: string;
}

function requireSegment(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SEGMENT_LENGTH) {
    throw new Error(`${field} must be a non-empty string of at most ${MAX_SEGMENT_LENGTH} characters`);
  }
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (hasControlCharacter) {
    throw new Error(`${field} must not contain control characters`);
  }
  if (value.includes(':')) {
    throw new Error(`${field} must not contain ':' — it would make the conversation key ambiguous`);
  }
  return value;
}

/** Deterministic conversation key for one (workspace, thread) outbound channel. */
export function buildWorkspaceAgentConversationKey(input: WorkspaceAgentConversationKeyInput): string {
  const workspaceId = requireSegment(input.workspaceId, 'workspaceId');
  const threadId = requireSegment(input.threadId, 'threadId');
  return `${KEY_PREFIX}:${workspaceId}:${threadId}`;
}

const CONVERSATION_KEY_REGEX = /^clowder:[^:\s]{1,256}:[^:\s]{1,256}$/;
const SEGMENT_REGEX = /^[^:\s]{1,256}$/;

/**
 * Shared segment constraint (astra R3): every consumer of a workspace id —
 * the key builder, the Settings route, and the persisted/env config — must
 * accept exactly the same values, so anything that saves can dispatch.
 */
export function isWorkspaceAgentConversationKeySegment(value: unknown): value is string {
  return typeof value === 'string' && SEGMENT_REGEX.test(value) && !value.includes('\x7f');
}

/** Structural validation for values read back from config or telemetry. */
export function isWorkspaceAgentConversationKey(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_KEY_REGEX.test(value) && !value.includes('\x7f');
}
