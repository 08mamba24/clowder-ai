/**
 * Route-level integration for the ACP session-rebuild replay (review P1-b).
 *
 * Exercises the real routeSerial/routeParallel → buildRebuildContextReplay →
 * invocation param wiring against a capturing AgentService mock: the replay the
 * carrier would inject is assembled from the actual thread history the route
 * received — not a hand-built prefix. Negative cases pin the eligibility
 * boundary: non-ACP carriers never receive a replay, and an empty history
 * yields no replay (the carrier then fails closed, covered in
 * native-acp-rebuild.test.js).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runRoute } from './helpers/cold-rebuild-bootstrap-degradation-fixture.js';

const REPLAY_HEADER = /^\/rebuild-replay v1 messages=(\d+) tokens=(\d+) truncated=(true|false)\n/;

function capturingService(catId) {
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
      yield { catId, type: 'text', content: `${catId} reply`, timestamp: Date.now() };
      yield { catId, type: 'done', timestamp: Date.now() };
    },
  };
}

function historyMessage(fields) {
  return {
    id: fields.id,
    userId: fields.userId ?? 'user1',
    catId: fields.catId ?? null,
    content: fields.content,
    mentions: [],
    timestamp: fields.timestamp,
    threadId: 'thread-acp-rebuild-route',
  };
}

describe('ACP rebuild replay route wiring (serial)', () => {
  test('resume turn of an ACP cat receives a self-described replay of the real thread history', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const dsh = capturingService('dsh');
    const history = [
      historyMessage({ id: 'm1', content: '第一轮的问题', timestamp: 1000 }),
      historyMessage({ id: 'm2', catId: 'dsh', content: '第一轮的回答', timestamp: 2000 }),
    ];
    await runRoute(routeSerial, { dsh }, 'thread-acp-rebuild-route', {
      targetCats: ['dsh'],
      routeOptions: { history },
    });
    assert.equal(dsh.invocations.length, 1);
    const replay = dsh.invocations[0].options?.rebuildContextPrompt;
    assert.ok(replay, 'ACP cat on a resume turn must receive the replay');
    assert.match(replay, REPLAY_HEADER, 'replay carries the self-describing header');
    assert.ok(replay.includes('第一轮的问题'), 'replay includes the persisted user turn');
    assert.ok(replay.includes('第一轮的回答'), 'replay includes the persisted assistant turn');
    assert.ok(dsh.invocations[0].prompt.includes('cold rebuild probe'), 'current turn prompt is preserved');
  });

  test('non-ACP carrier on the same turn receives no replay at all', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const dsh = capturingService('dsh');
    const codex = capturingService('codex');
    const history = [historyMessage({ id: 'm1', content: 'shared thread turn', timestamp: 1000 })];
    await runRoute(routeSerial, { dsh, codex }, 'thread-acp-rebuild-route', {
      targetCats: ['dsh', 'codex'],
      routeOptions: { history },
    });
    assert.ok(dsh.invocations[0].options?.rebuildContextPrompt, 'ACP carrier keeps the replay');
    assert.equal(
      codex.invocations.every((invocation) => invocation.options?.rebuildContextPrompt === undefined),
      true,
      'non-ACP carriers must not receive a replay',
    );
  });

  test('empty history yields no replay (carrier fails closed downstream)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const dsh = capturingService('dsh');
    await runRoute(routeSerial, { dsh }, 'thread-acp-rebuild-route', {
      targetCats: ['dsh'],
      routeOptions: { history: [] },
    });
    assert.equal(dsh.invocations[0].options?.rebuildContextPrompt, undefined);
  });

  test('a legal long reply still yields a bounded partial replay through the real route', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const dsh = capturingService('dsh');
    const history = [
      historyMessage({ id: 'm1', content: '长回答之前的提问', timestamp: 1000 }),
      historyMessage({ id: 'm2', catId: 'dsh', content: '答'.repeat(2000), timestamp: 2000 }),
    ];
    await runRoute(routeSerial, { dsh }, 'thread-acp-rebuild-route', {
      targetCats: ['dsh'],
      routeOptions: { history },
    });
    const replay = dsh.invocations[0].options?.rebuildContextPrompt;
    assert.ok(replay, 'long reply must not leave the replay empty');
    assert.match(replay, /^\/rebuild-replay v1 messages=\d+ tokens=\d+ truncated=true\n/);
    assert.ok(replay.includes('答'), 'truncated newest reply is carried');
  });
});

describe('ACP rebuild replay route wiring (parallel)', () => {
  test('every ACP cat in a parallel fan-out receives the replay built from the same thread history', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const dsh = capturingService('dsh');
    const grok = capturingService('grok-build');
    const history = [
      historyMessage({ id: 'm1', content: '并行轮之前的问题', timestamp: 1000 }),
      historyMessage({ id: 'm2', catId: 'dsh', content: '并行轮之前的回答', timestamp: 2000 }),
    ];
    await runRoute(routeParallel, { dsh, 'grok-build': grok }, 'thread-acp-rebuild-route', {
      targetCats: ['dsh', 'grok-build'],
      routeOptions: { history },
    });
    for (const service of [dsh, grok]) {
      assert.ok(service.invocations.length >= 1, 'each ACP cat was invoked');
      const replay = service.invocations[0].options?.rebuildContextPrompt;
      assert.ok(replay, 'each ACP cat receives the replay');
      assert.match(replay, REPLAY_HEADER);
      assert.ok(replay.includes('并行轮之前的问题'));
    }
  });

  test('two consecutive turns grow the replay: turn 2 sees turn 1 content from the persisted history', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const dsh = capturingService('dsh');
    // Turn 1 history: only an older exchange.
    const history = [
      historyMessage({ id: 'm1', content: '更早的问题', timestamp: 1000 }),
      historyMessage({ id: 'm2', catId: 'dsh', content: '更早的回答', timestamp: 2000 }),
    ];
    await runRoute(routeSerial, { dsh }, 'thread-acp-rebuild-route', {
      targetCats: ['dsh'],
      routeOptions: { history },
    });
    // Persist turn 1's user prompt and assistant reply into the same thread
    // history (what messageStore does for the next turn's read).
    history.push(historyMessage({ id: 'm3', content: 'cold rebuild probe', timestamp: 3000 }));
    history.push(historyMessage({ id: 'm4', catId: 'dsh', content: 'dsh reply', timestamp: 4000 }));
    const second = capturingService('dsh');
    await runRoute(routeSerial, { dsh: second }, 'thread-acp-rebuild-route', {
      targetCats: ['dsh'],
      routeOptions: { history },
    });
    const replay = second.invocations[0].options?.rebuildContextPrompt;
    assert.ok(replay);
    assert.ok(replay.includes('cold rebuild probe'), 'turn 2 replay includes turn 1 user prompt');
    assert.ok(replay.includes('dsh reply'), 'turn 2 replay includes turn 1 assistant reply');
    assert.ok(replay.includes('更早的问题'), 'older history is still carried');
  });
});
