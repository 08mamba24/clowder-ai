import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runGhReadProcess } from '../dist/infrastructure/github/agent-github-read-process.js';

async function until(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await delay(20);
  return predicate();
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
test('real runner closes stdin and retains exit status without a terminal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-read-stdin-'));
  try {
    const result = await runGhReadProcess(
      process.execPath,
      [
        '-e',
        'process.stdin.resume(); process.stdin.on("end", () => { console.log(process.stdin.isTTY === undefined); process.exitCode = 8; });',
      ],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, CAT_CAFE_DATA_DIR: dir },
        signal: new AbortController().signal,
        timeout: 5000,
        maxBuffer: 16384,
        shell: false,
        windowsHide: true,
      },
    );
    assert.equal(result.stdout.trim(), 'true');
    assert.equal(result.exitCode, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
for (const trigger of ['abort', 'timeout', 'output']) {
  test(
    `real runner ${trigger} reclaims a wrapper's detached descendant`,
    { skip: process.platform === 'win32' },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'gh-read-tree-'));
      const ready = join(dir, 'ready');
      const release = join(dir, 'release');
      const fixture = join(dir, 'fake-gh.cjs');
      const cancel = new AbortController();
      let pid;
      await writeFile(
        fixture,
        `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 15000);'], {detached:true, stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(ready)}, String(child.pid));
      setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.stdout.write('x'.repeat(65536)); }, 20);
      setTimeout(() => process.exit(0), 15000);
    `,
      );
      const outcome = runGhReadProcess(process.execPath, [fixture], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, CAT_CAFE_DATA_DIR: dir },
        signal: cancel.signal,
        timeout: trigger === 'timeout' ? 2000 : 10000,
        maxBuffer: 1024,
        shell: false,
        windowsHide: true,
      }).then(
        () => ({ error: undefined }),
        (error) => ({ error }),
      );
      try {
        assert.equal(await until(() => existsSync(ready)), true, 'fixture must start');
        pid = Number(readFileSync(ready, 'utf8'));
        assert.equal(alive(pid), true);
        if (trigger === 'abort') cancel.abort();
        if (trigger === 'output') await writeFile(release, 'go');
        const { error } = await outcome;
        assert.ok(error, `${trigger} must reject`);
        assert.equal(await until(() => !alive(pid)), true, 'descendant must be reclaimed');
        assert.equal(alive(process.pid), true, 'test parent survives');
      } finally {
        cancel.abort();
        if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
        await outcome;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}
