import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  type AtomicCutoverManifest,
  type CutoverConsumerScan,
  type CutoverSurfaceEntry,
  FIXED_CUTOVER_CONSUMER_ROOTS,
  REQUIRED_CUTOVER_LAYERS,
  validateAtomicCutovers,
} from '../src/tool-cutover.js';
import { digestGovernanceValue } from '../src/tool-governance-bootstrap.js';

const protectedTargetSha = 'b'.repeat(40);
const names = { first: 'fixture_old_one', second: 'fixture_old_two', historical: 'fixture_old_three' };
const retiredNames = Object.values(names);
const entry = (name: string): CutoverSurfaceEntry => ({ name, resourceFamily: 'subject', runtimeProfiles: ['full'] });
const before = [entry(names.first), entry(names.second)];
const after = [entry('fixture_new_one'), entry('fixture_new_two')];
const scans: CutoverConsumerScan[] = retiredNames.map((retiredName) => ({
  retiredName,
  scannedRoots: FIXED_CUTOVER_CONSUMER_ROOTS,
  matches: [],
  negativeReferences: [],
  resolvedConsumers: [],
}));

function fixture() {
  const historical: AtomicCutoverManifest = {
    resource: { kind: 'family', resourceFamily: 'subject' },
    retiredNames,
    canonicalNames: [],
    expectedProfiles: {},
    rollbackRevision: 'a'.repeat(40),
    layers: Object.fromEntries(
      REQUIRED_CUTOVER_LAYERS.map((layer) => [
        layer,
        { status: 'not-applicable', rationale: 'isolated fixture has no consumers', absenceEvidence: retiredNames },
      ]),
    ) as AtomicCutoverManifest['layers'],
  };
  const aggregate: AtomicCutoverManifest = {
    ...historical,
    retiredNames: before.map((item) => item.name),
    canonicalNames: after.map((item) => item.name),
    expectedProfiles: Object.fromEntries(after.map((item) => [item.name, item.runtimeProfiles])),
    rollbackRevision: protectedTargetSha,
    composition: { protectedTargetSha, historicalManifestDigests: [digestGovernanceValue(historical)] },
  };
  return { before, after, scans, protectedTargetSha, manifests: [historical, aggregate], historical, aggregate };
}

