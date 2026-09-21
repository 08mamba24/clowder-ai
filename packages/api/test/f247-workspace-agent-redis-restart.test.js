/**
 * F247 workspace-agent round-4 R3: owner-only recovery binding survives a
 * real isolated Redis restart. Spawns a disposable redis-server on a random
 * local port with its own temp dir (never touches production Redis — no
 * shared prefix, no flush); skips cleanly when no redis-server binary exists.
 */

import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';

function findRedisServer() {
  const candidates = ['/opt/homebrew/bin/redis-server', '/usr/local/bin/redis-server', '/usr/bin/redis-server'];
  try {
    if (spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0) return 'redis-server';
  } catch {
    /* not on PATH */
  }
  for (const candidate of candidates) {
    if (spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0) return candidate;
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function startRedis(binary, port, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      ['--port', String(port), '--bind', '127.0.0.1', '--dir', dir, '--save', '1 1', '--appendonly', 'no', '--daemonize', 'no'],
      { stdio: 'ignore' },
    );
    child.on('error', reject);
    const started = Date.now();
    const poll = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(child);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > 10_000) reject(new Error('redis-server did not come up'));
        else setTimeout(poll, 100);
      });
    };
    poll();
  });
}

/**
 * astra round-5 R4: locate the cli next to the server binary (then PATH),
 * PROPAGATE failures (never swallow), and fall back to SIGTERM which — with
 * the --save 1 1 config — persists before exit. Exit waits are bounded.
 */
function findRedisCli(serverBinary) {
  const sibling = join(dirname(serverBinary), 'redis-cli');
  if (existsSync(sibling)) return sibling;
  try {
    if (spawnSync('redis-cli', ['--version'], { stdio: 'ignore' }).status === 0) return 'redis-cli';
  } catch {
    /* not on PATH */
  }
  return null;
}

function shutdownRedis(cli, port) {
  return new Promise((resolve, reject) => {
    if (!cli) return resolve({ mode: 'signal' });
    execFile(cli, ['-h', '127.0.0.1', '-p', String(port), 'shutdown', 'save'], (error) => {
      // redis-cli exits non-zero when the connection closes on SHUTDOWN;
      // treat connection-level errors on an otherwise issued command as done.
      if (error && error.code !== 0 && error.code !== undefined && !/connect|ENOENT/i.test(String(error.message))) {
        return reject(error);
      }
      resolve({ mode: 'cli' });
    });
  });
}

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('timeout');
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const binary = findRedisServer();

describe('F247 workspace-agent recovery binding across a real Redis restart', { skip: binary ? false : 'redis-server binary not available' }, () => {
  let RedisThreadStore;
  let createRedisClient;
  let normalizeCloudCatBinding;
  let child;
  let dir;
  let port;
  let redis;
  let store;
  let cli;

  before(async () => {
    ({ RedisThreadStore } = await import('../dist/domains/cats/services/stores/redis/RedisThreadStore.js'));
    ({ createRedisClient } = await import('@cat-cafe/shared/utils'));
    ({ normalizeCloudCatBinding } = await import('../dist/domains/cats/services/cloud-bridge/cloud-cat-bindings-v1.js'));
    dir = mkdtempSync(join(tmpdir(), 'f247-wa-redis-'));
    port = await freePort();
    cli = findRedisCli(binary);
    child = await startRedis(binary, port, dir);
    redis = createRedisClient({ url: `redis://127.0.0.1:${port}` });
    await redis.ping();
    store = new RedisThreadStore(redis, { ttlSeconds: null });
    // Seed the thread detail hash so the guarded HSET Lua admits binding writes.
    await redis.hset('thread:t-wa-restart', 'id', 't-wa-restart');
  });

  after(async () => {
    try {
      await redis?.quit?.();
    } catch {
      /* best effort */
    }
    if (child && !child.killed) {
      await shutdownRedis(port).catch(() => {});
      child.kill('SIGKILL');
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('persists versioned + legacy bindings across shutdown SAVE and restart', async () => {
    const versioned = {
      v: 1,
      provider: 'workspace-agent',
      workspaceId: 'ws_restart',
      triggerId: 'agtch_restart',
      conversationUrl: 'https://chatgpt.com/c/wa-restart-1',
    };
    await store.updateCloudCatBindingEntry('t-wa-restart', 'gpt-pro', versioned);
    await store.updateCloudCatBinding('t-wa-restart', 'gpt-52', 'https://chatgpt.com/c/legacy-1');

    const before = await store.getCloudCatBindings('t-wa-restart');
    assert.equal(normalizeCloudCatBinding(before['gpt-pro'])?.conversationUrl, 'https://chatgpt.com/c/wa-restart-1');
    assert.equal(normalizeCloudCatBinding(before['gpt-52'])?.provider, 'personal-chrome-host');

    // Restart cycle: graceful SHUTDOWN SAVE (cli, or SIGTERM+save-config
    // fallback) → bounded exit wait → respawn → fresh client.
    try {
      await redis.quit();
    } catch {
      /* already closing */
    }
    const shutdown = await shutdownRedis(cli, port);
    if (shutdown.mode === 'signal') child.kill('SIGTERM');
    const exitCode = await waitForExit(child);
    assert.notEqual(exitCode, 'timeout', 'redis-server must exit after shutdown');
    child = await startRedis(binary, port, dir);
    redis = createRedisClient({ url: `redis://127.0.0.1:${port}` });
    await redis.ping();
    const restartedStore = new RedisThreadStore(redis, { ttlSeconds: null });

    const after = await restartedStore.getCloudCatBindings('t-wa-restart');
    const recovered = normalizeCloudCatBinding(after['gpt-pro']);
    assert.equal(recovered?.provider, 'workspace-agent');
    assert.equal(recovered?.conversationUrl, 'https://chatgpt.com/c/wa-restart-1', 'owner-only recovery anchor survives restart');
    assert.equal(recovered?.workspaceId, 'ws_restart');
    assert.equal(normalizeCloudCatBinding(after['gpt-52'])?.conversationUrl, 'https://chatgpt.com/c/legacy-1', 'legacy string binding survives too');
  });
});
