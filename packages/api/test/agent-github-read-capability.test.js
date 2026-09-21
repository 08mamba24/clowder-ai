import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentGitHubReader } from '../dist/infrastructure/github/agent-github-read.js';
import { AgentGitHubReadBroker } from '../dist/infrastructure/github/agent-github-read-capability.js';

const principal = { invocationId: 'child-1', userId: 'owner', catId: 'zcode', threadId: 'thread-1' };
const query = { op: 'pr_diff', repo: '08mamba24/clowder-ai', number: 41 };
function harness() {
  const records = new Map([[principal.invocationId, { ...principal }]]);
  const audit = [];
  let calls = 0;
  const reader = createAgentGitHubReader({
    ghPath: '/host/gh',
    cwd: '/host',
    baseEnv: {},
    runner: async (_file, args) => {
      calls++;
      return {
        stdout:
          args[1] === 'diff' ? 'fake diff' : JSON.stringify({ headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40) }),
        exitCode: 0,
      };
    },
  });
  const options = {
    apiUrl: 'http://127.0.0.1:43210',
    ownerUserId: 'owner',
    resolvePrincipal: async (id) => records.get(id) ?? null,
    read: reader,
    appendAudit: async (entry) => {
      audit.push(entry);
    },
  };
  const broker = new AgentGitHubReadBroker(options);
  return { broker, records, audit, options, calls: () => calls };
}
test('only host-admitted owner and the exact enabled cats obtain a scoped lease', async () => {
  const h = harness();
  for (const change of [{ userId: 'other' }, { catId: 'qoder' }, { catId: 'astra' }, { invocationId: 'parent-1' }]) {
    h.records.set('child-1', { ...principal, ...change });
    assert.equal(await h.broker.open('child-1'), null);
  }
  assert.equal(await h.broker.open('absent'), null);
  h.records.set('child-1', principal);
  const lease = await h.broker.open('child-1');
  assert.ok(lease);
  assert.equal((await h.broker.query(lease.token, query)).ok, true);
  assert.equal(h.calls(), 3);
  assert.equal((await h.broker.query(lease.token, { ...query, repo: 'other/private' })).code, 'scope_denied');
  assert.equal((await h.broker.query(lease.token, { ...query, catId: 'astra' })).code, 'unsupported_query');
  assert.equal(h.calls(), 3);
  assert.ok(!JSON.stringify(h.audit).includes(lease.token));
  assert.ok(!JSON.stringify(h.audit).includes('host-secret'));
  h.broker.close();
});
test('revocation, attempt replacement and restart cannot refresh old grants', async () => {
  const h = harness();
  const first = await h.broker.open('child-1');
  assert.ok(first);
  const second = await h.broker.open('child-1');
  assert.ok(second);
  assert.notEqual(first.token, second.token);
  assert.equal(await h.broker.authenticate(first.token), false);
  assert.equal(await h.broker.authenticate(second.token), true);
  const restarted = new AgentGitHubReadBroker(h.options);
  assert.equal(await restarted.authenticate(second.token), false);
  second.revoke();
  assert.equal(await h.broker.authenticate(second.token), false);
  assert.equal((await h.broker.query(second.token, query)).ok, false);
  assert.equal(h.calls(), 0);
});
test('canonical terminal or changed ownership invalidates even an otherwise live transport', async () => {
  for (const terminal of [
    null,
    { ...principal, threadId: 'foreign' },
    { ...principal, userId: 'other' },
    { ...principal, catId: 'qoder-flash' },
  ]) {
    const h = harness();
    const lease = await h.broker.open('child-1');
    assert.ok(lease);
    if (terminal) h.records.set('child-1', terminal);
    else h.records.delete('child-1');
    assert.equal((await h.broker.query(lease.token, query)).ok, false);
    assert.equal(h.calls(), 0);
    h.broker.close();
  }
});
test('abort revokes the grant and terminates in-flight query authority', async () => {
  const h = harness();
  const abort = new AbortController();
  const lease = await h.broker.open('child-1', abort.signal);
  assert.ok(lease);
  abort.abort();
  assert.equal(await h.broker.authenticate(lease.token), false);
  assert.equal(await h.broker.open('child-1', abort.signal), null);
});
test('durable audit failure withholds success and late revocation withholds data', async () => {
  const h = harness();
  for (const appendAudit of [
    async () => {
      throw new Error('disk unavailable');
    },
    async () => {
      h.records.delete('child-1');
    },
  ]) {
    h.records.set('child-1', principal);
    const broker = new AgentGitHubReadBroker({ ...h.options, appendAudit });
    const lease = await broker.open('child-1');
    assert.ok(lease);
    const result = await broker.query(lease.token, query);
    assert.equal(result.ok, false);
    assert.ok(!('data' in result));
    broker.close();
  }
});
