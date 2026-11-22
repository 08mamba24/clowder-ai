import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';

test('ZCode hands the attempt lease to the gh carrier file, attaches no MCP, and revokes on release', async () => {
  const events = [];
  const requests = [];
  const leaseHome = mkdtempSync(join(tmpdir(), 'zcode-carrier-'));
  const previousHome = process.env.CAT_CAFE_ZCODE_HOME;
  process.env.CAT_CAFE_ZCODE_HOME = leaseHome;
  const fakeLease = {
    token: 'a'.repeat(43),
    queryUrl: 'http://127.0.0.1:43210/api/agent-github-read',
    mcpUrl: 'http://127.0.0.1:43210/api/agent-github-read/mcp',
    revoke: () => events.push('revoke'),
  };
  const leasePath = join(leaseHome, '.cat-cafe-gh-read-lease.json');
  const observedDuringPrompt = [];
  const client = {
    onCapacity() {},
    offCapacity() {},
    cancelSession() {},
    clearRecentCapacitySignal() {},
    async newSession(_cwd, servers) {
      requests.push(servers);
      return { sessionId: 'native-session' };
    },
    async loadSession(_id, _cwd, servers) {
      requests.push(servers);
      return { sessionId: 'native-session' };
    },
    async *promptStream(_id, text) {
      assert.ok(!text.includes(fakeLease.token));
      observedDuringPrompt.push(existsSync(leasePath) ? readFileSync(leasePath, 'utf8') : null);
      yield { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } };
    },
  };
  const pool = { acquire: async () => ({ client, release: () => events.push('release') }), rememberSession() {} };
  const service = new AcpAgentService({
    catId: 'zcode',
    pool: pool,
    poolKey: { projectPath: tmpdir(), providerProfile: 'test' },
    projectRoot: tmpdir(),
    mcpSupport: false,
    omitSessionMcpServers: true,
    isolatedGitHubRead: true,
    mcpServers: [{ name: 'cat-cafe', command: '/never/family', args: [], env: [] }],
  });
  try {
    for (const sessionId of [undefined, 'native-session']) {
      const messages = [];
      for await (const message of service.invoke('read a PR', {
        sessionId,
        openGitHubReadLease: async () => fakeLease,
      }))
        messages.push(message);
      assert.ok(!messages.some((message) => message.type === 'error'), JSON.stringify(messages));
      // The lease file is cleared when the attempt releases its lease, even on
      // the happy path, so a stale capability never outlives the turn.
      assert.ok(!existsSync(leasePath), `lease file must be cleared after the attempt: ${sessionId ?? 'fresh'}`);
    }
  } finally {
    if (previousHome === undefined) delete process.env.CAT_CAFE_ZCODE_HOME;
    else process.env.CAT_CAFE_ZCODE_HOME = previousHome;
    rmSync(leaseHome, { recursive: true, force: true });
  }
  assert.equal(requests.length, 2);
  for (const request of requests) assert.deepEqual(request, []);
  for (const snapshot of observedDuringPrompt) {
    assert.ok(snapshot, 'lease file must exist while the prompt runs');
    const stored = JSON.parse(snapshot);
    assert.deepEqual(stored, { url: fakeLease.queryUrl, token: fakeLease.token });
  }
  assert.deepEqual(events, ['revoke', 'release', 'revoke', 'release']);
});
