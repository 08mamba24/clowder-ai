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
const { buildIncrementalRebuildReplay, INCREMENTAL_REBUILD_REPLAY_SCAN_LIMIT } = await import(
  '../dist/domains/cats/services/agents/routing/incremental-rebuild-replay.js'
);
const { compareCursors, cursorFor } = await import('../dist/domains/cats/services/stores/cursor.js');
const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');

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

async function invokeReplacement(catId, invocation) {
  const carrier = realAcpCarrierWithoutResume(catId);
  const emitted = [];
  for await (const message of carrier.service.invoke(invocation.prompt, {
    ...invocation.options,
    sessionId: `cli-session-${catId}`,
  })) {
    emitted.push(message);
  }
  return { carrier, errors: emitted.filter((message) => message.type === 'error') };
}

describe('ACP incremental replay window is anchored to the projection boundary (review P2-1)', () => {
  test('route: 205 foreign whispers between turns cannot crowd out the replayable history', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const stores = freshStores();
    const dsh = capturingAcpService('dsh');
    const first = await appendUser(stores.messageStore, '@dsh 第一轮：请记住暗号 蓝莓', { mentions: ['dsh'] });
    await turn(routeSerial, { dsh }, stores, first.id, ['dsh']);
    for (let i = 0; i < 205; i++) {
      await appendUser(stores.messageStore, `只给 codex 的悄悄话 ${i}`, {
        visibility: 'whisper',
        whisperTo: ['codex'],
        mentions: ['codex'],
      });
    }
    const second = await appendUser(stores.messageStore, '@dsh 第二轮：暗号是什么？', { mentions: ['dsh'] });
    await turn(routeSerial, { dsh }, stores, second.id, ['dsh']);

    const replay = dsh.invocations[1].options?.rebuildContextPrompt;
    assertBoundedReplay(replay);
    assert.ok(replay.includes('请记住暗号 蓝莓'));
    assert.ok(replay.includes('dsh 第1轮回答'));
    assert.ok(!replay.includes('悄悄话'), 'foreign whispers stay out of the replay');
    const { carrier, errors } = await invokeReplacement('dsh', dsh.invocations[1]);
    assert.deepEqual(errors, [], 'replacement session runs instead of failing closed');
    assert.ok(JSON.stringify(carrier.prompted[0]).includes('请记住暗号 蓝莓'));
  });

  function seededHelperThread(threadId, { deltaCount, futureCount }) {
    const store = new MessageStore();
    let sequence = 0;
    const append = (content, catId = null) =>
      store.append(
        canonicalTestMessageInput({
          threadId,
          userId: 'user1',
          catId,
          content,
          mentions: [],
          timestamp: Date.now() + sequence++,
        }),
      );
    append('prior user: remember blueberry');
    append('prior assistant: blueberry remembered', 'dsh');
    const delta = Array.from({ length: deltaCount }, (_, i) => append(`current delta ${i}`));
    const future = Array.from({ length: futureCount }, (_, i) => append(`future outside boundary ${i}`));
    return { store, delta, future, boundaryId: cursorFor(delta.at(-1)) };
  }

  for (const [name, deltaCount, futureCount] of [
    ['205 rows already in the prompt', 205, 0],
    ['205 rows after the boundary', 1, 205],
  ]) {
    test(`helper: ${name} do not consume the replay window`, async () => {
      const threadId = `window-${deltaCount}-${futureCount}`;
      const { store, delta, boundaryId } = seededHelperThread(threadId, { deltaCount, futureCount });
      const replay = await buildIncrementalRebuildReplay({
        messageStore: store,
        userId: 'user1',
        threadId,
        catId: 'dsh',
        thinkingMode: 'play',
        boundaryId,
        promptMessageIds: delta.map((message) => message.id),
      });
      assertBoundedReplay(replay);
      assert.ok(replay.includes('remember blueberry'));
      assert.ok(replay.includes('blueberry remembered'));
      assert.ok(!replay.includes('current delta'), 'prompt rows are not duplicated');
      assert.ok(!replay.includes('future outside boundary'), 'rows after the boundary are never replayed');
    });
  }
});

