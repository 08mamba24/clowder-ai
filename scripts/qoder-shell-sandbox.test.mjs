import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test(
  'Qoder shell-prefix always sandboxes native envelopes and standalone gh; only the exact memory shim gets memory policy',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'qoder-shell-only-'));
    try {
      const sandbox = join(root, 'sandbox');
      writeFileSync(
        sandbox,
        `#!${process.execPath}\nconsole.log(JSON.stringify({args: process.argv.slice(2), readonly: process.env.CAT_CAFE_GITHUB_READ_ONLY}));\n`,
        { mode: 0o700 },
      );
      const env = {
        PATH: '/usr/bin:/bin',
        CAT_CAFE_QODER_SANDBOX_BIN: sandbox,
        CAT_CAFE_QODER_WORKSPACE_POLICY: '/workspace.sb',
        CAT_CAFE_QODER_MEMORY_POLICY: '/memory.sb',
        CAT_CAFE_QODER_MEMORY_SHIM: '/private/memory-shim',
      };
      const wrapper = fileURLToPath(new URL('./qoder-shell-sandbox.mjs', import.meta.url));
      for (const command of [
        'gh pr list --repo 08mamba24/clowder-ai',
        "source '/snapshot' 2>/dev/null || true; eval 'gh pr list --repo 08mamba24/clowder-ai'; pwd > '/cwd'",
        '/private/memory-shim && gh auth token',
        "'/private/memory-shim'",
      ]) {
        const result = spawnSync(process.execPath, [wrapper, command], { env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const expectedPolicy = command === "'/private/memory-shim'" ? '/memory.sb' : '/workspace.sb';
        assert.deepEqual(JSON.parse(result.stdout), {
          args: ['-f', expectedPolicy, '/bin/sh', '-c', command],
          readonly: 'true',
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('guarded gh denies read/write/auth commands and advertises native MCP without invoking a delegate', () => {
  const guarded = fileURLToPath(new URL('./guarded-bin/gh', import.meta.url));
  const env = { PATH: '/usr/bin:/bin', CAT_CAFE_GITHUB_READ_ONLY: 'true', CAT_CAFE_REAL_GH_PATH: '/no-such-delegate' };
  for (const args of [
    ['pr', 'list', '--repo', '08mamba24/clowder-ai'],
    ['pr', 'create'],
    ['auth', 'token'],
    ['--version', '--repo', 'other'],
  ]) {
    const result = spawnSync(process.execPath, [guarded, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /use mcp__clowder-repository-read__github_read/);
    assert.equal(result.stdout, '');
  }
  const version = spawnSync(process.execPath, [guarded, '--version'], { env, encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /Clowder readonly carrier/);
});

// The controlled Qoder sandbox mounts scripts/guarded-bin but not scripts/lib,
// and the `gh --version` canary is classified under the workspace policy. A
// read-only runtime is therefore a lib-free environment: the wrapper must answer
// the canary (and refuse payload commands) before it resolves the secret
// helpers. Static helper imports died with ERR_MODULE_NOT_FOUND and blocked
// controlled Qoder startup (P1, 2026-10-31).
test('guarded gh answers the read-only carrier with no scripts/lib mounted', () => {
  const root = mkdtempSync(join(tmpdir(), 'guarded-gh-libless-'));
  try {
    const dir = join(root, 'scripts', 'guarded-bin');
    mkdirSync(dir, { recursive: true });
    const guarded = join(dir, 'gh');
    copyFileSync(fileURLToPath(new URL('./guarded-bin/gh', import.meta.url)), guarded);
    const readOnly = {
      PATH: '/usr/bin:/bin',
      CAT_CAFE_GITHUB_READ_ONLY: 'true',
      CAT_CAFE_REAL_GH_PATH: '/no-such-delegate',
    };

    const version = spawnSync(process.execPath, [guarded, '--version'], { env: readOnly, encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /Clowder readonly carrier/);

    const denied = spawnSync(process.execPath, [guarded, 'pr', 'view', '1'], { env: readOnly, encoding: 'utf8' });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /use mcp__clowder-repository-read__github_read/);
    assert.equal(denied.stdout, '');

    // Non-read-only still owns the secret path: with the helpers unreachable it
    // must fail instead of forwarding an uninspected command to a delegate.
    const unsafe = spawnSync(process.execPath, [guarded, 'api', 'repos/o/r'], {
      env: { PATH: '/usr/bin:/bin', CAT_CAFE_REAL_GH_PATH: '/no-such-delegate' },
      encoding: 'utf8',
    });
    assert.notEqual(unsafe.status, 0);
    assert.equal(unsafe.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
