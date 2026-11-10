import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
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

function writeProbeAt(f, dir) {
  const probePath = join(dir, 'guard-probe.sh');
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

test('a main-repo subdirectory reached via a scripts symlink is refused', (t) => {
  const f = namedAlphaFixture(t);
  writeProbeAt(f, join(f.mainRoot, 'scripts'));
  mkdirMainSubdirHelper(f);
  const result = spawnSync('bash', [join(f.mainRoot, 'tools', 'scripts', 'guard-probe.sh')], {
    cwd: f.mainRoot,
    encoding: 'utf8',
    env: probeEnv(f),
    timeout: 15_000,
  });
  assert.notEqual(result.status, 0, 'must fail closed');
  assert.match(result.stderr, /primary checkout/);
});

test('an inherited GIT_DIR cannot smuggle a third worktree past the guard', (t) => {
  const f = namedAlphaFixture(t);
  const thirdRoot = makeThirdWorktree(f);
  writeProbeAt(f, join(thirdRoot, 'scripts'));
  const result = spawnSync('bash', [join(thirdRoot, 'scripts', 'guard-probe.sh')], {
    cwd: thirdRoot,
    encoding: 'utf8',
    env: { ...probeEnv(f), GIT_DIR: join(f.mainRoot, '.git') },
    timeout: 15_000,
  });
  assert.notEqual(result.status, 0, 'must fail closed');
  assert.match(result.stderr, /primary checkout/);
});

test('a whole-repo symlink alias of the main checkout stays legal', (t) => {
  const f = namedAlphaFixture(t);
  writeProbeAt(f, join(f.mainRoot, 'scripts'));
  const alias = join(f.directory, 'main-alias');
  symlinkSync(f.mainRoot, alias);
  const result = spawnSync('bash', [join(alias, 'scripts', 'guard-probe.sh')], {
    cwd: alias,
    encoding: 'utf8',
    env: probeEnv(f),
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GUARD_OK/);
});

function mkdirMainSubdirHelper(f) {
  mkdirSync(join(f.mainRoot, 'tools'), { recursive: true });
  symlinkSync(join(f.mainRoot, 'scripts'), join(f.mainRoot, 'tools', 'scripts'));
}

function makeSecondRepo(f, name) {
  const root = join(f.directory, name);
  const ex = (args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ex(['init', '-q', '-b', 'main', root]);
  ex(['-C', root, 'config', 'user.name', 'Second Repo']);
  ex(['-C', root, 'config', 'user.email', 'second@example.invalid']);
  ex(['-C', root, 'commit', '--allow-empty', '-m', 'second repo']);
  ex(['-C', root, 'remote', 'add', 'origin', join(f.directory, 'remote.git')]);
  return root;
}

test('an inherited GIT_COMMON_DIR pointing elsewhere does not refute a legit primary', (t) => {
  const f = namedAlphaFixture(t);
  writeGuardProbe(f);
  const other = makeSecondRepo(f, 'other-commondir');
  const result = spawnSync('bash', [join(f.mainRoot, 'scripts', 'guard-probe.sh')], {
    cwd: f.mainRoot,
    encoding: 'utf8',
    env: { ...probeEnv(f), GIT_COMMON_DIR: join(other, '.git') },
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GUARD_OK/);
});

test('a full init with an inherited GIT_DIR never registers into the foreign repository', (t) => {
  const f = namedAlphaFixture(t);
  const other = makeSecondRepo(f, 'other-gitdir');
  const before = f.git(['worktree', 'list', '--porcelain'], other);
  const target = join(f.directory, 'alpha-init-target');
  const result = spawnSync(
    'bash',
    [join(f.mainRoot, 'scripts/alpha-worktree.sh'), 'init', '--dir', target, '--no-install'],
    {
      cwd: f.mainRoot,
      encoding: 'utf8',
      env: { ...probeEnv(f), GIT_DIR: join(other, '.git') },
      timeout: 60_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const after = f.git(['worktree', 'list', '--porcelain'], other);
  assert.equal(after, before, 'the foreign repository registry must stay untouched');
  const ownList = f.git(['worktree', 'list', '--porcelain'], f.mainRoot);
  assert.match(
    ownList,
    new RegExp(target.replaceAll('/', '\\/')),
    'the worktree must register under the wrapper repository',
  );
});
