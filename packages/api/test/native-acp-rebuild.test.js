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

const REBUILD_PREFIX = '[受控历史重放]\nuser: 之前的问题\nassistant: 之前的回答';

function fixture({ resumeSupport, loadSessionError } = {}) {
  const calls = [];
  const sealed = [];
  const prompted = [];
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
      return { client, poolKey, release() {} };
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
  return { calls, sealed, prompted, service };
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
  // Audit metadata marks the rebuild on the persisted message metadata path.
  const doneOrChunk = messages.find((message) => message.metadata?.sessionRebuild);
  assert.ok(doneOrChunk, 'expected sessionRebuild audit metadata on an emitted message');
  assert.deepEqual(doneOrChunk.metadata.sessionRebuild, {
    fromSessionId: 'prior-turn-session',
    reason: 'provider_without_resume_capability',
  });
});

test('rebuilt turn without a replay prefix still migrates explicitly and keeps the turn prompt intact', async () => {
  const { calls, sealed, prompted, service } = fixture({ resumeSupport: 'none' });
  const messages = [];
  for await (const message of service.invoke('continue', { sessionId: 'prior-turn-session' })) messages.push(message);
  assert.ok(!calls.includes('load'));
  assert.deepEqual(sealed, ['prior-turn-session']);
  assert.equal(prompted.length, 1);
  assert.equal(prompted[0].includes('受控历史重放'), false);
  assert.ok(prompted[0].includes('continue'));
  assert.equal(
    messages.some((message) => message.type === 'error'),
    false,
  );
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
