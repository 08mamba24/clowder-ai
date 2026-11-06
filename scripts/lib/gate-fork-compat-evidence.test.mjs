/**
 * Fork compatibility is a merge contract, not an inferred side effect.
 *
 * An upstream merge can be accepted through the targeted route. That route
 * does not run tests; the author owes the evidence. These tests pin the two
 * directions that previously allowed the contract suite to be skipped:
 *   - targeted (or its legacy acceptance inputs) never reports merge-ready
 *     without exact-candidate fork evidence;
 *   - a same-HEAD full-green reuse already ran the fork suites, so it does not
 *     owe the check again.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyGateRoute } from '../classify-gate-route.mjs';

const QODER_PROVIDER = 'packages/api/src/domains/cats/services/agents/providers/QoderAgentService.ts';

const targetedInput = {
  riskLane: 'targeted',
  riskAxis: 'behavior',
  typecheckStatus: 'green',
  targetedStatus: 'green',
  previousStatus: 'none',
  previousFailureRelevance: 'none',
  authoredPatch: 'changed',
  prPaths: [QODER_PROVIDER],
  basePaths: [],
};

test('targeted acceptance refuses merge-ready while fork evidence is undeclared', () => {
  const result = classifyGateRoute(targetedInput);
  assert.equal(result.route, 'targeted');
  assert.equal(result.mergeReady, false);
  assert.deepEqual(result.requiredChecks, ['fork-compatibility']);
  assert.match(result.reasons.join('\n'), /fork compatibility/i);
});

test('failed or not-run fork evidence remains owed instead of widening acceptance', () => {
  for (const forkCompatibilityStatus of ['failed', 'not_run']) {
    const result = classifyGateRoute({ ...targetedInput, forkCompatibilityStatus });
    assert.equal(result.route, 'targeted');
    assert.equal(result.mergeReady, false, `${forkCompatibilityStatus} must not release the targeted route`);
    assert.deepEqual(result.requiredChecks, ['fork-compatibility']);
  }
});

test('exact-candidate fork green releases only the fork check', () => {
  const result = classifyGateRoute({ ...targetedInput, forkCompatibilityStatus: 'green' });
  assert.equal(result.route, 'targeted');
  assert.equal(result.mergeReady, true);
  assert.deepEqual(result.requiredChecks, []);
});

test('the derived targeted route also lists the fork check next to risk-matched evidence', () => {
  const result = classifyGateRoute({
    riskAxis: 'behavior',
    previousStatus: 'none',
    previousFailureRelevance: 'none',
    authoredPatch: 'changed',
    prPaths: [QODER_PROVIDER],
    basePaths: [],
  });
  assert.equal(result.route, 'targeted');
  assert.equal(result.mergeReady, false);
  assert.ok(result.requiredChecks.includes('risk-matched-targeted-evidence'));
  assert.ok(result.requiredChecks.includes('fork-compatibility'));
});

test('same-HEAD full-green reuse does not owe fork evidence again', () => {
  const result = classifyGateRoute({ ...targetedInput, exactGreen: true });
  assert.equal(result.route, 'reuse');
  assert.equal(result.mergeReady, true);
  assert.deepEqual(result.requiredChecks, []);
});

test('an unknown fork evidence status fails closed instead of being ignored', () => {
  const result = classifyGateRoute({ ...targetedInput, forkCompatibilityStatus: 'maybe' });
  assert.equal(result.route, 'full');
  assert.deepEqual(result.requiredChecks, ['canonical-full-gate']);
  assert.match(result.reasons.join('\n'), /forkCompatibilityStatus/);
});

test('docs-only changes keep their documentation lane without inventing a code run', () => {
  const result = classifyGateRoute({
    riskLane: 'targeted',
    riskAxis: 'behavior',
    typecheckStatus: 'green',
    targetedStatus: 'green',
    previousStatus: 'none',
    previousFailureRelevance: 'none',
    authoredPatch: 'changed',
    prPaths: ['docs/ops/gate-continuity-claims.md'],
    basePaths: [],
  });
  assert.equal(result.route, 'targeted');
  assert.deepEqual(result.requiredChecks, ['docs-validation']);
});
