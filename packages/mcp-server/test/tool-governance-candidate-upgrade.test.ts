import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createBootstrapAttestation,
  digestGovernanceValue,
  validateBootstrapAttestation,
} from '../src/tool-governance-bootstrap.js';

const bootstrapFrom = '265f7b998f7b8cae81d26d88db58351cf02b030d';
const protectedTargetSha = 'b'.repeat(40);
const candidateSha = 'c'.repeat(40);

function fixture() {
  const attestation = createBootstrapAttestation(bootstrapFrom);
  const target = attestation.exportedTargets[0];
  const { exportedTargets: _targets, attestationSourceDigest: _digest, ...source } = attestation;
  const legacySource = { ...source, schemaVersion: 1 };
  const legacyAttestation = {
    ...legacySource,
    attestationSourceDigest: digestGovernanceValue(legacySource),
  };
  const proof = {
    kind: 'exported-candidate-upgrade' as const,
    protectedTargetSha,
    candidateSha,
    target,
    bootstrapIsTargetAncestor: true,
    protectedTargetIsCandidateAncestor: true,
    projectionIsCandidateAncestor: true,
    protectedTargetAttestation: legacyAttestation,
    witness: {
      bootstrapCommit: target.bootstrapCommit,
      parentShas: [target.bootstrapParent],
      provenance: {
        source_commit_sha: target.sourceSnapshot,
        target_head_sha: target.bootstrapParent,
        manifest_version: target.provenanceManifestVersion,
      },
      legacyAttestation,
      baselineProtectedBaseSha: bootstrapFrom,
      projectionCommit: target.projectionCommit,
      projectionParentShas: [target.projectionParent],
      projectionProvenance: {
        source_commit_sha: target.projectionSourceSnapshot,
        target_head_sha: target.projectionParent,
        manifest_version: target.provenanceManifestVersion,
      },
    },
  };
  return {
    attestation,
    context: {
      mode: 'check' as const,
      resolvedTargetSha: protectedTargetSha,
      resolvedCandidateSha: candidateSha,
      targetHasBaseline: true,
      currentHasBaseline: true,
      targetBaselineProtectedBaseSha: bootstrapFrom,
      targetProof: proof,
    },
  };
}

