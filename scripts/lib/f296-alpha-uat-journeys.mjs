import { createRedisClient, SessionStore } from '@cat-cafe/shared/utils';
import { compareCursors } from '../../packages/api/dist/domains/cats/services/stores/cursor.js';
import { RedisSessionChainStore } from '../../packages/api/dist/domains/cats/services/stores/redis/RedisSessionChainStore.js';
import { UatError, unsupportedJourney } from './f296-alpha-uat-contract.mjs';

async function readCursorEvidence(options, threadId, noticeMessageId) {
  const redis = createRedisClient({ url: options.redisUrl, keyPrefix: 'cat-cafe:' });
  try {
    await redis.ping();
    const store = new SessionStore(redis);
    const [delivery, seen, noticeTtl] = await Promise.all([
      store.getDeliveryCursor(options.userId, options.catId, threadId),
      store.getSeenCursor(options.userId, options.catId, threadId),
      noticeMessageId ? redis.ttl(`msg:${noticeMessageId}`) : Promise.resolve(null),
    ]);
    return { delivery, seen, noticeTtl };
  } catch {
    throw new UatError('failed', 'cursor_evidence_unavailable');
  } finally {
    redis.disconnect();
  }
}

export function cursorDidNotRewind(before, after) {
  if (before === null) return true;
  if (after === null) return false;
  try {
    return compareCursors(after, before) >= 0;
  } catch {
    return false;
  }
}

export function selectReplacementTriggerCandidate({ candidateIds, claims, catId, userId }) {
  for (const cliSessionId of candidateIds) {
    const claim = claims.get(cliSessionId);
    if (
      claim?.status === 'active' &&
      claim.catId === catId &&
      claim.userId === userId &&
      typeof claim.threadId === 'string' &&
      claim.threadId.length > 0
    ) {
      return { cliSessionId, mode: 'reuse', threadId: claim.threadId };
    }
  }
  for (const cliSessionId of candidateIds) {
    if (claims.get(cliSessionId) === null) return { cliSessionId, mode: 'bind' };
  }
  return null;
}

function replacementTriggerIds(options) {
  const values = Array.isArray(options.oversizedNativeThreadIds)
    ? options.oversizedNativeThreadIds
    : options.oversizedNativeThreadId
      ? [options.oversizedNativeThreadId]
      : [];
  return [...new Set(values)];
}

async function readReplacementClaims(options, candidateIds) {
  const redis = createRedisClient({ url: options.redisUrl, keyPrefix: 'cat-cafe:' });
  try {
    await redis.ping();
    const store = new RedisSessionChainStore(redis);
    return new Map(await Promise.all(candidateIds.map(async (id) => [id, await store.getByCliSessionId(id)])));
  } catch {
    throw new UatError('failed', 'replacement_state_unavailable');
  } finally {
    redis.disconnect();
  }
}

