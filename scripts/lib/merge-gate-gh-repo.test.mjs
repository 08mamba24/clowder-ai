#!/usr/bin/env node

// Merge-gate gh calls must pin --repo to the clone's origin repository.
//
// Incident class this locks out: a clone tracking BOTH zts212653/clowder-ai
// (upstream) and 08mamba24/clowder-ai (origin) resolves every bare
// `gh pr ...` against `upstream` (gh prefers that remote name). Merge-gate
// evidence then reads PR truth from the wrong repository — and
// `gh pr edit --add-label hotfix` WRITES to it. classify-merge-outcome.mjs
// and check-hotfix-pattern.mjs both carried unpinned calls; these tests pin
// them to the repository parsed from the `origin` remote.
//
// Strategy: a temp git repo whose `origin` points at example-owner/example-repo
// plus a PATH-stubbed `gh` that records argv — no credentials, no network.

import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseGitHubRepository, resolveMergeGateRepository } from './merge-gate-gh-repo.mjs';

const SCRIPTS_DIR = fileURLToPath(new URL('..', import.meta.url));
const HOTFIX_SCRIPT = path.join(SCRIPTS_DIR, 'check-hotfix-pattern.mjs');
const CLASSIFY_SCRIPT = path.join(SCRIPTS_DIR, 'classify-merge-outcome.mjs');

// Temp git repo: base commit + one `fix:` keyword commit on a single .mjs file
// (keeps autoLabel eligible so the `gh pr edit` write path actually runs), an
// optional `origin` remote, and bin/gh appending argv to $GH_LOG.
function buildFixtureRepo({ withOrigin = true, prTruth = { state: 'MERGED' } } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'merge-gate-gh-pin-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(dir, 'base.mjs'), "export const base = 'base';\n");
  git('add', '.');
  git('commit', '-q', '-m', 'chore: base');
  const base = git('rev-parse', 'HEAD').trim();

  writeFileSync(path.join(dir, 'fix.mjs'), "export const fix = 'fix';\n");
  git('add', '.');
  git('commit', '-q', '-m', 'fix: keyword commit for label eligibility');

  if (withOrigin) {
    git('remote', 'add', 'origin', 'https://github.com/example-owner/example-repo.git');
  }

  const binDir = path.join(dir, 'bin');
  mkdirSync(binDir);
  const ghLog = path.join(dir, 'gh.log');
  const prTruthFile = path.join(dir, 'pr-truth.json');
  writeFileSync(
    path.join(binDir, 'gh'),
    '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$GH_LOG"\ncat "$GH_PR_TRUTH" 2>/dev/null || true\n',
  );
  chmodSync(path.join(binDir, 'gh'), 0o755);
  writeFileSync(prTruthFile, JSON.stringify(prTruth));

  return {
    dir,
    base,
    ghLog,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      GH_LOG: ghLog,
      GH_PR_TRUTH: prTruthFile,
      PR_NUMBER: '42',
    },
  };
}

function runScript(script, args, fixture, extraEnv = {}, clearEnvKeys = []) {
  const env = { ...fixture.env, ...extraEnv };
  for (const key of clearEnvKeys) delete env[key];
  const result = spawnSync('node', [script, ...args], { encoding: 'utf8', cwd: fixture.dir, env });
  const lines = String(result.stdout ?? '')
    .trim()
    .split('\n');
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    lastJson: JSON.parse(lines[lines.length - 1]),
  };
}

function ghArgv(fixture) {
  return existsSync(fixture.ghLog) ? readFileSync(fixture.ghLog, 'utf8').split('\n').filter(Boolean) : [];
}

function assertPinned(argv, expectedRepo) {
  assert.ok(argv.length > 0, 'gh must have been invoked');
  const repoFlags = argv.filter((a) => a === '--repo');
  assert.ok(repoFlags.length > 0, `gh argv must carry --repo: ${JSON.stringify(argv)}`);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--repo') continue;
    assert.equal(argv[i + 1], expectedRepo, `--repo value at argv[${i + 1}]`);
  }
  assert.ok(!argv.includes('zts212653/clowder-ai'), `must not touch the upstream repository: ${JSON.stringify(argv)}`);
}

