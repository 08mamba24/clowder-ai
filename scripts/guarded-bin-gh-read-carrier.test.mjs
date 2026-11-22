/**
 * guarded-bin/gh lease carrier tests (ZCode isolated GitHub read migration).
 *
 * Spawns the wrapper from a fixture directory that contains ONLY the wrapper
 * (no scripts/lib), proving the carrier answers before the secret helpers
 * load. The lease file lives inside each fake member process's own runtime
 * directory (next to its ZCODE_PERSONAL_PROVIDER_CONFIG_FILE), mirroring the
 * adapter handoff. A loopback fake API stands in for the host query endpoint
 * so the broker contract (bearer token, typed query body) is observable
 * without any real gh credential or network access.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const TOKEN = 'a'.repeat(43);
const TOKEN_B = 'b'.repeat(43);

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
  return { root, wrapper };
}

/** A fake member-process runtime directory with its own provider input. */
function memberRuntime(root, name) {
  const runtime = join(root, `provider-runtime-1-${name}`);
  mkdirSync(runtime, { recursive: true });
  const providerConfig = join(runtime, 'provider.json');
  writeFileSync(providerConfig, '{}', { mode: 0o600 });
  return { providerConfig, leaseFile: join(runtime, 'gh-read-lease.json'), runtime };
}