export async function runReplacementJourney({ options, createCanaryThread, json, observe }) {
  const candidateIds = replacementTriggerIds(options);
  // Missing --oversized-native-thread-id input is an operational precondition
  // of the harness run, not a provider capability verdict — keep it distinct
  // so an unconfigured run is never read as "carrier does not support it".
  if (candidateIds.length === 0) {
    return unsupportedJourney('replacement', 'replacement_input_missing');
  }
  const claims = await readReplacementClaims(options, candidateIds);
  const selection = selectReplacementTriggerCandidate({
    candidateIds,
    claims,
    catId: options.catId,
    userId: options.userId,
  });
  if (!selection) return unsupportedJourney('replacement', 'replacement_candidate_unavailable');
  let threadId = selection.threadId;
  if (selection.mode === 'bind') {
    threadId = await createCanaryThread(options, 'F296 replacement Alpha canary');
    const prime = await observe(options, threadId, 'replacement', 'Reply with the single word OK.', {
      disposition: 'fresh',
      reason: 'no_prior_session',
      transition: 'scope_first_seen',
      mode: 'cold',
      delta: 'small',
    });
    if (prime.outcome !== 'passed') return unsupportedJourney('replacement', 'prerequisite_not_observed');
    await json(
      options,
      `/api/threads/${encodeURIComponent(threadId)}/sessions/${encodeURIComponent(options.catId)}/bind`,
      { method: 'PATCH', body: JSON.stringify({ cliSessionId: selection.cliSessionId }) },
      'provider_replacement_trigger_unavailable',
    );
  }
  const before = await json(options, `/api/messages?threadId=${encodeURIComponent(threadId)}&limit=200`);
  const cursorsBefore = await readCursorEvidence(options, threadId);
  const result = await observe(options, threadId, 'replacement', 'Continue after the provider-owned rollover.', {
    disposition: 'replaced',
    reason: 'runtime_replaced',
    transition: 'replaced',
    mode: 'cold',
    delta: 'small',
  });
  if (result.outcome !== 'passed') return result;
  const [sessions, after] = await Promise.all([
    json(options, `/api/threads/${encodeURIComponent(threadId)}/sessions?catId=${encodeURIComponent(options.catId)}`),
    json(options, `/api/messages?threadId=${encodeURIComponent(threadId)}&limit=200`),
  ]);
  const old = sessions.sessions?.find((session) => session.cliSessionId === selection.cliSessionId);
  const active = sessions.sessions?.find((session) => session.status === 'active');
  const beforeIds = new Set((before.messages ?? []).map(({ id }) => id));
  const afterIds = (after.messages ?? []).map(({ id }) => id);
  const notice = (after.messages ?? []).find(
    (message) =>
      message.source?.meta?.sessionRollover?.status === 'succeeded' &&
      message.source?.meta?.sessionRollover?.reason === 'oversized_retire',
  );
  const cursorsAfter = await readCursorEvidence(options, threadId, notice?.id);
  if (
    old?.status !== 'sealed' ||
    active?.cliSessionId === selection.cliSessionId ||
    !active?.cliSessionId ||
    !notice ||
    cursorsAfter.noticeTtl !== -1 ||
    !cursorDidNotRewind(cursorsBefore.delivery, cursorsAfter.delivery) ||
    !cursorDidNotRewind(cursorsBefore.seen, cursorsAfter.seen) ||
    [...beforeIds].some((id) => afterIds.filter((candidate) => candidate === id).length !== 1)
  ) {
    return { ...result, outcome: 'failed', reason: 'replacement_state_mismatch' };
  }
  return result;
}

export async function runCompactionJourney({ options, threadId, request, observe }) {
  const compactPath = `/api/threads/${encodeURIComponent(threadId)}/sessions/${encodeURIComponent(
    options.catId,
  )}/compact-native`;
  // A response body can only be read once — parse each control response a
  // single time and carry the parsed code forward instead of re-reading.
  const readControlCode = async (candidate) => {
    try {
      return (await candidate.json())?.code ?? null;
    } catch {
      // An unreadable control-surface error keeps the conservative
      // capability-unavailable classification instead of guessing a cause.
      return null;
    }
  };
  let response = await request(options, compactPath, { method: 'POST' });
  let code = response.status === 409 ? await readControlCode(response) : null;
  // NATIVE_SESSION_BUSY is a transient admission state, not a capability
  // verdict — retry once after a poll interval before classifying.
  if (code === 'NATIVE_SESSION_BUSY') {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
    response = await request(options, compactPath, { method: 'POST' });
    code = response.status === 409 ? await readControlCode(response) : null;
  }
  if (response.status === 404 || response.status === 409) {
    const reason =
      code === 'NATIVE_SESSION_UNAVAILABLE'
        ? 'native_session_unavailable'
        : code === 'NATIVE_SESSION_BUSY'
          ? 'native_session_busy'
          : 'provider_compaction_trigger_unavailable';
    return unsupportedJourney('authoritative-compaction', reason);
  }
  if (!response.ok) {
    let code;
    try {
      code = (await response.json())?.code;
    } catch {
      // A supported control surface returning an unreadable error is still a
      // failed journey, never evidence that the trigger is unavailable.
    }
    return {
      journey: 'authoritative-compaction',
      outcome: 'failed',
      reason: code === 'NATIVE_COMPACTION_CURSOR_CHANGED' ? 'compaction_cursor_changed' : 'compaction_state_mismatch',
      observation: null,
    };
  }
  const control = await response.json();
  if (
    control.outcome !== 'observed' ||
    control.transition !== 'context_compacted' ||
    control.contextMode !== 'cold' ||
    control.cursorState !== 'preserved'
  ) {
    return {
      journey: 'authoritative-compaction',
      outcome: 'failed',
      reason: 'compaction_state_mismatch',
      observation: null,
    };
  }
  return observe(options, threadId, 'authoritative-compaction', 'Reply after authoritative compaction.', {
    disposition: 'resumed',
    reason: 'resume_confirmed',
    transition: 'resumed',
    mode: 'cold',
    delta: 'small',
  });
}