describe('ACP incremental replay only replays rows with a provable canonical position (review P2-2)', () => {
  test('legacy hash without visibilitySeq is resolved through the visibility index, never assumed', async () => {
    const threadId = 'legacy-hash-index-coordinate';
    const store = new MessageStore();
    let sequence = 0;
    const append = (content) =>
      store.append(
        canonicalTestMessageInput({
          threadId,
          userId: 'user1',
          catId: null,
          content,
          mentions: [],
          timestamp: Date.now() + sequence++,
        }),
      );
    const prior = append('prior visible history');
    const current = append('current boundary');
    const boundaryId = cursorFor(current);
    const later = append('FUTURE_AFTER_BOUNDARY_MUST_NOT_REPLAY');
    assert.ok(compareCursors(store.canonicalizeCursor(later.id, threadId), boundaryId) > 0);
    // Legacy hashes omit the field while the visibility index still holds the position.
    delete later.visibilitySeq;
    delete prior.visibilitySeq;
    assert.equal(compareCursors(cursorFor(later), boundaryId), 0, 'mixed-format comparison is undecidable');

    const replay = await buildIncrementalRebuildReplay({
      messageStore: store,
      userId: 'user1',
      threadId,
      catId: 'dsh',
      thinkingMode: 'play',
      boundaryId,
      promptMessageIds: [current.id],
    });
    assertBoundedReplay(replay);
    assert.ok(replay.includes('prior visible history'), 'legacy row before the boundary resolves and replays');
    assert.ok(!replay.includes('FUTURE_AFTER_BOUNDARY_MUST_NOT_REPLAY'), 'legacy row after the boundary stays out');
  });

  test('a row whose position cannot be resolved is excluded rather than treated as before the boundary', async () => {
    const threadId = 'legacy-hash-unresolvable';
    const store = new MessageStore();
    let sequence = 0;
    const append = (content) =>
      store.append(
        canonicalTestMessageInput({
          threadId,
          userId: 'user1',
          catId: null,
          content,
          mentions: [],
          timestamp: Date.now() + sequence++,
        }),
      );
    append('resolvable prior history');
    const unresolvable = append('UNRESOLVABLE_POSITION');
    const current = append('current boundary');
    delete unresolvable.visibilitySeq;
    const canonicalize = store.canonicalizeCursor.bind(store);
    store.canonicalizeCursor = (messageId, thread) =>
      messageId === unresolvable.id ? messageId : canonicalize(messageId, thread);

    const replay = await buildIncrementalRebuildReplay({
      messageStore: store,
      userId: 'user1',
      threadId,
      catId: 'dsh',
      thinkingMode: 'play',
      boundaryId: cursorFor(current),
      promptMessageIds: [current.id],
    });
    assertBoundedReplay(replay);
    assert.ok(replay.includes('resolvable prior history'));
    assert.ok(!replay.includes('UNRESOLVABLE_POSITION'));
  });
});

