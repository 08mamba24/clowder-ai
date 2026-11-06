import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  createBootstrapAttestation,
  digestGovernanceValue,
  MCP_SURFACE_ATTESTATION_PATH,
  MCP_SURFACE_BASELINE_PATH,
  type McpSurfaceBootstrapAttestation,
  validateExportedBootstrapWitness,
} from '../src/tool-governance-bootstrap.js';
import { type GovernanceGitRead, resolveBootstrapTargetProof } from '../src/tool-governance-bootstrap-git.js';

const run = promisify(execFile);
const bootstrapFrom = '265f7b998f7b8cae81d26d88db58351cf02b030d';

async function withHistory(
  action: (fixture: Awaited<ReturnType<typeof createHistory>>) => Promise<void>,
): Promise<void> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'f286-candidate-git-'));
  try {
    await action(await createHistory(repoRoot));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function createHistory(repoRoot: string) {
  const git = async (...args: string[]) =>
    (
      await run(
        'git',
        ['-c', 'user.name=F286 Test', '-c', 'user.email=f286@example.invalid', '-c', 'commit.gpgsign=false', ...args],
        { cwd: repoRoot },
      )
    ).stdout.trim();
  const writeJson = async (path: string, value: unknown) => {
    await mkdir(dirname(join(repoRoot, path)), { recursive: true });
    await writeFile(join(repoRoot, path), JSON.stringify(value));
  };
  const commit = async (subject: string) => {
    await git('add', '.');
    await git('commit', '-m', subject);
    return git('rev-parse', 'HEAD');
  };

  await git('init', '--initial-branch=main');
  await writeFile(join(repoRoot, 'README'), 'isolated F286 Git proof fixture\n');
  const bootstrapParent = await commit('public parent');
  const canonical = createBootstrapAttestation(bootstrapFrom);
  const { exportedTargets: _targets, attestationSourceDigest: _digest, ...source } = canonical;
  const legacySource = { ...source, schemaVersion: 1 };
  const legacyAttestation = { ...legacySource, attestationSourceDigest: digestGovernanceValue(legacySource) };
  const sourceSnapshot = '1'.repeat(40);
  const projectionSourceSnapshot = '2'.repeat(40);
  await writeJson(MCP_SURFACE_ATTESTATION_PATH, legacyAttestation);
  await writeJson(MCP_SURFACE_BASELINE_PATH, { protectedBaseSha: bootstrapFrom, tools: [] });
  await writeJson('.sync-provenance.json', {
    source_commit_sha: sourceSnapshot,
    target_head_sha: bootstrapParent,
    manifest_version: 3,
  });
  const bootstrapCommit = await commit('source-attested bootstrap introduction');

  await git('switch', '-c', 'fork');
  const forkBaseline = { protectedBaseSha: bootstrapFrom, tools: [{ name: 'fork_only_tool' }] };
  await writeJson(MCP_SURFACE_BASELINE_PATH, forkBaseline);
  const protectedTargetSha = await commit('independently evolve fork baseline');

  await git('switch', 'main');
  await writeFile(join(repoRoot, 'upstream'), 'projection parent\n');
  const projectionParent = await commit('projection parent');
  await writeJson('.sync-provenance.json', {
    source_commit_sha: projectionSourceSnapshot,
    target_head_sha: projectionParent,
    manifest_version: 3,
  });
  const projectionCommit = await commit('source-attested public projection');

  await git('switch', 'fork');
  await git('merge', '--no-ff', '-m', 'integrate public projection without replacing fork baseline', projectionCommit);
  // A repair after the merge remains a valid candidate, even though its immediate parent is not the target.
  await writeJson(MCP_SURFACE_ATTESTATION_PATH, canonical);
  await writeFile(join(repoRoot, 'repair'), 'candidate repair\n');
  const candidateSha = await commit('repair after integration');
  const target = {
    ...canonical.exportedTargets[0],
    bootstrapParent,
    bootstrapCommit,
    sourceSnapshot,
    projectionParent,
    projectionCommit,
    projectionSourceSnapshot,
  };
  // Synthetic anchors exercise real Git graph/read semantics only. Production CLI still parses the canonical attestation.
  const attestation = { ...canonical, exportedTargets: [target] } as unknown as McpSurfaceBootstrapAttestation;
  const readGit: GovernanceGitRead = async (args, allowFailure) => {
    try {
      return await git(...args);
    } catch (error) {
      if (allowFailure) return null;
      throw error;
    }
  };
  return {
    git,
    writeJson,
    commit,
    readGit,
    attestation,
    target,
    protectedTargetSha,
    projectionCommit,
    candidateSha,
    legacyAttestation,
    forkBaseline,
  };
}

describe('F286 candidate upgrade with an isolated real Git DAG', () => {
  it('reads the frozen target v1 attestation and proves both candidate ancestors after a repair commit', async () => {
    await withHistory(async (fixture) => {
      const proof = await resolveBootstrapTargetProof({
        ...fixture,
        resolvedTargetSha: fixture.protectedTargetSha,
        resolvedCandidateSha: fixture.candidateSha,
      });
      assert.equal(proof.kind, 'exported-candidate-upgrade');
      if (proof.kind !== 'exported-candidate-upgrade') throw new Error('Expected a candidate upgrade proof');
      assert.equal(proof.protectedTargetSha, fixture.protectedTargetSha);
      assert.equal(proof.candidateSha, fixture.candidateSha);
      assert.equal(proof.bootstrapIsTargetAncestor, true);
      assert.equal(proof.protectedTargetIsCandidateAncestor, true);
      assert.equal(proof.projectionIsCandidateAncestor, true);
      assert.deepEqual(proof.protectedTargetAttestation, fixture.legacyAttestation);
      assert.doesNotThrow(() =>
        validateExportedBootstrapWitness(fixture.attestation, fixture.attestation.exportedTargets[0], proof.witness),
      );
      const frozenBaseline = await fixture.readGit([
        'show',
        `${proof.protectedTargetSha}:${MCP_SURFACE_BASELINE_PATH}`,
      ]);
      assert.ok(frozenBaseline, 'The protected baseline must remain in the frozen target tree');
      assert.deepEqual(JSON.parse(frozenBaseline), fixture.forkBaseline);
    });
  });

  it('does not let candidate history stand in for either missing ancestor', async () => {
    await withHistory(async (fixture) => {
      for (const [resolvedCandidateSha, field] of [
        [fixture.protectedTargetSha, 'projectionIsCandidateAncestor'],
        [fixture.projectionCommit, 'protectedTargetIsCandidateAncestor'],
      ] as const) {
        const proof = await resolveBootstrapTargetProof({
          ...fixture,
          resolvedTargetSha: fixture.protectedTargetSha,
          resolvedCandidateSha,
        });
        assert.equal(proof.kind, 'exported-candidate-upgrade');
        if (proof.kind !== 'exported-candidate-upgrade') throw new Error('Expected a candidate upgrade proof');
        assert.equal(proof[field], false);
      }
    });
  });

  it('detects a protected target advanced beyond the frozen candidate', async () => {
    await withHistory(async (fixture) => {
      await fixture.git('switch', '--detach', fixture.protectedTargetSha);
      await writeFile(join(await fixture.git('rev-parse', '--show-toplevel'), 'target-drift'), 'new fork change\n');
      const advancedTargetSha = await fixture.commit('advance protected target');
      const proof = await resolveBootstrapTargetProof({
        ...fixture,
        resolvedTargetSha: advancedTargetSha,
        resolvedCandidateSha: fixture.candidateSha,
      });
      assert.equal(proof.kind, 'exported-candidate-upgrade');
      if (proof.kind !== 'exported-candidate-upgrade') throw new Error('Expected a candidate upgrade proof');
      assert.equal(proof.protectedTargetIsCandidateAncestor, false);
    });
  });

  it('keeps the ordinary established-target path once the projection is merged', async () => {
    await withHistory(async (fixture) => {
      const proof = await resolveBootstrapTargetProof({
        ...fixture,
        resolvedTargetSha: fixture.candidateSha,
        resolvedCandidateSha: fixture.candidateSha,
      });
      assert.equal(proof.kind, 'exported');
      if (proof.kind !== 'exported') throw new Error('Expected an established exported target');
      assert.equal(proof.projectionIsTargetAncestor, true);
    });
  });

  it('requires an exact candidate commit and preserves the old failure when none is supplied', async () => {
    await withHistory(async (fixture) => {
      const proof = await resolveBootstrapTargetProof({ ...fixture, resolvedTargetSha: fixture.protectedTargetSha });
      assert.equal(proof.kind, 'exported');
      if (proof.kind !== 'exported') throw new Error('Expected an exported target without upgrade admission');
      assert.equal(proof.projectionIsTargetAncestor, false);
      for (const resolvedCandidateSha of ['HEAD', fixture.candidateSha.slice(0, 12), 'f'.repeat(39)]) {
        const invalidCandidateProof = await resolveBootstrapTargetProof({
          ...fixture,
          resolvedTargetSha: fixture.protectedTargetSha,
          resolvedCandidateSha,
        });
        assert.equal(invalidCandidateProof.kind, 'exported');
        if (invalidCandidateProof.kind !== 'exported')
          throw new Error('Invalid candidate cannot grant upgrade admission');
        assert.equal(invalidCandidateProof.projectionIsTargetAncestor, false);
      }
    });
  });
});