describe('F286 exact-target aggregate cutover composition', () => {
  it('accepts a complete aggregate while retaining the unchanged three-name historical sunset', () => {
    const input = fixture();
    const unchangedHistorical = JSON.stringify(input.historical);
    const result = validateAtomicCutovers(input);
    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(input.historical), unchangedHistorical);
  });

  it('preserves the strict default when no aggregate composition is authorized', () => {
    const input = fixture();
    const { composition: _composition, ...ordinaryAggregate } = input.aggregate;
    for (const manifests of [[input.historical], [input.historical, ordinaryAggregate]]) {
      const result = validateAtomicCutovers({ ...input, manifests });
      assert.ok(
        result.findings.some((finding) => finding.code === 'cutover-set-mismatch' && finding.manifestIndex === 0),
      );
    }
  });

  it('fails closed on missing protected-target context or active target drift', () => {
    const input = fixture();
    for (const actualTarget of [undefined, 'c'.repeat(40)]) {
      const result = validateAtomicCutovers({ ...input, protectedTargetSha: actualTarget });
      assert.equal(result.ok, false);
      assert.ok(result.findings.some((finding) => finding.code === 'invalid-cutover-composition'));
      assert.ok(
        result.findings.some((finding) => finding.code === 'cutover-set-mismatch' && finding.manifestIndex === 0),
      );
    }
  });

  it('fails closed when a pinned historical manifest is changed, absent, or ambiguous', () => {
    const input = fixture();
    for (const manifests of [
      [{ ...input.historical, rollbackRevision: 'd'.repeat(40) }, input.aggregate],
      [input.aggregate],
      [input.historical, input.historical, input.aggregate],
    ]) {
      const result = validateAtomicCutovers({ ...input, manifests });
      assert.ok(result.findings.some((finding) => finding.code === 'invalid-cutover-composition'));
    }
  });

  it('cannot compose a different resource family even with its exact digest', () => {
    const input = fixture();
    const otherHistorical = { ...input.historical, resource: { kind: 'family' as const, resourceFamily: 'other' } };
    const aggregate = {
      ...input.aggregate,
      composition: { protectedTargetSha, historicalManifestDigests: [digestGovernanceValue(otherHistorical)] },
    };
    const result = validateAtomicCutovers({ ...input, manifests: [otherHistorical, aggregate] });
    assert.ok(result.findings.some((finding) => finding.code === 'invalid-cutover-composition'));
    assert.ok(result.findings.some((finding) => finding.code === 'cross-family-cutover'));
  });

  it('still requires the aggregate itself to exactly cover every current retirement, addition, and profile', () => {
    const input = fixture();
    for (const aggregate of [
      { ...input.aggregate, retiredNames: [names.first] },
      { ...input.aggregate, canonicalNames: [] },
      { ...input.aggregate, expectedProfiles: {} },
    ]) {
      const result = validateAtomicCutovers({ ...input, manifests: [input.historical, aggregate] });
      assert.ok(
        result.findings.some((finding) => finding.code === 'cutover-set-mismatch' && finding.manifestIndex === 1),
      );
    }
  });

  it('keeps the already-absent third historical name under complete consumer scanning', () => {
    const input = fixture();
    const resurrected: CutoverConsumerScan = {
      ...scans[2],
      retiredName: names.historical,
      scannedRoots: FIXED_CUTOVER_CONSUMER_ROOTS,
      matches: [{ root: 'packages/api/src', path: 'packages/api/src/resurrected.ts', line: 1 }],
      negativeReferences: [],
      resolvedConsumers: [],
    };
    const result = validateAtomicCutovers({ ...input, scans: [scans[0], scans[1], resurrected] });
    assert.ok(
      result.findings.some(
        (finding) => finding.code === 'stale-retired-reference' && finding.name === names.historical,
      ),
    );
    const missingScan = validateAtomicCutovers({ ...input, scans: scans.slice(0, 2) });
    assert.ok(
      missingScan.findings.some(
        (finding) => finding.code === 'consumer-root-coverage-mismatch' && finding.name === names.historical,
      ),
    );
  });

  it('retains historical layer integrity and current profile expectations', () => {
    const input = fixture();
    const layers = { ...input.historical.layers };
    delete layers.observability;
    const historical = { ...input.historical, layers };
    const aggregate = {
      ...input.aggregate,
      composition: { protectedTargetSha, historicalManifestDigests: [digestGovernanceValue(historical)] },
      expectedProfiles: Object.fromEntries(after.map((item) => [item.name, ['readonly'] as const])),
    };
    const result = validateAtomicCutovers({ ...input, manifests: [historical, aggregate] });
    assert.ok(
      result.findings.some((finding) => finding.code === 'missing-cutover-layer' && finding.manifestIndex === 0),
    );
    assert.ok(result.findings.some((finding) => finding.code === 'profile-expectation-mismatch'));
  });

  it('keeps landed composition dormant after the protected target advances with no family delta', () => {
    const input = fixture();
    const result = validateAtomicCutovers({ ...input, before: after, protectedTargetSha: 'e'.repeat(40) });
    assert.deepEqual(result.findings, []);
    const staleConsumer = {
      ...scans[2],
      matches: [{ root: 'packages/api/src', path: 'packages/api/src/resurrected.ts', line: 3 }],
    } as CutoverConsumerScan;
    const guarded = validateAtomicCutovers({
      ...input,
      before: after,
      protectedTargetSha: 'e'.repeat(40),
      scans: [scans[0], scans[1], staleConsumer],
    });
    assert.ok(guarded.findings.some((finding) => finding.code === 'stale-retired-reference'));
    const futureDelta = validateAtomicCutovers({
      ...input,
      before: after,
      after: [...after, entry('fixture_future_addition')],
      protectedTargetSha: 'e'.repeat(40),
    });
    assert.ok(futureDelta.findings.some((finding) => finding.code === 'invalid-cutover-composition'));
  });

  it('binds rollback to the exact composition target even after the aggregate lands', () => {
    const input = fixture();
    const aggregate = { ...input.aggregate, rollbackRevision: 'd'.repeat(40) };
    for (const baseline of [before, after]) {
      const result = validateAtomicCutovers({ ...input, before: baseline, manifests: [input.historical, aggregate] });
      assert.ok(result.findings.some((finding) => finding.code === 'invalid-cutover-composition'));
    }
  });

  it('rejects malformed, forged, duplicate, or open-ended composition metadata', () => {
    const input = fixture();
    for (const composition of [
      null,
      { protectedTargetSha: 'HEAD', historicalManifestDigests: [digestGovernanceValue(input.historical)] },
      { protectedTargetSha, historicalManifestDigests: [] },
      { protectedTargetSha, historicalManifestDigests: ['sha256:forged'] },
      { protectedTargetSha, historicalManifestDigests: [digestGovernanceValue(input.historical)], extra: true },
      {
        protectedTargetSha,
        historicalManifestDigests: [digestGovernanceValue(input.historical), digestGovernanceValue(input.historical)],
      },
    ]) {
      const aggregate = { ...input.aggregate, composition } as AtomicCutoverManifest;
      const result = validateAtomicCutovers({ ...input, manifests: [input.historical, aggregate] });
      assert.ok(result.findings.some((finding) => finding.code === 'invalid-cutover-composition'));
    }
  });
});