describe('parseGitHubRepository', () => {
  it('https URL with .git suffix', () => {
    assert.equal(parseGitHubRepository('https://github.com/08mamba24/clowder-ai.git'), '08mamba24/clowder-ai');
  });

  it('https URL without .git suffix', () => {
    assert.equal(parseGitHubRepository('https://github.com/zts212653/cat-cafe'), 'zts212653/cat-cafe');
  });

  it('scp-style ssh URL', () => {
    assert.equal(parseGitHubRepository('git@github.com:08mamba24/clowder-ai.git'), '08mamba24/clowder-ai');
  });

  it('ssh:// URL', () => {
    assert.equal(parseGitHubRepository('ssh://git@github.com/08mamba24/clowder-ai.git'), '08mamba24/clowder-ai');
  });

  it('trailing slash is stripped', () => {
    assert.equal(parseGitHubRepository('https://github.com/a/b/'), 'a/b');
  });

  it('non-GitHub host returns null', () => {
    assert.equal(parseGitHubRepository('https://gitlab.com/a/b.git'), null);
  });

  it('nested path (not owner/repo) returns null', () => {
    assert.equal(parseGitHubRepository('https://github.com/a/b/c'), null);
  });

  it('owner-only URL returns null', () => {
    assert.equal(parseGitHubRepository('https://github.com/a'), null);
  });

  it('empty / nullish input returns null', () => {
    assert.equal(parseGitHubRepository(''), null);
    assert.equal(parseGitHubRepository(null), null);
    assert.equal(parseGitHubRepository(undefined), null);
  });
});

describe('resolveMergeGateRepository', () => {
  it("resolves this clone's origin via the same parser (portable across forks)", () => {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
    assert.equal(resolveMergeGateRepository(), parseGitHubRepository(url));
  });

  it('outside a git repository: throws merge_gate_repo_unresolved', () => {
    const previousCwd = process.cwd();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'merge-gate-no-git-'));
    process.chdir(dir);
    try {
      assert.throws(() => resolveMergeGateRepository(), /merge_gate_repo_unresolved/);
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('non-GitHub origin remote: throws merge_gate_repo_unresolved', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'merge-gate-non-gh-'));
    execFileSync('git', ['-C', dir, 'init', '-q']);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://gitlab.com/a/b.git']);
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      assert.throws(() => resolveMergeGateRepository(), /merge_gate_repo_unresolved/);
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('check-hotfix-pattern.mjs — gh calls pinned to origin', () => {
  it('pr view (title scan) and pr edit (--apply-label) both carry --repo <origin>', () => {
    const fixture = buildFixtureRepo();
    try {
      const r = runScript(HOTFIX_SCRIPT, ['--apply-label', '42'], fixture, { HOTFIX_BASE: fixture.base });
      assert.equal(r.status, 2, 'hotfix keyword commit must still exit 2');
      assert.equal(r.lastJson.hotfix, true);
      assert.equal(r.lastJson.autoLabel, true);
      assert.equal(r.lastJson.labelApplied, true, `label write should succeed via stub: ${JSON.stringify(r.lastJson)}`);
      assert.equal(r.lastJson.labelError, null);
      const argv = ghArgv(fixture);
      assert.equal(argv.filter((a) => a === '--repo').length, 2, 'both view and edit invocations must be pinned');
      assertPinned(argv, 'example-owner/example-repo');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('no resolvable origin: label write REFUSED, gh never invoked, commit scan still detects', () => {
    const fixture = buildFixtureRepo({ withOrigin: false });
    try {
      const r = runScript(HOTFIX_SCRIPT, ['--apply-label', '42'], fixture, { HOTFIX_BASE: fixture.base });
      assert.equal(r.status, 2);
      assert.equal(r.lastJson.hotfix, true, 'commit-keyword detection must not depend on gh');
      assert.equal(r.lastJson.autoLabel, true);
      assert.equal(r.lastJson.labelApplied, false, 'write path must fail closed');
      assert.match(r.lastJson.labelError ?? '', /merge_gate_repo_unresolved/);
      assert.equal(ghArgv(fixture).length, 0, 'gh must not be invoked at all without a resolved repo');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe('classify-merge-outcome.mjs — gh pr view pinned to origin', () => {
  it('no-fixture run: pr view argv carries --repo <origin>, PR truth parsed from gh output', () => {
    const fixture = buildFixtureRepo({
      prTruth: { state: 'MERGED', mergedAt: '2026-09-17T00:00:00Z', mergeCommit: { oid: 'deadbeef' } },
    });
    try {
      const r = runScript(CLASSIFY_SCRIPT, ['--pr', '42', '--merge-exit-code', '1'], fixture, {}, [
        'CAT_CAFE_MERGE_OUTCOME_PR_FIXTURE',
      ]);
      assert.equal(r.status, 0, 'nonzero + MERGED truth via gh -> remote_merged_cleanup_needed, exit 0');
      assert.equal(r.lastJson.outcome, 'remote_merged_cleanup_needed');
      assert.equal(r.lastJson.mergeCommit, 'deadbeef');
      assertPinned(ghArgv(fixture), 'example-owner/example-repo');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
