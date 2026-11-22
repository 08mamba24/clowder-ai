/**
 * Production-entry regression for the ACP session-rebuild replay.
 *
 * QueueProcessor → AgentRouter.routeExecution passes only currentUserMessageId;
 * it never supplies the legacy `options.history`. The route therefore runs in
 * incremental mode (delivery cursor + messageStore), and with a context epoch
 * owner the projection is deferred into invokeSingleCat. These cases seed
 * history exclusively through the real MessageStore and assert that an ACP
 * resume turn still receives a self-described, bounded replay of the prior
 * turn — without leaking whispers addressed to another member and without
 * duplicating the delta that already sits in the current prompt.
 *
 * Original incident: dsh-v41-flash turn 2 (message 0001795338434294-000612-889be875)
 * failed closed with "受控历史重放缺失" because the replay was only produced
 * from options.history.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runRoute } from './helpers/cold-rebuild-bootstrap-degradation-fixture.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { REBUILD_CONTEXT_MAX_TOTAL_TOKENS } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
const { AcpAgentService } = await import('../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');

const REPLAY_HEADER = /^\/rebuild-replay v1 messages=(\d+) tokens=(\d+) truncated=(true|false)\n/;
const THREAD = 'thread-acp-incremental-rebuild';

function capturingAcpService(catId) {
  const invocations = [];
  return {
    invocations,
    contextCapability() {
      return {
        provider: 'test',
        carrier: 'acp',
        reportsRuntimeWindow: false,
        authoritativeUsage: false,
        usageTelemetry: 'unavailable',
        nativeWindowControl: false,
        nativeCompressionControl: false,
        observesCompression: false,
        reason: 'test carrier',
      };
    },
    async *invoke(prompt, options) {
      invocations.push({ prompt, options });
      yield {
        catId,
        type: 'text',
        content: `${catId} 第${invocations.length}轮回答：暗号已记住`,
        timestamp: Date.now(),
      };
      yield { catId, type: 'done', timestamp: Date.now() };
    },
  };
}

function appendUser(store, content, extra = {}) {
  return store.append(
    canonicalTestMessageInput({
      threadId: THREAD,
      userId: 'user1',
      catId: null,
      content,
      mentions: [],
      timestamp: Date.now(),
      ...extra,
    }),
  );
}

function freshStores() {
  return { messageStore: new MessageStore(), deliveryCursorStore: new DeliveryCursorStore() };
}

async function turn(route, services, stores, currentUserMessageId, targetCats) {
  const mcpSupportOverrides = Object.fromEntries(targetCats.map((catId) => [catId, false]));
  return runRoute(route, services, THREAD, {
    targetCats,
    stores,
    mcpSupportOverrides,
    // Production entry shape: no `history`, only the current message id.
    routeOptions: { currentUserMessageId },
  });
}

function assertBoundedReplay(replay) {
  assert.ok(replay, 'ACP resume turn on the incremental entry must receive the controlled replay');
  const header = replay.match(REPLAY_HEADER);
  assert.ok(header, 'replay carries the self-describing header the carrier parses');
  assert.ok(Number(header[1]) > 0, 'replay replays at least one message');
  assert.ok(Number(header[2]) <= REBUILD_CONTEXT_MAX_TOTAL_TOKENS, 'replay body stays within the rebuild budget');
}

/** Real ACP carrier over a provider that declares no session resume (dsh's per-turn retirement). */
function realAcpCarrierWithoutResume(catId) {
  const prompted = [];
  const sealed = [];
  const configOptions = [];
  const client = {
    recentCapacitySignal: null,
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    cancelSession() {},
    sessionResumeSupport: () => 'none',
    async loadSession() {
      throw new Error('loadSession must not be attempted without resume capability');
    },
    async newSession() {
      return { sessionId: 'replacement', configOptions };
    },
    async setSessionConfigOption() {
      return { configOptions };
    },
    async *promptStream(sessionId, input) {
      prompted.push(input.prompt ?? input);
      yield { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '蓝莓' } } };
    },
  };
  const service = new AcpAgentService({
    catId,
    pool: {
      async acquire(poolKey) {
        return { client, poolKey, release() {} };
      },
      sealSession(_poolKey, sessionId) {
        sealed.push(sessionId);
      },
    },
    poolKey: { projectPath: '/tmp', providerProfile: 'native' },
    projectRoot: '/tmp',
    providerName: 'dsh',
    modelName: '',
  });
  return { service, prompted, sealed };
}

