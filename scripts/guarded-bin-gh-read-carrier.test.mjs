/**
 * guarded-bin/gh lease carrier tests (ZCode isolated GitHub read migration).
 *
 * Spawns the wrapper from a fixture directory that contains ONLY the wrapper
 * (no scripts/lib), proving the carrier answers before the secret helpers
 * load. A loopback fake API stands in for the host query endpoint so the
 * broker contract (bearer token, typed query body) is observable without any
 * real gh credential or network access.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const TOKEN = 'a'.repeat(43);
const OTHER_TOKEN = 'b'.repeat(43);

const roots = [];
const servers = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.close();
});

function carrierFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gh-read-carrier-'));
  roots.push(root);
  const dir = join(root, 'scripts', 'guarded-bin');
  mkdirSync(dir, { recursive: true });
  const wrapper = join(dir, 'gh');
  copyFileSync(resolve('scripts/guarded-bin/gh'), wrapper);
  chmodSync(wrapper, 0o755);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, wrapper, home };
}

function writeLease(home, { url, token = TOKEN }) {
  writeFileSync(join(home, '.cat-cafe-gh-read-lease.json'), JSON.stringify({ url, token }));
}

function startFakeApi(handler) {
  return new Promise((resolveServer) => {
    const hits = [];
    const server = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const hit = {
          url: request.url,
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        hits.push(hit);
        handler(hit, response);
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolveServer({ server, hits, port: server.address().port }));
  });
}

function run(wrapper, home, args, extraEnv = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [wrapper, ...args], {
      env: { PATH: '/usr/bin:/bin', HOME: home, CAT_CAFE_GH_READ_CARRIER: 'lease', ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

function okResponse(response, data) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      ok: true,
      data,
      provenance: { repository: 'x/y', operation: 'pr_view', observedAt: 'x', sourceUrl: 'x', truncated: false },
    }),
  );
}

describe('guarded gh lease carrier', () => {
  it('answers the --version canary without touching the endpoint', async () => {
    const { wrapper, home } = carrierFixture();
    const api = await startFakeApi((_hit, response) => okResponse(response, {}));
    writeLease(home, { url: `http://127.0.0.1:${api.port}/api/agent-github-read` });
    const result = await run(wrapper, home, ['--version']);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'gh (Clowder readonly carrier)\n');
    assert.equal(api.hits.length, 0);
  });

  it('forwards a typed pr_view query with the lease bearer token and prints the data', async () => {
    const { wrapper, home } = carrierFixture();
    const api = await startFakeApi((hit, response) => {
      assert.equal(hit.url, '/api/agent-github-read');
      okResponse(response, { number: 79, title: 'demo' });
    });
    writeLease(home, { url: `http://127.0.0.1:${api.port}/api/agent-github-read` });
    const result = await run(wrapper, home, ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { number: 79, title: 'demo' });
    assert.equal(api.hits.length, 1);
    assert.equal(api.hits[0].authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(api.hits[0].body), { op: 'pr_view', repo: '08mamba24/clowder-ai', number: 79 });
  });

  it('normalizes a github.com/ repo prefix and accepts the canonical --json field set in any order', async () => {
    const { wrapper, home } = carrierFixture();
    const api = await startFakeApi((_hit, response) => okResponse(response, {}));
    writeLease(home, { url: `http://127.0.0.1:${api.port}/api/agent-github-read` });
    const result = await run(wrapper, home, [
      'pr',
      'view',
      '79',
      '--repo',
      'github.com/08mamba24/clowder-ai',
      '--json',
      'body,headRefOid,isDraft,number,state,title,updatedAt,url',
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(api.hits[0].body), { op: 'pr_view', repo: '08mamba24/clowder-ai', number: 79 });
  });

  it('applies list defaults and accepts -R with explicit state and limit', async () => {
    const { wrapper, home } = carrierFixture();
    const api = await startFakeApi((_hit, response) => okResponse(response, []));
    writeLease(home, { url: `http://127.0.0.1:${api.port}/api/agent-github-read` });
    const first = await run(wrapper, home, ['pr', 'list', '-R', '08mamba24/clowder-ai']);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(JSON.parse(api.hits[0].body), {
      op: 'pr_list',
      repo: '08mamba24/clowder-ai',
      state: 'open',
      limit: 30,
    });
    const second = await run(wrapper, home, [
      'issue',
      'list',
      '--repo',
      '08mamba24/clowder-ai',
      '--state',
      'closed',
      '--limit',
      '5',
    ]);
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(JSON.parse(api.hits[1].body), {
      op: 'issue_list',
      repo: '08mamba24/clowder-ai',
      state: 'closed',
      limit: 5,
    });
  });

  it('maps run view onto runId', async () => {
    const { wrapper, home } = carrierFixture();
    const api = await startFakeApi((_hit, response) => okResponse(response, {}));
    writeLease(home, { url: `http://127.0.0.1:${api.port}/api/agent-github-read` });
    const result = await run(wrapper, home, ['run', 'view', '123', '--repo', '08mamba24/clowder-ai']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(api.hits[0].body), { op: 'run_view', repo: '08mamba24/clowder-ai', runId: 123 });
  });

  it('rejects write operations, raw api access, bad states and mismatched field sets locally', async () => {
    const { wrapper, home } = carrierFixture();
    const api = await startFakeApi((_hit, response) => okResponse(response, {}));
    writeLease(home, { url: `http://127.0.0.1:${api.port}/api/agent-github-read` });
    const rejected = [
      ['pr', 'create', '--repo', '08mamba24/clowder-ai'],
      ['api', 'repos/08mamba24/clowder-ai'],
      ['auth', 'status'],
      ['pr', 'view', '79'],
      ['pr', 'list', '--repo', '08mamba24/clowder-ai', '--state', 'merged-all'],
      ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai', '--json', 'number,title'],
      ['pr', 'view', 'abc', '--repo', '08mamba24/clowder-ai'],
      ['gist', 'list'],
    ];
    for (const args of rejected) {
      const result = await run(wrapper, home, args);
      assert.equal(result.code, 1, `expected rejection: ${args.join(' ')}`);
      assert.match(result.stderr, /^capability_unavailable:/);
    }
    assert.equal(api.hits.length, 0);
  });

  it('fails closed without a lease file, with a malformed lease, or with a non-loopback lease url', async () => {
    const { wrapper, home } = carrierFixture();
    const api = await startFakeApi((_hit, response) => okResponse(response, {}));
    const missing = await run(wrapper, home, ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no active GitHub read lease/);
    writeLease(home, { url: `http://127.0.0.1:${api.port}/api/agent-github-read`, token: 'short' });
    const malformed = await run(wrapper, home, ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai']);
    assert.equal(malformed.code, 1);
    assert.match(malformed.stderr, /no active GitHub read lease/);
    writeLease(home, { url: 'https://example.com/api/agent-github-read', token: OTHER_TOKEN });
    const result = await run(wrapper, home, ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no active GitHub read lease/);
    assert.equal(api.hits.length, 0);
  });

  it('surfaces broker failures honestly and never leaks the token', async () => {
    const { wrapper, home } = carrierFixture();
    const api = await startFakeApi((_hit, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, code: 'scope_denied', retryable: false }));
    });
    writeLease(home, { url: `http://127.0.0.1:${api.port}/api/agent-github-read` });
    const denied = await run(wrapper, home, ['pr', 'view', '79', '--repo', 'some-other/repo']);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /^gh_read_failed: scope_denied/);
    const unauthorized = await startFakeApi((_hit, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, code: 'capability_unavailable', retryable: false }));
    });
    writeLease(home, { url: `http://127.0.0.1:${unauthorized.port}/api/agent-github-read` });
    const stale = await run(wrapper, home, ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai']);
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /^gh_read_failed: authentication_required/);
    for (const output of [denied.stdout + denied.stderr, stale.stdout + stale.stderr])
      assert.ok(!output.includes(TOKEN), 'token must never appear in wrapper output');
  });
});
