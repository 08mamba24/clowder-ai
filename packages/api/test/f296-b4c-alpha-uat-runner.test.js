import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import {
  assertAlphaSnapshot,
  assertContentFreeManifest,
  boundEnum,
  cursorDidNotRewind,
  metricsProveObservation,
  projectTraceEvidence,
  runAlphaUat,
  unsupportedJourney,
  validateAlphaCoordinates,
  validateCanonicalContract,
} from '../../../scripts/f296-alpha-uat.mjs';
import * as alphaJourneys from '../../../scripts/lib/f296-alpha-uat-journeys.mjs';
import { runCompactionJourney } from '../../../scripts/lib/f296-alpha-uat-journeys.mjs';
import {
  CONTEXT_PROJECTION_ENUMS,
  CONTEXT_PROJECTION_TELEMETRY_CONTRACT,
} from '../dist/domains/cats/services/session/context/context-projection-telemetry-contract.js';

const revision = 'a'.repeat(40);
const traceId = 'b'.repeat(32);
const spanId = 'c'.repeat(16);

function throwsReason(fn, reason) {
  assert.throws(fn, (error) => error?.reason === reason);
}

function canonicalSpan(overrides = {}) {
  const keys = CONTEXT_PROJECTION_TELEMETRY_CONTRACT.traceAttributes;
  return {
    traceId,
    spanId,
    attributes: {
      [keys.provider]: 'codex',
      [keys.carrier]: 'app_server',
      [keys.disposition]: 'fresh',
      [keys.reason]: 'no_prior_session',
      [keys.transition]: 'scope_first_seen',
      [keys.mode]: 'cold',
      [keys.deltaSize]: 'small',
      [keys.tierT0Count]: 1,
      [keys.tierT0Bytes]: 4,
      [keys.tierT1Count]: 0,
      [keys.tierT1Bytes]: 0,
      [keys.tierT2Count]: 0,
      [keys.tierT2Bytes]: 0,
      [keys.tierInvalidCount]: 0,
      [keys.tierInvalidBytes]: 0,
      [keys.tierUnrecognizedCount]: 0,
      [keys.tierUnrecognizedBytes]: 0,
      [keys.deliveryLatencyMs]: 12,
      [keys.ledgerOutcome]: 'committed',
      ...overrides,
    },
  };
}

// The resumed journeys assert hot/resumed projections; each journey's trace
// span must carry its own labels or the observation comparison downgrades a
// fully delivered invocation to a mismatch.
function journeySpan(kind) {
  const keys = CONTEXT_PROJECTION_TELEMETRY_CONTRACT.traceAttributes;
  if (kind === 'resumed-small' || kind === 'resumed-large') {
    return canonicalSpan({
      [keys.disposition]: 'resumed',
      [keys.reason]: 'resume_confirmed',
      [keys.transition]: 'resumed',
      [keys.mode]: 'hot',
      [keys.deltaSize]: kind === 'resumed-small' ? 'small' : 'large',
    });
  }
  return canonicalSpan();
}

function journey(observation, name = 'cold') {
  return {
    journey: name,
    outcome: observation ? 'passed' : 'unsupported',
    reason: observation ? 'observed' : 'telemetry_signal_missing',
    observation,
  };
}