describe('ACP rebuild replay on the production incremental entry', () => {
  test('serial: turn 2 replay carries turn 1 from the message store, not whispers or the current delta', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const stores = freshStores();
    const dsh = capturingAcpService('dsh');

    const first = await appendUser(stores.messageStore, '@dsh 第一轮：请记住暗号 蓝莓', { mentions: ['dsh'] });
    await turn(routeSerial, { dsh }, stores, first.id, ['dsh']);
    assert.equal(dsh.invocations.length, 1);

    await appendUser(stores.messageStore, '只给 codex 的悄悄话 柠檬', { visibility: 'whisper', whisperTo: ['codex'] });
    const second = await appendUser(stores.messageStore, '@dsh 第二轮：暗号是什么？', { mentions: ['dsh'] });
    await turn(routeSerial, { dsh }, stores, second.id, ['dsh']);
    assert.equal(dsh.invocations.length, 2);

    const { prompt, options } = dsh.invocations[1];
    const replay = options?.rebuildContextPrompt;
    assertBoundedReplay(replay);
    assert.ok(replay.includes('请记住暗号 蓝莓'), 'replay includes the prior user turn');
    assert.ok(replay.includes('dsh 第1轮回答'), 'replay includes the prior assistant turn');
    assert.ok(!replay.includes('柠檬'), 'whisper addressed to another member never enters the replay');
    assert.ok(!replay.includes('第二轮：暗号是什么'), 'current delta is not duplicated into the replay');
    assert.ok(prompt.includes('第二轮：暗号是什么'), 'current turn still reaches the prompt');

    // Hand the exact route-produced turn-2 request to the real ACP carrier: the
    // replacement session must be created (no fail-closed error) and its first
    // prompt must carry the prior turn.
    const carrier = realAcpCarrierWithoutResume('dsh');
    const emitted = [];
    for await (const message of carrier.service.invoke(prompt, { ...options, sessionId: 'cli-session-dsh' })) {
      emitted.push(message);
    }
    const errors = emitted.filter((message) => message.type === 'error');
    assert.deepEqual(errors, [], 'replacement session runs instead of failing closed');
    assert.deepEqual(carrier.sealed, ['cli-session-dsh'], 'unrecoverable prior session is sealed, not deleted');
    assert.equal(carrier.prompted.length, 1);
    const replacementPrompt = JSON.stringify(carrier.prompted[0]);
    assert.ok(replacementPrompt.includes('请记住暗号 蓝莓'), 'replacement session receives the prior user turn');
    assert.ok(replacementPrompt.includes('dsh 第1轮回答'), 'replacement session receives the prior answer');
    assert.ok(!replacementPrompt.includes('柠檬'), 'replacement session never receives the foreign whisper');
    const rebuild = emitted.find((message) => message.metadata?.sessionRebuild)?.metadata.sessionRebuild;
    assert.equal(rebuild?.reason, 'provider_without_resume_capability');
    assert.equal(rebuild?.fromSessionId, 'cli-session-dsh');
  });

  test('parallel: each ACP member receives a replay built from the same canonical history', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const stores = freshStores();
    const dsh = capturingAcpService('dsh');
    const grok = capturingAcpService('grok-build');
    const services = { dsh, 'grok-build': grok };

    const first = await appendUser(stores.messageStore, '@dsh @grok-build 并行第一轮：暗号 蓝莓', {
      mentions: ['dsh', 'grok-build'],
    });
    await turn(routeParallel, services, stores, first.id, ['dsh', 'grok-build']);
    const second = await appendUser(stores.messageStore, '@dsh @grok-build 并行第二轮：暗号是什么？', {
      mentions: ['dsh', 'grok-build'],
    });
    await turn(routeParallel, services, stores, second.id, ['dsh', 'grok-build']);

    for (const [catId, service] of Object.entries(services)) {
      assert.equal(service.invocations.length, 2, `${catId} invoked on both turns`);
      const replay = service.invocations[1].options?.rebuildContextPrompt;
      assertBoundedReplay(replay);
      assert.ok(replay.includes('并行第一轮：暗号 蓝莓'), `${catId} replay includes the prior user turn`);
      assert.ok(replay.includes(`${catId} 第1轮回答`), `${catId} replay includes its own prior answer`);
      assert.ok(!replay.includes('并行第二轮'), `${catId} replay does not duplicate the current delta`);
    }
  });

  test('non-ACP carriers on the incremental entry never receive a replay', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const stores = freshStores();
    const codex = capturingAcpService('codex');
    const first = await appendUser(stores.messageStore, '@codex 第一轮', { mentions: ['codex'] });
    await turn(routeSerial, { codex }, stores, first.id, ['codex']);
    const second = await appendUser(stores.messageStore, '@codex 第二轮', { mentions: ['codex'] });
    await turn(routeSerial, { codex }, stores, second.id, ['codex']);
    assert.equal(codex.invocations.length, 2);
    assert.equal(
      codex.invocations.every((invocation) => invocation.options?.rebuildContextPrompt === undefined),
      true,
    );
  });
});
