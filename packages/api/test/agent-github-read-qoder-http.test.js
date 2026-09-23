import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Fastify from 'fastify';
import { createAgentGitHubReader } from '../dist/infrastructure/github/agent-github-read.js';
import { AgentGitHubReadBroker } from '../dist/infrastructure/github/agent-github-read-capability.js';
import { agentGitHubReadRoutes } from '../dist/routes/agent-github-read.js';

test('Qoder HTTP MCP protocol carries only approved reads, audits denials and rejects a revoked attempt', async () => {
  const app = Fastify();
  let runnerCalls = 0;
  const audits = [];
  const broker = new AgentGitHubReadBroker({
    apiUrl: 'http://127.0.0.1:43210',
    ownerUserId: 'owner',
    resolvePrincipal: async (invocationId) => ({
      invocationId,
      userId: 'owner',
      catId: 'qoder-flash',
      threadId: 'thread',
    }),
    read: createAgentGitHubReader({
      ghPath: '/host/gh',
      cwd: '/host',
      baseEnv: {},
      runner: async () => {
        runnerCalls++;
        return { stdout: '[]', exitCode: 0 };
      },
    }),
    appendAudit: async (event) => {
      audits.push(event);
    },
  });
  const client = new Client({ name: 'qoder-http-contract', version: '1' });
  try {
    await app.register(agentGitHubReadRoutes, { broker });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const lease = await broker.open('child');
    assert.ok(lease);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/api/agent-github-read/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${lease.token}` } },
      }),
    );
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ['github_read'],
    );
    const call = (query) => client.callTool({ name: 'github_read', arguments: { query } });
    const query = { op: 'pr_list', repo: '08mamba24/clowder-ai', state: 'open', limit: 2 };
    const success = await call(query);
    assert.equal(success.isError, false, JSON.stringify(success));
    assert.equal(JSON.parse(success.content[0].text).ok, true);
    const denied = await call({ ...query, repo: 'stranger/private' });
    assert.equal(JSON.parse(denied.content[0].text).code, 'scope_denied');
    const unsupported = await call({ op: 'pr_create', repo: '08mamba24/clowder-ai' });
    assert.equal(unsupported.isError, true, 'write op dies in MCP schema before runner');
    assert.equal(runnerCalls, 1);
    assert.equal(audits.length, 2, 'successful query and scope denial both persist');
    lease.revoke();
    // The SDK stores HTTP status on code, separately from the response-body message.
    await assert.rejects(call(query), { code: 401, message: /"code":"capability_unavailable"/ });
    assert.equal(runnerCalls, 1);
    assert.ok(!JSON.stringify([success, denied, unsupported, audits]).includes(lease.token));
  } finally {
    await client.close();
    broker.close();
    await app.close();
  }
});