describe('F296 B4c Alpha UAT runner red contracts', () => {
  test('imports and pins the compiled B4b canonical telemetry contract', () => {
    assert.doesNotThrow(() => validateCanonicalContract());
    const drifted = structuredClone(CONTEXT_PROJECTION_TELEMETRY_CONTRACT);
    drifted.traceAttributes.mode = 'drifted.attribute';
    throwsReason(() => validateCanonicalContract(drifted, CONTEXT_PROJECTION_ENUMS), 'contract_drift');
    const enumDrift = structuredClone(CONTEXT_PROJECTION_ENUMS);
    enumDrift.transitions.push('future-transition');
    throwsReason(() => validateCanonicalContract(CONTEXT_PROJECTION_TELEMETRY_CONTRACT, enumDrift), 'contract_drift');
  });

  test('has no fixture, store, synthetic trigger, or manual telemetry backdoor', async () => {
    const source = (
      await Promise.all([
        readFile(new URL('../../../scripts/f296-alpha-uat.mjs', import.meta.url), 'utf8'),
        readFile(new URL('../../../scripts/lib/f296-alpha-uat-contract.mjs', import.meta.url), 'utf8'),
        readFile(new URL('../../../scripts/lib/f296-alpha-uat-journeys.mjs', import.meta.url), 'utf8'),
      ])
    ).join('\n');
    for (const forbidden of [
      'ContextEpochOwner',
      'ContinuityDisposition',
      'compaction store',
      'presentation ledger',
      '__fixtures__',
      '/trigger',
      '/replace',
      'recordContextProjection',
    ])
      assert.equal(source.includes(forbidden), false, `runner contains forbidden seam: ${forbidden}`);
    assert.match(source, /\/compact-native/);
    assert.match(source, /\/bind/);
    assert.match(source, /getDeliveryCursor/);
    assert.match(source, /getSeenCursor/);
    assert.match(source, /redis\.ttl/);
    for (const mutation of ['redis.set(', 'redis.del(', 'redis.eval(']) {
      assert.equal(source.includes(mutation), false, `runner mutates Redis evidence surface: ${mutation}`);
    }
    for (const copied of [
      ...Object.values(CONTEXT_PROJECTION_TELEMETRY_CONTRACT.metricNames),
      ...Object.values(CONTEXT_PROJECTION_TELEMETRY_CONTRACT.traceAttributes),
    ])
      assert.equal(source.includes(`'${copied}'`), false, `runner copied canonical telemetry string: ${copied}`);
  });

  test('rejects live, random, malformed, and Redis sanctuary coordinates', () => {
    assert.doesNotThrow(() => validateAlphaCoordinates('http://127.0.0.1:3012', 'redis://127.0.0.1:6397'));
    for (const api of [
      'http://127.0.0.1:3003',
      'http://127.0.0.1:3004',
      'http://127.0.0.1:3999',
      'http://localhost:3012',
    ]) {
      throwsReason(() => validateAlphaCoordinates(api, 'redis://127.0.0.1:6397'), 'wrong_api_origin');
    }
    for (const redis of [
      'redis://127.0.0.1:6398',
      'redis://127.0.0.1:6399',
      'redis://127.0.0.1:7777',
      'redis://remote:6397',
    ]) {
      throwsReason(() => validateAlphaCoordinates('http://127.0.0.1:3012', redis), 'wrong_redis_endpoint');
    }
    for (const redis of ['rediss://127.0.0.1:6397', 'redis://user:secret@127.0.0.1:6397', 'redis://127.0.0.1:6397/1']) {
      throwsReason(() => validateAlphaCoordinates('http://127.0.0.1:3012', redis), 'wrong_redis_endpoint');
    }
  });

  test('fails closed on wrong deployment, degraded readiness, and a non-app-server canary', () => {
    const base = {
      expectedRevision: revision,
      health: { deploymentRevision: revision },
      readiness: { status: 'ready' },
      cats: { cats: [{ id: 'codex', clientId: 'openai', carrier: 'app_server' }] },
      catId: 'codex',
    };
    assert.doesNotThrow(() => assertAlphaSnapshot(base));
    throwsReason(
      () => assertAlphaSnapshot({ ...base, health: { deploymentRevision: 'd'.repeat(40) } }),
      'wrong_revision',
    );
    throwsReason(() => assertAlphaSnapshot({ ...base, readiness: { status: 'degraded' } }), 'alpha_not_ready');
    throwsReason(
      () =>
        assertAlphaSnapshot({
          ...base,
          cats: { cats: [{ id: 'codex', clientId: 'openai', carrier: 'cli' }] },
        }),
      'canary_not_app_server',
    );
  });

  test('polls the real trace read until the completed invocation span is exported', async (t) => {
    const originalFetch = globalThis.fetch;
    const sessionCookie = `cat_cafe_session=${'1'.repeat(64)}`;
    const traceReads = new Map();
    let invocationNumber = 0;
    const deliveredMessages = [];
    let metricsValue = 0;
    let dynamicCanaryRequests = 0;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    const metricLinesFor = (span, value) => {
      const projection = projectTraceEvidence(span);
      const contract = CONTEXT_PROJECTION_TELEMETRY_CONTRACT;
      const name = (entry) => entry.replaceAll('.', '_');
      const attrs = contract.metricAttributes;
      const labels = [
        `${name(attrs.disposition)}="${projection.internal.disposition}"`,
        `${name(attrs.reason)}="${projection.evidence.reason}"`,
        `${name(attrs.transition)}="${projection.evidence.transition}"`,
        `${name(attrs.mode)}="${projection.evidence.mode}"`,
        `${name(attrs.deltaSize)}="${projection.evidence.delta}"`,
      ].join(',');
      return [
        `${name(contract.metricNames.transitionTotal)}{${labels}} ${value}`,
        `${name(contract.metricNames.deliveryLatency)}_count ${value}`,
        `${name(contract.metricNames.ledgerOutcomeTotal)}{${name(attrs.ledgerOutcome)}="${projection.evidence.ledgerTerminal}"} ${value}`,
        ...projection.evidence.tiers.flatMap(({ tier }) => [
          `${name(contract.metricNames.tierCount)}_count{${name(attrs.tier)}="${tier}"} ${value}`,
          `${name(contract.metricNames.tierBytes)}_count{${name(attrs.tier)}="${tier}"} ${value}`,
        ]),
      ].join('\n');
    };
    // Every scrape advances every journey's label family, so whichever
    // projection a journey compares with, its own series has grown.
    const metricText = (value) =>
      ['fresh', 'resumed-small', 'resumed-large'].map((kind) => metricLinesFor(journeySpan(kind), value)).join('\n');
    globalThis.fetch = async (input, init) => {
      const url = new URL(input);
      if (url.pathname === '/api/session') {
        return Response.json(
          { userId: 'default-user' },
          { headers: { 'set-cookie': `${sessionCookie}; Path=/; HttpOnly` } },
        );
      }
      if (url.pathname === '/health') return Response.json({ deploymentRevision: revision });
      if (url.pathname === '/ready') return Response.json({ status: 'ready' });
      if (url.pathname === '/api/cats') {
        return Response.json({
          cats: [{ id: 'codex', clientId: 'openai', carrier: 'app_server' }],
        });
      }
      if (url.pathname === '/api/threads') return Response.json({ id: 'canary-thread' });
      if (url.pathname === '/api/threads/canary-thread/f296-alpha-dynamic-canary') {
        dynamicCanaryRequests += 1;
        invocationNumber += 1;
        return Response.json({
          status: 'processing',
          invocationId: `parent-${invocationNumber}`,
          producer: 'meeting_artifact',
          opportunityKind: 'memory_write_opportunity',
        });
      }
      if (url.pathname === '/api/messages') {
        // Unified delivery lifecycle (#1398): POST answers 202 queued with the
        // stored user message id. The response message carries the PARENT
        // invocation id in extra.stream.invocationId and the provider turn id
        // in lifecycle.invocationId (QueueProcessor writes both); the poll
        // matches on lifecycle.inputMessageIds and must return the parent,
        // which is what the downstream executions lookup is keyed on. An
        // unrelated response message must never be adopted.
        if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
          return Response.json({
            messages: [
              {
                id: 'response-unrelated',
                lifecycle: {
                  kind: 'response',
                  invocationId: 'child-unrelated',
                  inputMessageIds: ['user-unrelated'],
                  status: 'completed',
                },
                extra: { stream: { invocationId: 'parent-unrelated', turnInvocationId: 'child-unrelated' } },
              },
              ...deliveredMessages.map(({ userMessageId, parentInvocationId, childInvocationId }) => ({
                id: `response-${childInvocationId}`,
                lifecycle: {
                  kind: 'response',
                  invocationId: childInvocationId,
                  inputMessageIds: [userMessageId],
                  status: 'completed',
                },
                extra: { stream: { invocationId: parentInvocationId, turnInvocationId: childInvocationId } },
              })),
            ],
          });
        }
        invocationNumber += 1;
        const userMessageId = `user-${invocationNumber}`;
        deliveredMessages.push({
          userMessageId,
          parentInvocationId: `parent-${invocationNumber}`,
          childInvocationId: `child-${invocationNumber}`,
        });
        return Response.json({ status: 'queued', merged: false, userMessageId }, { status: 202 });
      }
      if (url.pathname.endsWith('/executions')) {
        // Executions are parent-keyed: a harness that wrongly recovers the
        // provider CHILD id must get a 404 here instead of a synthesized
        // match, so the regression cannot be masked by pattern derivation.
        const parentCandidate = url.pathname.split('/').at(-2);
        if (!parentCandidate.startsWith('parent-')) return new Response('', { status: 404 });
        const parentNumber = parentCandidate.split('-').at(-1);
        return Response.json({
          executionCount: 1,
          executions: [
            { invocationId: `child-${parentNumber}`, catId: 'codex', executionKind: 'ordinary', status: 'succeeded' },
          ],
        });
      }
      if (url.pathname.startsWith('/api/invocations/')) return Response.json({ status: 'succeeded' });
      if (url.pathname === '/api/telemetry/metrics') {
        metricsValue += 1;
        return new Response(metricText(metricsValue), { status: 200 });
      }
      if (url.pathname === '/api/telemetry/traces') {
        const invocationId = url.searchParams.get('invocationId');
        const count = (traceReads.get(invocationId) ?? 0) + 1;
        traceReads.set(invocationId, count);
        if (invocationId?.startsWith('parent-')) return Response.json({ spans: [], count: 0 });
        if (invocationId === 'child-1' && count === 1) return Response.json({ spans: [], count: 0 });
        // child-2/child-3 are the resumed journeys' provider turns; their
        // spans must carry the hot/resumed labels those journeys assert.
        const span =
          invocationId === 'child-2'
            ? journeySpan('resumed-small')
            : invocationId === 'child-3'
              ? journeySpan('resumed-large')
              : journeySpan('fresh');
        return Response.json({ spans: [span], count: 1 });
      }
      return Response.json({}, { status: 404 });
    };

    const manifest = await runAlphaUat({
      apiUrl: 'http://127.0.0.1:3012',
      redisUrl: 'redis://127.0.0.1:6397',
      catId: 'codex',
      userId: 'f296-alpha-uat',
      timeoutMs: 1000,
      pollMs: 100,
      expectedRevision: revision,
    });
    assert.equal(manifest.journeys[0].outcome, 'passed');
    assert.equal(manifest.dynamicPresentation.outcome, 'passed');
    assert.equal(manifest.dynamicPresentation.reason, 'observed');
    assert.equal(dynamicCanaryRequests, 1);
    assert.equal(traceReads.get('child-1'), 2);
    assert.equal(traceReads.has('parent-1'), false);
    // The resumed journeys exercise the unified /api/messages path end to
    // end: asserting they pass keeps a harness that recovers the provider
    // CHILD id (executions are parent-keyed) from silently downgrading them
    // to telemetry_signal_missing while journeys[0] stays green.
    assert.equal(manifest.journeys[1].journey, 'resumed-small');
    assert.equal(manifest.journeys[1].outcome, 'passed');
    assert.equal(manifest.journeys[2].journey, 'resumed-large');
    assert.equal(manifest.journeys[2].outcome, 'passed');
  });

  test('bounds unknown and future enum values to unrecognized', () => {
    assert.equal(boundEnum('future-transition', CONTEXT_PROJECTION_ENUMS.transitions), 'unrecognized');
    const keys = CONTEXT_PROJECTION_TELEMETRY_CONTRACT.traceAttributes;
    const projection = projectTraceEvidence(canonicalSpan({ [keys.transition]: 'future-transition' }));
    assert.equal(projection.evidence.transition, 'unrecognized');
  });

  test('accepts monotonic cursor progress and rejects rewind or disappearance', () => {
    const first = 'v2:0000000000000001:message-1';
    const second = 'v2:0000000000000002:message-2';
    assert.equal(cursorDidNotRewind(null, null), true);
    assert.equal(cursorDidNotRewind(first, first), true);
    assert.equal(cursorDidNotRewind(first, second), true);
    assert.equal(cursorDidNotRewind(second, first), false);
    assert.equal(cursorDidNotRewind(first, null), false);
  });

  test('selects a reusable same-owner active oversized trigger before binding an unclaimed candidate', () => {
    assert.equal(typeof alphaJourneys.selectReplacementTriggerCandidate, 'function');
    const selected = alphaJourneys.selectReplacementTriggerCandidate({
      candidateIds: ['sealed-trigger', 'unclaimed-trigger', 'active-trigger'],
      claims: new Map([
        ['sealed-trigger', { status: 'sealed', threadId: 'old-thread', catId: 'codex-sol', userId: 'alpha-owner' }],
        ['unclaimed-trigger', null],
        [
          'active-trigger',
          { status: 'active', threadId: 'reusable-thread', catId: 'codex-sol', userId: 'alpha-owner' },
        ],
      ]),
      catId: 'codex-sol',
      userId: 'alpha-owner',
    });
    assert.deepEqual(selected, {
      cliSessionId: 'active-trigger',
      mode: 'reuse',
      threadId: 'reusable-thread',
    });
  });

  test('selects only an unclaimed oversized trigger when no reusable active claim exists', () => {
    assert.equal(typeof alphaJourneys.selectReplacementTriggerCandidate, 'function');
    const selected = alphaJourneys.selectReplacementTriggerCandidate({
      candidateIds: ['foreign-trigger', 'sealed-trigger', 'unclaimed-trigger'],
      claims: new Map([
        [
          'foreign-trigger',
          { status: 'active', threadId: 'foreign-thread', catId: 'codex-sol', userId: 'other-owner' },
        ],
        ['sealed-trigger', { status: 'sealed', threadId: 'old-thread', catId: 'codex-sol', userId: 'alpha-owner' }],
        ['unclaimed-trigger', null],
      ]),
      catId: 'codex-sol',
      userId: 'alpha-owner',
    });
    assert.deepEqual(selected, {
      cliSessionId: 'unclaimed-trigger',
      mode: 'bind',
    });
  });

  test('refuses to steal sealed or foreign oversized trigger claims', () => {
    assert.equal(typeof alphaJourneys.selectReplacementTriggerCandidate, 'function');
    const selected = alphaJourneys.selectReplacementTriggerCandidate({
      candidateIds: ['foreign-trigger', 'sealed-trigger'],
      claims: new Map([
        [
          'foreign-trigger',
          { status: 'active', threadId: 'foreign-thread', catId: 'codex-sol', userId: 'other-owner' },
        ],
        ['sealed-trigger', { status: 'sealed', threadId: 'old-thread', catId: 'codex-sol', userId: 'alpha-owner' }],
      ]),
      catId: 'codex-sol',
      userId: 'alpha-owner',
    });
    assert.equal(selected, null);
  });

  test('missing real projection fields cannot become a passing observation', () => {
    assert.equal(projectTraceEvidence({ traceId, spanId, attributes: {} }), null);
    const keys = CONTEXT_PROJECTION_TELEMETRY_CONTRACT.traceAttributes;
    assert.equal(projectTraceEvidence(canonicalSpan({ [keys.deliveryLatencyMs]: undefined })), null);
    assert.deepEqual(unsupportedJourney('cold', 'telemetry_signal_missing'), {
      journey: 'cold',
      outcome: 'unsupported',
      reason: 'telemetry_signal_missing',
      observation: null,
    });
  });

  test('classifies native compaction availability separately from provider and cursor state failures', async () => {
    const options = { catId: 'codex' };
    const invoke = (status, code) =>
      runCompactionJourney({
        options,
        threadId: 'thread-1',
        request: async () => Response.json({ code }, { status }),
        observe: async () => assert.fail('failed or unsupported control must not run the observation journey'),
      });

    for (const status of [404, 409]) {
      assert.deepEqual(await invoke(status, 'NATIVE_COMPACTION_UNSUPPORTED'), {
        journey: 'authoritative-compaction',
        outcome: 'unsupported',
        reason: 'provider_compaction_trigger_unavailable',
        observation: null,
      });
    }
    assert.deepEqual(await invoke(502, 'NATIVE_COMPACTION_FAILED'), {
      journey: 'authoritative-compaction',
      outcome: 'failed',
      reason: 'compaction_state_mismatch',
      observation: null,
    });
    assert.deepEqual(await invoke(502, 'NATIVE_COMPACTION_CURSOR_CHANGED'), {
      journey: 'authoritative-compaction',
      outcome: 'failed',
      reason: 'compaction_cursor_changed',
      observation: null,
    });
  });

  test('parses each 409 control body once and classifies transient vs capability states', async () => {
    const options = { catId: 'codex', pollMs: 1 };
    const sequenceDriver = (factories) => {
      let index = 0;
      let calls = 0;
      return {
        request: async () => {
          calls += 1;
          const factory = factories[Math.min(index, factories.length - 1)];
          index += 1;
          return factory();
        },
        callCount: () => calls,
      };
    };

    // First-shot NATIVE_SESSION_UNAVAILABLE: the busy probe and the
    // classification must share ONE body read on the same response object —
    // re-reading a consumed body previously collapsed this into the generic
    // capability-unavailable reason.
    let driver = sequenceDriver([() => Response.json({ code: 'NATIVE_SESSION_UNAVAILABLE' }, { status: 409 })]);
    assert.deepEqual(
      await runCompactionJourney({
        options,
        threadId: 'thread-1',
        request: driver.request,
        observe: async () => assert.fail('unsupported control must not run the observation journey'),
      }),
      {
        journey: 'authoritative-compaction',
        outcome: 'unsupported',
        reason: 'native_session_unavailable',
        observation: null,
      },
    );
    assert.equal(driver.callCount(), 1);

    // BUSY once then a successful control response: one retry, then the
    // observation journey runs.
    driver = sequenceDriver([
      () => Response.json({ code: 'NATIVE_SESSION_BUSY' }, { status: 409 }),
      () =>
        Response.json({
          outcome: 'observed',
          transition: 'context_compacted',
          contextMode: 'cold',
          cursorState: 'preserved',
        }),
    ]);
    const observed = await runCompactionJourney({
      options,
      threadId: 'thread-1',
      request: driver.request,
      observe: async () => ({
        journey: 'authoritative-compaction',
        outcome: 'passed',
        reason: 'observed',
        observation: null,
      }),
    });
    assert.equal(observed.outcome, 'passed');
    assert.equal(driver.callCount(), 2);

    // BUSY then still BUSY: the transient state surfaces as native_session_busy.
    driver = sequenceDriver([
      () => Response.json({ code: 'NATIVE_SESSION_BUSY' }, { status: 409 }),
      () => Response.json({ code: 'NATIVE_SESSION_BUSY' }, { status: 409 }),
    ]);
    assert.deepEqual(
      await runCompactionJourney({
        options,
        threadId: 'thread-1',
        request: driver.request,
        observe: async () => assert.fail('unsupported control must not run the observation journey'),
      }),
      { journey: 'authoritative-compaction', outcome: 'unsupported', reason: 'native_session_busy', observation: null },
    );

    // BUSY then UNAVAILABLE: the retried response classifies on its own code.
    driver = sequenceDriver([
      () => Response.json({ code: 'NATIVE_SESSION_BUSY' }, { status: 409 }),
      () => Response.json({ code: 'NATIVE_SESSION_UNAVAILABLE' }, { status: 409 }),
    ]);
    assert.deepEqual(
      await runCompactionJourney({
        options,
        threadId: 'thread-1',
        request: driver.request,
        observe: async () => assert.fail('unsupported control must not run the observation journey'),
      }),
      {
        journey: 'authoritative-compaction',
        outcome: 'unsupported',
        reason: 'native_session_unavailable',
        observation: null,
      },
    );
  });

  test('requires positive deltas from every canonical B4b metric family', () => {
    const projection = projectTraceEvidence(canonicalSpan());
    const contract = CONTEXT_PROJECTION_TELEMETRY_CONTRACT;
    const name = (value) => value.replaceAll('.', '_');
    const attrs = contract.metricAttributes;
    const labels = [
      `${name(attrs.disposition)}="fresh"`,
      `${name(attrs.reason)}="no_prior_session"`,
      `${name(attrs.transition)}="scope_first_seen"`,
      `${name(attrs.mode)}="cold"`,
      `${name(attrs.deltaSize)}="small"`,
    ].join(',');
    const rows = [
      `${name(contract.metricNames.transitionTotal)}{${labels}} 1`,
      `${name(contract.metricNames.deliveryLatency)}_count 1`,
      `${name(contract.metricNames.ledgerOutcomeTotal)}{${name(attrs.ledgerOutcome)}="${projection.evidence.ledgerTerminal}"} 1`,
      ...projection.evidence.tiers.flatMap(({ tier }) => [
        `${name(contract.metricNames.tierCount)}_count{${name(attrs.tier)}="${tier}"} 1`,
        `${name(contract.metricNames.tierBytes)}_count{${name(attrs.tier)}="${tier}"} 1`,
      ]),
    ];
    assert.equal(metricsProveObservation('', rows.join('\n'), projection), true);
    assert.equal(metricsProveObservation('', rows.slice(1).join('\n'), projection), false);
  });

  test('rejects any prompt, content, user, thread, or subject field in the manifest', () => {
    const observation = projectTraceEvidence(canonicalSpan()).evidence;
    const manifest = {
      schemaVersion: 2,
      revision,
      dynamicPresentation: {
        outcome: 'unsupported',
        reason: 'canonical_dynamic_producer_unavailable',
        observation: null,
      },
      journeys: [
        journey(observation),
        journey(observation, 'resumed-small'),
        journey(observation, 'resumed-large'),
        journey(null, 'replacement'),
        { ...journey(null, 'authoritative-compaction'), reason: 'provider_compaction_trigger_unavailable' },
      ],
    };
    manifest.journeys[3].reason = 'provider_replacement_trigger_unavailable';
    assert.doesNotThrow(() => assertContentFreeManifest(manifest));
    for (const leakedKey of ['prompt', 'content', 'userId', 'threadId', 'subjectId', 'reasoning']) {
      const leaked = structuredClone(manifest);
      leaked.journeys[0].observation[leakedKey] = 'secret';
      throwsReason(() => assertContentFreeManifest(leaked), 'evidence_privacy_violation');
    }
    const dynamicLeak = structuredClone(manifest);
    dynamicLeak.dynamicPresentation = {
      outcome: 'passed',
      reason: 'observed',
      observation: { ...observation, content: 'secret' },
    };
    throwsReason(() => assertContentFreeManifest(dynamicLeak), 'evidence_privacy_violation');
    const unbounded = structuredClone(manifest);
    unbounded.journeys[0].observation.mode = 'future-mode';
    throwsReason(() => assertContentFreeManifest(unbounded), 'evidence_privacy_violation');
  });
});