describe('ACP incremental replay budgets use the replay eligibility and raw scan coordinates (review round 2)', () => {
  for (const kind of ['agentError', 'displayOnlySystem', 'briefing']) {
    test(`a long ${kind} row the replay drops does not exhaust the candidate budget`, async () => {
      const threadId = `candidate-budget-${kind}`;
      const store = new MessageStore();
      let sequence = 0;
      const append = (content, extra = {}) =>
        store.append(
          canonicalTestMessageInput({
            threadId,
            userId: 'user1',
            catId: null,
            content,
            mentions: [],
            timestamp: Date.now() + sequence++,
            ...extra,
          }),
        );
      append('prior user: remember blueberry');
      append('prior assistant: blueberry remembered', { catId: 'dsh' });
      for (let i = 0; i < 205; i++) append(`foreign whisper ${i}`, { visibility: 'whisper', whisperTo: ['codex'] });
      const long = 'EXCLUDED_RECORD '.repeat(8000);
      if (kind === 'agentError') append(`[错误]${long}`, { catId: 'dsh' });
      if (kind === 'displayOnlySystem') append(long, { catId: 'system' });
      if (kind === 'briefing') append(long, { catId: 'dsh', origin: 'briefing' });
      const current = append('current question');

      const replay = await buildIncrementalRebuildReplay({
        messageStore: store,
        userId: 'user1',
        threadId,
        catId: 'dsh',
        thinkingMode: 'play',
        boundaryId: cursorFor(current),
        promptMessageIds: [current.id],
      });
      assertBoundedReplay(replay);
      assert.ok(replay.includes('blueberry remembered'), 'older replayable history is still reached');
      assert.ok(!replay.includes('EXCLUDED_RECORD'), 'the dropped row really stays out of the replay');
    });
  }

  /**
   * Real RedisMessageStore over an in-memory transport stub (no network, no
   * real Redis). Counts raw rows fetched and hydrated, so the scan cap is
   * checked in storage coordinates rather than in returned visible rows.
   */
  function countingRedisStore(rows) {
    const desc = [...rows].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const counters = { fetched: 0, hydrated: 0 };
    const hash = (key) => byId.get(key.split(':').at(-1)) ?? {};
    const pairs = (page) => {
      counters.fetched += page.length;
      return page.flatMap((row) => [row.id, row.timestamp]);
    };
    const redis = {
      options: {},
      hgetall: async (key) => hash(key),
      zrevrank: async (_key, id) => {
        const rank = desc.findIndex((row) => row.id === id);
        return rank < 0 ? null : rank;
      },
      zrevrange: async (_key, start, stop) => pairs(desc.slice(start, stop + 1)),
      zrevrangebyscore: async (_key, max, _min, ...args) => {
        const exclusive = String(max).startsWith('(');
        const value = Number(exclusive ? String(max).slice(1) : max);
        const eligible = desc.filter((row) =>
          exclusive ? Number(row.timestamp) < value : Number(row.timestamp) <= value,
        );
        const at = args.indexOf('LIMIT');
        return pairs(eligible.slice(Number(args[at + 1]), Number(args[at + 1]) + Number(args[at + 2])));
      },
      multi: () => {
        const keys = [];
        return {
          hgetall(key) {
            keys.push(key);
            return this;
          },
          async exec() {
            counters.hydrated += keys.length;
            return keys.map((key) => [null, hash(key)]);
          },
        };
      },
    };
    return { store: new RedisMessageStore(redis), counters };
  }

  function redisRow(threadId, id, score, extra = {}) {
    return {
      id,
      threadId,
      userId: 'user1',
      from: JSON.stringify({ kind: 'user', userId: 'user1' }),
      catId: '',
      content: id === 'prior' ? 'remember blueberry' : `row ${id}`,
      mentions: '[]',
      timestamp: String(score),
      timelineOrderAt: String(score),
      visibilitySeq: String(score),
      deliveryStatus: 'delivered',
      ...extra,
    };
  }

  async function redisReplay(threadId, fillerCount, filler) {
    const anchorScore = fillerCount + 2;
    const rows = [
      redisRow(threadId, 'anchor', anchorScore),
      ...Array.from({ length: fillerCount }, (_, i) => filler(`filler-${i}`, anchorScore - 1 - i)),
      redisRow(threadId, 'prior', 1),
    ];
    const { store, counters } = countingRedisStore(rows);
    const replay = await buildIncrementalRebuildReplay({
      messageStore: store,
      userId: 'user1',
      threadId,
      catId: 'dsh',
      thinkingMode: 'play',
      boundaryId: `v2:${String(anchorScore).padStart(16, '0')}:anchor`,
      promptMessageIds: ['anchor'],
    });
    return { replay, counters };
  }

  test('redis: raw rows scanned stay within the cap even when most rows are filtered inside the store', async () => {
    const control = await redisReplay('scan-cap-control', 0, () => undefined);
    assertBoundedReplay(control.replay);
    assert.ok(control.replay.includes('remember blueberry'));

    const threadId = 'scan-cap-canceled';
    const { replay, counters } = await redisReplay(threadId, 5000, (id, score) =>
      redisRow(threadId, id, score, { deliveryStatus: 'canceled' }),
    );
    assert.ok(counters.fetched <= INCREMENTAL_REBUILD_REPLAY_SCAN_LIMIT, `fetched ${counters.fetched} raw rows`);
    assert.ok(counters.hydrated <= INCREMENTAL_REBUILD_REPLAY_SCAN_LIMIT, `hydrated ${counters.hydrated} rows`);
    assert.equal(replay, undefined, 'history beyond the raw cap is not reached; the carrier fails closed honestly');
  });

  test('redis: a page filled by rows the replay rejects continues from the raw cursor to older history', async () => {
    const threadId = 'scan-continuation';
    const { replay, counters } = await redisReplay(threadId, 150, (id, score) =>
      redisRow(threadId, id, score, { visibility: 'whisper', whisperTo: JSON.stringify(['codex']) }),
    );
    assertBoundedReplay(replay);
    assert.ok(replay.includes('remember blueberry'), 'second page reached through the store continuation');
    assert.ok(!replay.includes('filler-'), 'foreign whispers stay out');
    assert.ok(counters.fetched <= INCREMENTAL_REBUILD_REPLAY_SCAN_LIMIT);
  });
});