function writeLease(member, { url, token = TOKEN }) {
  writeFileSync(member.leaseFile, JSON.stringify({ url, token }), { mode: 0o600 });
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

function run(wrapper, member, args, extraEnv = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [wrapper, ...args], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: join(tmpdir(), 'gh-read-carrier-empty-home'),
        CAT_CAFE_GH_READ_CARRIER: 'lease',
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: member.providerConfig,
        ...extraEnv,
      },
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
    const { wrapper, root } = carrierFixture();
    const member = memberRuntime(root, 'canary');
    const api = await startFakeApi((_hit, response) => okResponse(response, {}));
    writeLease(member, { url: `http://127.0.0.1:${api.port}/api/agent-github-read` });
    const result = await run(wrapper, member, ['--version']);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'gh (Clowder readonly carrier)\n');
    assert.equal(api.hits.length, 0);
  });

  it('forwards a typed pr_view query with the lease bearer token and prints the data', async () => {
    const { wrapper, root } = carrierFixture();
    const member = memberRuntime(root, 'prview');
    const api = await startFakeApi((hit, response) => {
      assert.equal(hit.url, '/api/agent-github-read');
      okResponse(response, { number: 79, title: 'demo' });
    });
    writeLease(member, { url: `http://127.0.0.1:${api.port}/api/agent-github-read` });
    const result = await run(wrapper, member, ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { number: 79, title: 'demo' });
    assert.equal(api.hits.length, 1);
    assert.equal(api.hits[0].authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(api.hits[0].body), { op: 'pr_view', repo: '08mamba24/clowder-ai', number: 79 });
  });

  it('covers all eight fixed reads with their exact typed contracts', async () => {
    const { wrapper, root } = carrierFixture();
    const member = memberRuntime(root, 'matrix');
    const api = await startFakeApi((_hit, response) => okResponse(response, {}));
    writeLease(member, { url: `http://127.0.0.1:${api.port}/api/agent-github-read` });
    const cases = [
      [
        ['pr', 'view', '79', '--repo', 'github.com/08mamba24/clowder-ai'],
        { op: 'pr_view', repo: '08mamba24/clowder-ai', number: 79 },
      ],
      [
        ['pr', 'diff', '79', '--repo', '08mamba24/clowder-ai', '--color', 'never'],
        { op: 'pr_diff', repo: '08mamba24/clowder-ai', number: 79 },
      ],
      [
        ['pr', 'checks', '79', '-R', '08mamba24/clowder-ai'],
        { op: 'pr_checks', repo: '08mamba24/clowder-ai', number: 79 },
      ],
      [
        ['pr', 'checks', '79', '--repo', '08mamba24/clowder-ai', '--json', 'name,state,bucket,workflow,link'],
        { op: 'pr_checks', repo: '08mamba24/clowder-ai', number: 79 },
      ],
      [
        ['pr', 'list', '--repo', '08mamba24/clowder-ai'],
        { op: 'pr_list', repo: '08mamba24/clowder-ai', state: 'open', limit: 30 },
      ],
      [
        ['pr', 'list', '--repo', '08mamba24/clowder-ai', '--state', 'merged', '--limit', '5'],
        { op: 'pr_list', repo: '08mamba24/clowder-ai', state: 'merged', limit: 5 },
      ],
      [
        ['issue', 'view', '7', '--repo', '08mamba24/clowder-ai'],
        { op: 'issue_view', repo: '08mamba24/clowder-ai', number: 7 },
      ],
      [
        ['issue', 'list', '--repo', '08mamba24/clowder-ai', '--state', 'closed'],
        { op: 'issue_list', repo: '08mamba24/clowder-ai', state: 'closed', limit: 30 },
      ],
      [
        ['run', 'view', '123', '--repo', '08mamba24/clowder-ai'],
        { op: 'run_view', repo: '08mamba24/clowder-ai', runId: 123 },
      ],
      [['run', 'list', '--repo', '08mamba24/clowder-ai'], { op: 'run_list', repo: '08mamba24/clowder-ai', limit: 30 }],
      [
        ['run', 'list', '--repo', '08mamba24/clowder-ai', '--limit', '50'],
        { op: 'run_list', repo: '08mamba24/clowder-ai', limit: 50 },
      ],
    ];
    for (const [args, expected] of cases) {
      const result = await run(wrapper, member, args);
      assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(api.hits.at(-1).body), expected, args.join(' '));
    }
    assert.equal(api.hits.length, cases.length);
  });

  it('rejects write operations, raw api access, invalid per-op flags and mismatched field sets locally', async () => {
    const { wrapper, root } = carrierFixture();
    const member = memberRuntime(root, 'rejects');
    const api = await startFakeApi((_hit, response) => okResponse(response, {}));
    writeLease(member, { url: `http://127.0.0.1:${api.port}/api/agent-github-read` });
    const rejected = [
      ['pr', 'create', '--repo', '08mamba24/clowder-ai'],
      ['api', 'repos/08mamba24/clowder-ai'],
      ['auth', 'status'],
      ['gist', 'list'],
      ['pr', 'view', '79'],
      ['pr', 'view', 'abc', '--repo', '08mamba24/clowder-ai'],
      ['pr', 'list', '--repo', '08mamba24/clowder-ai', '--state', 'merged-all'],
      // run_list takes no state at all.
      ['run', 'list', '--repo', '08mamba24/clowder-ai', '--state', 'open'],
      ['run', 'view', '123', '--repo', '08mamba24/clowder-ai', '--state', 'open'],
      ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai', '--limit', '5'],
      ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai', '--json', 'number,title'],
      ['pr', 'diff', '79', '--repo', '08mamba24/clowder-ai', '--json', 'number'],
      ['pr', 'checks', '79', '--repo', '08mamba24/clowder-ai', '--json', 'name,state'],
      ['pr', 'diff', '79', '--repo', '08mamba24/clowder-ai', '--color', 'always'],
      ['pr', 'list', '--repo', '08mamba24/clowder-ai', '--color', 'never'],
      ['pr', 'list', '--repo', '08mamba24/clowder-ai', '--limit', '51'],
    ];
    for (const args of rejected) {
      const result = await run(wrapper, member, args);
      assert.equal(result.code, 1, `expected rejection: ${args.join(' ')}`);
      assert.match(result.stderr, /^capability_unavailable:/);
    }
    assert.equal(api.hits.length, 0);
  });

  it('accepts the canonical --json field set in any order', async () => {
    const { wrapper, root } = carrierFixture();
    const member = memberRuntime(root, 'jsonfields');
    const api = await startFakeApi((_hit, response) => okResponse(response, {}));
    writeLease(member, { url: `http://127.0.0.1:${api.port}/api/agent-github-read` });
    const result = await run(wrapper, member, [
      'pr',
      'view',
      '79',
      '--repo',
      '08mamba24/clowder-ai',
      '--json',
      'body,headRefOid,isDraft,number,state,title,updatedAt,url',
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(api.hits[0].body), { op: 'pr_view', repo: '08mamba24/clowder-ai', number: 79 });
  });

  it('fails closed without a runtime dir, a lease file, a malformed lease, or a non-loopback url', async () => {
    const { wrapper, root } = carrierFixture();
    const member = memberRuntime(root, 'closed');
    const api = await startFakeApi((_hit, response) => okResponse(response, {}));
    // No provider config env at all: no HOME fallback exists.
    const noEnv = await new Promise((done) => {
      const child = spawn(process.execPath, [wrapper, 'pr', 'view', '79', '--repo', '08mamba24/clowder-ai'], {
        env: { PATH: '/usr/bin:/bin', CAT_CAFE_GH_READ_CARRIER: 'lease' },
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (code) => done({ code, stderr }));
    });
    assert.equal(noEnv.code, 1);
    assert.match(noEnv.stderr, /no active GitHub read lease/);
    // Provider config present but no lease file.
    const missing = await run(wrapper, member, ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no active GitHub read lease/);
    // Malformed token.
    writeLease(member, { url: `http://127.0.0.1:${api.port}/api/agent-github-read`, token: 'short' });
    const malformed = await run(wrapper, member, ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai']);
    assert.equal(malformed.code, 1);
    assert.match(malformed.stderr, /no active GitHub read lease/);
    // Non-loopback url in the lease is refused before any request.
    writeLease(member, { url: 'https://example.com/api/agent-github-read' });
    const offloop = await run(wrapper, member, ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai']);
    assert.equal(offloop.code, 1);
    assert.match(offloop.stderr, /no active GitHub read lease/);
    assert.equal(api.hits.length, 0);
  });

  it('overlapping invocations keep disjoint leases: B ends first, A still reads with its own audited token', async () => {
    const { wrapper, root } = carrierFixture();
    const memberA = memberRuntime(root, 'invA');
    const memberB = memberRuntime(root, 'invB');
    const api = await startFakeApi((_hit, response) => okResponse(response, { number: 79 }));
    writeLease(memberA, { url: `http://127.0.0.1:${api.port}/api/agent-github-read`, token: TOKEN });
    writeLease(memberB, { url: `http://127.0.0.1:${api.port}/api/agent-github-read`, token: TOKEN_B });
    // A reads while B is alive: A spends A's lease only.
    const first = await run(wrapper, memberA, ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai']);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(api.hits.at(-1).authorization, `Bearer ${TOKEN}`);
    // B's process retires first and its runtime dir is removed with it.
    rmSync(memberB.runtime, { recursive: true, force: true });
    // A is still active and still reads with its own capability.
    const second = await run(wrapper, memberA, ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai']);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(api.hits.at(-1).authorization, `Bearer ${TOKEN}`);
    assert.equal(api.hits.length, 2);
  });

  it('surfaces broker failures honestly and never leaks the token', async () => {
    const { wrapper, root } = carrierFixture();
    const member = memberRuntime(root, 'failures');
    const api = await startFakeApi((_hit, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, code: 'scope_denied', retryable: false }));
    });
    writeLease(member, { url: `http://127.0.0.1:${api.port}/api/agent-github-read` });
    const denied = await run(wrapper, member, ['pr', 'view', '79', '--repo', 'some-other/repo']);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /^gh_read_failed: scope_denied/);
    const unauthorized = await startFakeApi((_hit, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, code: 'capability_unavailable', retryable: false }));
    });
    writeLease(member, { url: `http://127.0.0.1:${unauthorized.port}/api/agent-github-read` });
    const stale = await run(wrapper, member, ['pr', 'view', '79', '--repo', '08mamba24/clowder-ai']);
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /^gh_read_failed: authentication_required/);
    for (const output of [denied.stdout + denied.stderr, stale.stdout + stale.stderr])
      assert.ok(!output.includes(TOKEN), 'token must never appear in wrapper output');
  });
});