describe('F286 independently evolved fork candidate upgrade', () => {
  it('admits the exact frozen target and attested projection joining in one candidate', () => {
    const { attestation, context } = fixture();
    assert.deepEqual(validateBootstrapAttestation(attestation, context), attestation);
    assert.doesNotThrow(() => validateBootstrapAttestation(attestation, { ...context, mode: 'write' }));
  });

  it('binds both proof coordinates to the exact protected target and candidate', () => {
    const { attestation, context } = fixture();
    for (const targetProof of [
      { ...context.targetProof, protectedTargetSha: 'd'.repeat(40) },
      { ...context.targetProof, candidateSha: 'd'.repeat(40) },
    ]) {
      assert.throws(() => validateBootstrapAttestation(attestation, { ...context, targetProof }), /target|candidate/i);
    }
    assert.throws(
      () => validateBootstrapAttestation(attestation, { ...context, resolvedCandidateSha: undefined }),
      /candidate/i,
    );
    for (const invalidCandidateSha of ['HEAD', candidateSha.slice(0, 12)]) {
      assert.throws(
        () =>
          validateBootstrapAttestation(attestation, {
            ...context,
            resolvedCandidateSha: invalidCandidateSha,
            targetProof: { ...context.targetProof, candidateSha: invalidCandidateSha },
          }),
        /candidate|exact/i,
      );
    }
  });

  for (const field of [
    'bootstrapIsTargetAncestor',
    'protectedTargetIsCandidateAncestor',
    'projectionIsCandidateAncestor',
  ] as const) {
    it(`rejects a candidate whose ${field} proof fails`, () => {
      const { attestation, context } = fixture();
      assert.throws(
        () =>
          validateBootstrapAttestation(attestation, {
            ...context,
            targetProof: { ...context.targetProof, [field]: false },
          }),
        /ancestor|history|candidate/i,
      );
    });
  }

  it('requires the frozen target tree to preserve the exact source v1 attestation', () => {
    const { attestation, context } = fixture();
    const original = context.targetProof.protectedTargetAttestation;
    for (const protectedTargetAttestation of [
      undefined,
      attestation,
      { ...original, attestationSourceDigest: 'sha256:forged' },
      { ...original, owner: 'architecture-cell:other' },
      { ...original, bootstrapFrom: 'd'.repeat(40) },
      { ...original, unexpected: 'field' },
    ]) {
      assert.throws(
        () =>
          validateBootstrapAttestation(attestation, {
            ...context,
            targetProof: { ...context.targetProof, protectedTargetAttestation },
          }),
        /legacy|attestation|upgrade/i,
      );
    }
  });

  it('retains exact bootstrap and projection parents and source provenance checks', () => {
    const { attestation, context } = fixture();
    const original = context.targetProof.witness;
    for (const witness of [
      { ...original, bootstrapCommit: 'd'.repeat(40) },
      { ...original, parentShas: ['d'.repeat(40)] },
      { ...original, parentShas: [...original.parentShas, 'd'.repeat(40)] },
      { ...original, provenance: { ...original.provenance, source_commit_sha: 'd'.repeat(40) } },
      { ...original, provenance: { ...original.provenance, target_head_sha: 'd'.repeat(40) } },
      { ...original, provenance: { ...original.provenance, manifest_version: 4 } },
      { ...original, legacyAttestation: attestation },
      { ...original, baselineProtectedBaseSha: 'd'.repeat(40) },
      { ...original, projectionCommit: 'd'.repeat(40) },
      { ...original, projectionParentShas: ['d'.repeat(40)] },
      { ...original, projectionParentShas: [...original.projectionParentShas, 'd'.repeat(40)] },
      { ...original, projectionProvenance: { ...original.projectionProvenance, source_commit_sha: 'd'.repeat(40) } },
      { ...original, projectionProvenance: { ...original.projectionProvenance, target_head_sha: 'd'.repeat(40) } },
      { ...original, projectionProvenance: { ...original.projectionProvenance, manifest_version: 4 } },
    ]) {
      assert.throws(
        () =>
          validateBootstrapAttestation(attestation, {
            ...context,
            targetProof: { ...context.targetProof, witness },
          }),
        /bootstrap|projection|attestation|protected base|provenance/i,
      );
    }
  });

  it('rejects an unlisted mapping or an invalid current source attestation', () => {
    const { attestation, context } = fixture();
    assert.throws(
      () =>
        validateBootstrapAttestation(attestation, {
          ...context,
          targetProof: {
            ...context.targetProof,
            target: { ...context.targetProof.target, projectionCommit: 'd'.repeat(40) },
          },
        }),
      /covered|attestation|mapping/i,
    );
    assert.throws(
      () => validateBootstrapAttestation({ ...attestation, attestationSourceDigest: 'sha256:forged' }, context),
      /digest/i,
    );
  });

  it('cannot bootstrap again, delete the baseline, change its protected source, or override the target', () => {
    const { attestation, context } = fixture();
    assert.throws(() => validateBootstrapAttestation(attestation, { ...context, mode: 'attest' }), /already complete/i);
    for (const mode of ['check', 'write'] as const) {
      assert.throws(
        () => validateBootstrapAttestation(attestation, { ...context, mode, currentHasBaseline: false }),
        /baseline.*missing|deleted and recreated/i,
      );
    }
    assert.throws(
      () => validateBootstrapAttestation(attestation, { ...context, targetBaselineProtectedBaseSha: 'd'.repeat(40) }),
      /protected target baseline|bootstrapFrom/i,
    );
    assert.throws(
      () => validateBootstrapAttestation(attestation, { ...context, requestedTargetOverride: 'upstream/main' }),
      /overrides are forbidden/i,
    );
  });
});
