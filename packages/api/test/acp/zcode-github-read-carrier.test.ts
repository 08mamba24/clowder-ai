import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpAgentService } from '../../src/domains/cats/services/agents/providers/acp/AcpAgentService.js';

test('ZCode sends only the attempt read header over ACP and revokes it before releasing the carrier', async () => {
  const events: string[] = [];
  const requests: unknown[] = [];
  const fakeLease = {
    token: 'a'.repeat(43),
    queryUrl: 'http://127.0.0.1:43210/api/agent-github-read',
    mcpUrl: 'http://127.0.0.1:43210/api/agent-github-read/mcp',
    revoke: () => events.push('revoke'),
  };
  const client = {
    onCapacity() {},
    offCapacity() {},
    cancelSession() {},
    clearRecentCapacitySignal() {},
    async newSession(_cwd: string, servers: unknown[]) {
      requests.push(servers);
      return { sessionId: 'native-session' };
    },
    async loadSession(_id: string, _cwd: string, servers: unknown[]) {
      requests.push(servers);
      return { sessionId: 'native-session' };
    },
    async *promptStream(_id: string, text: string) {
      assert.ok(!text.includes(fakeLease.token));
      yield { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } };
    },
  };
  const pool = { acquire: async () => ({ client, release: () => events.push('release') }), rememberSession() {} };
  const service = new AcpAgentService({
    catId: 'zcode' as never,
    pool: pool as never,
    poolKey: { projectPath: '/tmp', providerProfile: 'test' },
    projectRoot: '/tmp',
    mcpSupport: false,
    omitSessionMcpServers: true,
    isolatedGitHubRead: true,
    mcpServers: [{ name: 'cat-cafe', command: '/never/family', args: [], env: [] }],
  });
  for (const sessionId of [undefined, 'native-session']) {
    const messages = [];
    for await (const message of service.invoke('read a PR', { sessionId, openGitHubReadLease: async () => fakeLease }))
      messages.push(message);
    assert.ok(!messages.some((message) => message.type === 'error'), JSON.stringify(messages));
  }
  assert.equal(requests.length, 2);
  for (const request of requests)
    assert.deepEqual(request, [
      {
        name: 'clowder-repository-read',
        type: 'http',
        url: fakeLease.mcpUrl,
        headers: [{ name: 'Authorization', value: `Bearer ${fakeLease.token}` }],
      },
    ]);
  assert.deepEqual(events, ['revoke', 'release', 'revoke', 'release']);
});
