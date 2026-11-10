import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AcpSessionBindingError } from '../dist/domains/cats/services/agents/providers/acp/active-session-cache.js';

catRegistry.register('native-rebuild-test', {
  ...catRegistry.tryGet('opus').config,
  id: 'native-rebuild-test',
  clientId: 'acp',
  configurationSource: 'native_tool',
  defaultModel: '',
  cli: { effort: 'low' },
});

const effortOptions = [
  { id: 'effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }] },
];

const REBUILD_PREFIX =
  '/rebuild-replay v1 messages=2 tokens=48 truncated=false\nuser: 之前的问题\nassistant: 之前的回答';
const REBUILD_PREFIX_TRUNCATED =
  '/rebuild-replay v1 messages=1 tokens=2000 truncated=true\nassistant: 只有最后一轮';
const MALFORMED_PREFIX = '[受控历史重放]\nuser: 之前的问题（没有自描述头，属于接线损伤）';

function fixture({ resumeSupport, loadSessionError, sealLeaseAfterFirstAcquire = false } = {}) {
  const calls = [];
  const sealed = [];
  const prompted = [];
  let acquireCount = 0;
  let failNextNewSession = false;
  const client = {
    recentCapacitySignal: null,
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    cancelSession() {},
    ...(resumeSupport !== undefined ? { sessionResumeSupport: () => resumeSupport } : {}),
    async loadSession(sessionId) {
      calls.push('load');
      if (loadSessionError) throw loadSessionError;
      return { sessionId, configOptions: effortOptions };
    },
    async newSession() {
      calls.push('new');
      if (failNextNewSession) {
        failNextNewSession = false;
        throw new Error('spawn failed');
      }
      return { sessionId: 'fresh', configOptions: effortOptions };
    },
    async setSessionConfigOption() {
      calls.push('config');
      return { configOptions: [{ ...effortOptions[0], currentValue: 'low' }] };
    },
    async *promptStream(sessionId, input) {
      calls.push('prompt');
      prompted.push(input.prompt ?? input);
      yield { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply' } } };
    },
  };
  const pool = {
    async acquire(poolKey) {
      acquireCount += 1;
      // After the first acquire, model the pool handing out a sealed lease for
      // the retired session id (canResumeRequestedSession=false).
      const sealedLease = sealLeaseAfterFirstAcquire && acquireCount > 1;
      return { client, poolKey, release() {}, ...(sealedLease ? { canResumeRequestedSession: false } : {}) };
    },
    sealSession(poolKey, sessionId) {
      sealed.push(sessionId);
    },
  };
  const service = new AcpAgentService({
    catId: 'native-rebuild-test',
    pool,
    poolKey: { projectPath: '/tmp', providerProfile: 'native' },
    projectRoot: '/tmp',
    providerName: 'dsh',
    modelName: '',
  });
  return {
    calls,
    sealed,
    prompted,
    service,
    failNextNewSession() {
      failNextNewSession = true;
    },
  };
}

test('provider without resume capability rebuilds an explicit replacement instead of fail-closing', async () => {
  const { calls, sealed, prompted, service } = fixture({ resumeSupport: 'none' });
  const messages = [];
  for await (const message of service.invoke('continue', {
    sessionId: 'prior-turn-session',
    rebuildContextPrompt: REBUILD_PREFIX,
  }))
    messages.push(message);
  // loadSession is never attempted; a fresh replacement session is created.
  assert.ok(!calls.includes('load'));
  assert.ok(calls.includes('new'));
  assert.ok(calls.includes('prompt'));
  // The unrecoverable session id is sealed so later turns cannot retry the load.
  assert.deepEqual(sealed, ['prior-turn-session']);
  // The controlled context replay is injected into the rebuilt turn's prompt.
  assert.equal(prompted.length, 1);
  assert.ok(prompted[0].includes(REBUILD_PREFIX));
  assert.ok(prompted[0].includes('continue'));
  // No error surfaces: the rebuild is an explicit migration, not a failure.
  assert.equal(
    messages.some((message) => message.type === 'error'),
    false,
  );
  // Audit metadata marks the rebuild on the persisted message metadata path,
  // including the parsed replay self-description.
  const doneOrChunk = messages.find((message) => message.metadata?.sessionRebuild);
  assert.ok(doneOrChunk, 'expected sessionRebuild audit metadata on an emitted message');
  assert.deepEqual(doneOrChunk.metadata.sessionRebuild, {
    fromSessionId: 'prior-turn-session',
    reason: 'provider_without_resume_capability',
    replay: { messageCount: 2, estimatedTokens: 48, truncated: false },
  });
});

test('truncated replay is audited as partial migration, not a full resume', async () => {
  const { sealed, prompted, service } = fixture({ resumeSupport: 'none' });
  const messages = [];
  for await (const message of service.invoke('continue', {
    sessionId: 'prior-turn-session',
    rebuildContextPrompt: REBUILD_PREFIX_TRUNCATED,
  }))
    messages.push(message);
  assert.deepEqual(sealed, ['prior-turn-session']);
  assert.ok(prompted[0].includes('只有最后一轮'));
  assert.equal(
    messages.some((message) => message.type === 'error'),
    false,
  );
  const audited = messages.find((message) => message.metadata?.sessionRebuild);
  assert.deepEqual(audited.metadata.sessionRebuild.replay, {
    messageCount: 1,
    estimatedTokens: 2000,
    truncated: true,
  });
});

test('legal long reply still produces a usable bounded partial replay', async () => {
  const { buildRebuildContextReplay, REBUILD_REPLAY_HEADER } = await import(
    '../dist/domains/cats/services/context/ContextAssembler.js'
  );
  const { estimateTokens } = await import('../dist/utils/token-counter.js');
  // Reviewer P2-a/P2-b counterexamples, measured against the artifact itself.
  for (const len of [2000, 9000]) {
    const history = [
      { id: 'm1', userId: 'user1', catId: null, content: '请保留上下文再回答', mentions: [], timestamp: 1000, threadId: 't' },
      { id: 'm2', userId: 'user1', catId: 'dsh', content: '测'.repeat(len), mentions: [], timestamp: 2000, threadId: 't' },
    ];
    const replay = buildRebuildContextReplay(history);
    assert.ok(replay, `len=${len}: a legal long reply must still yield a replay`);
    const header = replay.match(REBUILD_REPLAY_HEADER);
    const body = replay.slice(replay.indexOf('\n') + 1);
    assert.equal(header[3], 'true', `len=${len}: partial replay is honestly truncated`);
    assert.equal(Number(header[2]), estimateTokens(body), `len=${len}: declared tokens equal the measured body`);
    assert.ok(estimateTokens(body) <= 2000, `len=${len}: measured body stays within the 2000 budget`);
    assert.ok(replay.includes('测'), `len=${len}: the truncated newest reply stays in the replay`);
    assert.ok(replay.includes('已截断'), `len=${len}: the cut is visible, never silently dropped`);
  }
  // Distinct head/tail marks prove the cut keeps both ends (not head-only).
  const marked = [
    { id: 'm1', userId: 'user1', catId: null, content: '请保留上下文再回答', mentions: [], timestamp: 1000, threadId: 't' },
    { id: 'm2', userId: 'user1', catId: 'dsh', content: `HEAD_MARK${'测'.repeat(9000)}TAIL_MARK`, mentions: [], timestamp: 2000, threadId: 't' },
  ];
  const markedReplay = buildRebuildContextReplay(marked);
  assert.ok(markedReplay.includes('HEAD_MARK'), 'head of the long reply is kept');
  assert.ok(markedReplay.includes('TAIL_MARK'), 'tail of the long reply is kept');
  // Normal short history: audit also equals the measured body, and stays untruncated.
  const shortHistory = [
    { id: 'm1', userId: 'user1', catId: null, content: '短问题', mentions: [], timestamp: 1000, threadId: 't' },
    { id: 'm2', userId: 'user1', catId: 'dsh', content: '短回答', mentions: [], timestamp: 2000, threadId: 't' },
  ];
  const shortReplay = buildRebuildContextReplay(shortHistory);
  const shortHeader = shortReplay.match(REBUILD_REPLAY_HEADER);
  const shortBody = shortReplay.slice(shortReplay.indexOf('\n') + 1);
  assert.equal(Number(shortHeader[2]), estimateTokens(shortBody), 'short history audit equals measured body');
  assert.equal(shortHeader[3], 'false', 'short history is not truncated');
  assert.ok(estimateTokens(shortBody) <= 2000, 'short history body within budget');
  // Multi-digit message count keeps the audit exact (wrapper grows with N).
  const manyHistory = Array.from({ length: 12 }, (_, i) => ({
    id: `m${i}`, userId: 'user1', catId: i % 2 ? 'dsh' : null, content: `消息内容${i}`, mentions: [], timestamp: 1000 + i, threadId: 't',
  }));
  const manyReplay = buildRebuildContextReplay(manyHistory);
  const manyHeader = manyReplay.match(REBUILD_REPLAY_HEADER);
  const manyBody = manyReplay.slice(manyReplay.indexOf('\n') + 1);
  assert.equal(Number(manyHeader[2]), estimateTokens(manyBody), 'multi-digit count audit equals measured body');
  assert.ok(estimateTokens(manyBody) <= 2000, 'multi-digit count body within budget');
});

test('long-reply thread rebuilds with the bounded partial replay instead of failing closed', async () => {
  const { buildRebuildContextReplay } = await import(
    '../dist/domains/cats/services/context/ContextAssembler.js'
  );
  const replay = buildRebuildContextReplay([
    { id: 'm1', userId: 'user1', catId: null, content: '请保留上下文再回答', mentions: [], timestamp: 1000, threadId: 't' },
    { id: 'm2', userId: 'user1', catId: 'dsh', content: '测'.repeat(2000), mentions: [], timestamp: 2000, threadId: 't' },
  ]);
  assert.ok(replay, 'assembler-level precondition');
  const { calls, prompted, service } = fixture({ resumeSupport: 'none' });
  const messages = [];
  for await (const message of service.invoke('继续', {
    sessionId: 'long-reply-session',
    rebuildContextPrompt: replay,
  }))
    messages.push(message);
  assert.equal(
    messages.some((message) => message.type === 'error'),
    false,
    'a usable partial replay must not fail closed',
  );
  assert.ok(calls.includes('prompt'));
  assert.ok(prompted[0].includes('测'), 'carrier injected the truncated partial replay');
  assert.ok(prompted[0].includes('继续'));
  const audited = messages.find((message) => message.metadata?.sessionRebuild);
  assert.ok(audited);
  assert.equal(audited.metadata.sessionRebuild.replay.truncated, true);
  assert.ok(audited.metadata.sessionRebuild.replay.messageCount >= 1);
});

test('rebuilt turn without a replay prefix fails closed instead of running an amnesiac model call', async () => {
  const { calls, sealed, prompted, service } = fixture({ resumeSupport: 'none' });
  const messages = [];
  for await (const message of service.invoke('continue', { sessionId: 'prior-turn-session' })) messages.push(message);
  // No load, no fresh session, no prompt: a missing replay prefix means broken
  // route wiring — the model must never run on a silently amnesiac session.
  assert.ok(!calls.includes('load'));
  assert.ok(!calls.includes('prompt'));
  assert.deepEqual(sealed, []);
  assert.equal(prompted.length, 0);
  const error = messages.find((message) => message.type === 'error');
  assert.ok(error, 'expected a fail-closed error when the replay prefix is missing');
  assert.equal(error.error.includes('受控历史重放缺失'), true);
});

test('malformed replay without the self-describing header fails closed the same way', async () => {
  const { calls, sealed, prompted, service } = fixture({ resumeSupport: 'none' });
  const messages = [];
  for await (const message of service.invoke('continue', {
    sessionId: 'prior-turn-session',
    rebuildContextPrompt: MALFORMED_PREFIX,
  }))
    messages.push(message);
  // Non-empty but not a contract-shaped replay: still wiring damage, still closed.
  assert.ok(!calls.includes('prompt'));
  assert.deepEqual(sealed, []);
  assert.equal(prompted.length, 0);
  const error = messages.find((message) => message.type === 'error');
  assert.ok(error);
  assert.equal(error.error.includes('不合规'), true);
});

test('sealed session id retries as an explicit fresh turn instead of wedging after a rebuild', async () => {
  const { calls, sealed, prompted, service } = fixture({ resumeSupport: 'none', sealLeaseAfterFirstAcquire: true });
  // Turn A: rebuild happens, the old id gets sealed.
  for await (const message of service.invoke('first', {
    sessionId: 'wedged-session',
    rebuildContextPrompt: REBUILD_PREFIX,
  }));
  assert.deepEqual(sealed, ['wedged-session']);
  // Turn B: the pool now hands out canResumeRequestedSession=false for that id
  // (sealed) — the carrier must take the sealed_fresh path with the controlled
  // replay, create a session, keep continuity, and never wedge.
  const messages = [];
  for await (const message of service.invoke('second', {
    sessionId: 'wedged-session',
    rebuildContextPrompt: REBUILD_PREFIX,
  }))
    messages.push(message);
  assert.ok(calls.includes('prompt'), 'the follow-up turn must still reach the model');
  const error = messages.find((message) => message.type === 'error');
  assert.ok(!error, `sealed retry must not fail: ${error?.error ?? ''}`);
  assert.ok(prompted.at(-1).includes('second'));
  const audited = messages.find((message) => message.metadata?.sessionRebuild);
  assert.ok(audited, 'sealed retry is audited as a rebuild');
  assert.equal(audited.metadata.sessionRebuild.reason, 'sealed_session_retry');
  assert.equal(audited.metadata.sessionRebuild.fromSessionId, 'wedged-session');
  assert.deepEqual(audited.metadata.sessionRebuild.replay, {
    messageCount: 2,
    estimatedTokens: 48,
    truncated: false,
  });
});

test('sealed retry without a replay prefix fails closed before any model call', async () => {
  const { calls, sealed, prompted, service } = fixture({ resumeSupport: 'none', sealLeaseAfterFirstAcquire: true });
  for await (const message of service.invoke('first', {
    sessionId: 'wedged-session',
    rebuildContextPrompt: REBUILD_PREFIX,
  }));
  // Turn B without a replay: a sealed fresh turn must never run the model on a
  // silently amnesiac session.
  const messages = [];
  for await (const message of service.invoke('second', { sessionId: 'wedged-session' })) messages.push(message);
  assert.equal(prompted.length, 1, 'only turn A reached the model; turn B must not prompt without the controlled replay');
  const error = messages.find((message) => message.type === 'error');
  assert.ok(error, 'sealed retry without replay must surface a fail-closed error');
  assert.equal(error.error.includes('受控历史重放缺失'), true);
});

test('sealed retry with a malformed replay header fails closed the same way', async () => {
  const { prompted, service } = fixture({ resumeSupport: 'none', sealLeaseAfterFirstAcquire: true });
  for await (const message of service.invoke('first', {
    sessionId: 'wedged-session',
    rebuildContextPrompt: REBUILD_PREFIX,
  }));
  const messages = [];
  for await (const message of service.invoke('second', {
    sessionId: 'wedged-session',
    rebuildContextPrompt: MALFORMED_PREFIX,
  }))
    messages.push(message);
  assert.equal(prompted.length, 1, 'only turn A reached the model');
  const error = messages.find((message) => message.type === 'error');
  assert.ok(error);
  assert.equal(error.error.includes('不合规'), true);
});

test('newSession failure during a rebuild surfaces as an error, never a silent success', async () => {
  const failing = fixture({ resumeSupport: 'none' });
  failing.failNextNewSession();
  const messages = [];
  for await (const message of failing.service.invoke('continue', {
    sessionId: 'prior-turn-session',
    rebuildContextPrompt: REBUILD_PREFIX,
  }))
    messages.push(message);
  const error = messages.find((message) => message.type === 'error');
  assert.ok(error, 'newSession failure must surface as an error message');
  const doneAfterFailure = messages.find((message) => message.type === 'done' && !message.error);
  assert.ok(!doneAfterFailure || messages.indexOf(error) < messages.indexOf(doneAfterFailure), 'failure precedes done');
});

test('two consecutive turns keep continuity across a cold-started replacement process', async () => {
  const { calls, sealed, prompted, service } = fixture({ resumeSupport: 'none' });
  // Turn 1: fresh start, no prior session — produces session 'fresh'.
  const first = [];
  for await (const message of service.invoke('第一轮的问题', {})) first.push(message);
  assert.ok(calls.includes('new'));
  assert.ok(calls.includes('prompt'));
  assert.ok(prompted[0].includes('第一轮的问题'));
  assert.equal(
    first.some((message) => message.type === 'error'),
    false,
  );

  // Turn 2: same logical session requested, but a brand-new process (liveSessions
  // miss is modeled by the resumeSupport='none' client) must rebuild with the
  // first turn's Q/A replayed from the route-assembled prefix.
  const second = [];
  for await (const message of service.invoke('第二轮的问题', {
    sessionId: 'fresh',
    rebuildContextPrompt: '/rebuild-replay v1 messages=2 tokens=40 truncated=false\nuser: 第一轮的问题\nassistant: 第一轮的回答',
  }))
    second.push(message);
  assert.ok(!calls.includes('load'), 'must not attempt loadSession on a resume-incapable provider');
  assert.deepEqual(sealed, ['fresh'], 'the unrecoverable session id is sealed exactly once');
  const secondPrompt = prompted.at(-1);
  assert.ok(secondPrompt.includes('第一轮的问题'), 'second turn sees the first turn question');
  assert.ok(secondPrompt.includes('第一轮的回答'), 'second turn sees the first turn answer');
  assert.ok(secondPrompt.includes('第二轮的问题'), 'second turn keeps its own input');
  assert.equal(
    second.some((message) => message.type === 'error'),
    false,
  );
  const audited = second.find((message) => message.metadata?.sessionRebuild);
  assert.ok(audited, 'rebuild audit metadata present on the second turn');
  assert.equal(audited.metadata.sessionRebuild.fromSessionId, 'fresh');
});

test('provider with loadSession capability keeps the resume path untouched', async () => {
  const { calls, sealed, prompted, service } = fixture({ resumeSupport: 'load' });
  const messages = [];
  for await (const message of service.invoke('continue', {
    sessionId: 'resumable-session',
    rebuildContextPrompt: REBUILD_PREFIX,
  }))
    messages.push(message);
  assert.ok(calls.includes('load'));
  assert.equal(
    messages.some((message) => message.type === 'error'),
    false,
  );
  // No rebuild: the replay prefix must not leak into a successfully resumed turn.
  assert.equal(prompted[0].includes(REBUILD_PREFIX), false);
  assert.equal(sealed.length, 0);
  assert.equal(
    messages.some((message) => message.metadata?.sessionRebuild),
    false,
  );
});

test('legacy client without the probe keeps the fail-closed binding error', async () => {
  // No sessionResumeSupport method: the pre-probe fail-closed semantics remain
  // the backstop when capabilities disagree with the probe contract.
  const bindingError = new AcpSessionBindingError('ACP 工具未声明会话恢复能力，原历史已保留。');
  const { calls, service } = fixture({ loadSessionError: bindingError });
  const messages = [];
  for await (const message of service.invoke('continue', { sessionId: 'legacy-session' })) messages.push(message);
  assert.ok(calls.includes('load'));
  const error = messages.find((message) => message.type === 'error');
  assert.ok(error, 'expected the binding error to surface (fail-closed preserved)');
  assert.equal(error.error.includes('会话恢复能力'), true);
});

test('turn without a prior session never injects the replay prefix', async () => {
  const { calls, sealed, prompted, service } = fixture({ resumeSupport: 'none' });
  const messages = [];
  for await (const message of service.invoke('fresh start', { rebuildContextPrompt: REBUILD_PREFIX }))
    messages.push(message);
  assert.equal(calls.includes('load'), false);
  assert.equal(sealed.length, 0);
  assert.equal(prompted[0].includes(REBUILD_PREFIX), false);
  assert.ok(prompted[0].includes('fresh start'));
});
