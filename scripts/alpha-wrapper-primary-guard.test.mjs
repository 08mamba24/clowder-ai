import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { namedAlphaFixture } from './lib/alpha-named-fixture.mjs';

function runWrapper(scriptPath, args, cwd, env) {
  return spawnSync('bash', [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: env.HOME,
      TERM: 'xterm',
      CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
      ...env,
    },
    timeout: 30_000,
  });
}

function makeThirdWorktree(f) {
  const thirdRoot = join(f.directory, 'cat-cafe-third');
  f.git(['worktree', 'add', '-b', 'feature-third', thirdRoot, 'origin/main']);
  return thirdRoot;
}

test('legacy start refuses when the wrapper runs from the alpha worktree itself', (t) => {
  const f = namedAlphaFixture(t);
  const result = runWrapper(join(f.alphaRoot, 'scripts/alpha-worktree.sh'), ['start'], f.alphaRoot, {
    HOME: join(f.directory, 'home'),
  });
  assert.notEqual(result.status, 0, 'must fail closed');
  assert.match(result.stderr, /primary checkout/);
  assert.match(result.stderr, /linked worktree/);
  assert.match(result.stderr, new RegExp(f.mainRoot.replaceAll('/', '\\/')));
  assert.equal(existsSync(join(f.directory, 'cat-cafe-alpha')), false, 'no side effects before refusal');
});

test('legacy start refuses from a third worktree even when it manages the real alpha', (t) => {
  const f = namedAlphaFixture(t);
  const thirdRoot = makeThirdWorktree(f);
  const result = runWrapper(join(thirdRoot, 'scripts/alpha-worktree.sh'), ['start'], thirdRoot, {
    HOME: join(f.directory, 'home'),
    CAT_CAFE_ALPHA_DIR: f.alphaRoot,
  });
  assert.notEqual(result.status, 0, 'must fail closed');
  assert.match(result.stderr, /primary checkout/);
});

test('legacy init refuses before creating anything when the target does not exist', (t) => {
  const f = namedAlphaFixture(t);
  const thirdRoot = makeThirdWorktree(f);
  const missingTarget = join(f.directory, 'alpha-not-created');
  const result = runWrapper(join(thirdRoot, 'scripts/alpha-worktree.sh'), ['init'], thirdRoot, {
    HOME: join(f.directory, 'home'),
    CAT_CAFE_ALPHA_DIR: missingTarget,
  });
  assert.notEqual(result.status, 0, 'must fail closed');
  assert.match(result.stderr, /primary checkout/);
  assert.equal(existsSync(missingTarget), false, 'refusal must precede target creation');
});

function writeGuardProbe(f) {
  const probePath = join(f.mainRoot, 'scripts', 'guard-probe.sh');
  writeFileSync(
    probePath,
    [
      '#!/bin/bash',
      'set -eu',
      'source "$(dirname "$0")/alpha-worktree.sh" --source-only',
      'assert_wrapper_primary_checkout',
      'echo GUARD_OK',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return probePath;
}

function probeEnv(f) {
  return {
    PATH: process.env.PATH,
    HOME: join(f.directory, 'home'),
    TERM: 'xterm',
    CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
  };
}

test('the guard accepts the primary checkout on branch main (source-only)', (t) => {
  const f = namedAlphaFixture(t);
  const result = spawnSync('bash', [writeGuardProbe(f)], {
    cwd: f.mainRoot,
    encoding: 'utf8',
    env: probeEnv(f),
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GUARD_OK/);
});

test('status stays available from a linked worktree and only warns', (t) => {
  const f = namedAlphaFixture(t);
  const result = runWrapper(join(f.alphaRoot, 'scripts/alpha-worktree.sh'), ['status'], f.alphaRoot, {
    HOME: join(f.directory, 'home'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /WARN:.*primary checkout/);
});

test('the primary checkout guard rejects a detached HEAD even in the primary root', (t) => {
  const f = namedAlphaFixture(t);
  f.git(['checkout', '--detach']);
  const result = spawnSync('bash', [writeGuardProbe(f)], {
    cwd: f.mainRoot,
    encoding: 'utf8',
    env: probeEnv(f),
    timeout: 15_000,
  });
  // A detached HEAD is not the managed main checkout; the guard must refuse it.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /primary checkout/);
});
