import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createAgentGitHubReader } from '../dist/infrastructure/github/agent-github-read.js';
import { AgentGitHubReadBroker } from '../dist/infrastructure/github/agent-github-read-capability.js';
import { agentGitHubReadRoutes } from '../dist/routes/agent-github-read.js';

async function harness() {
  let calls = 0;
  const read = createAgentGitHubReader({
    ghPath: '/host/gh',
    cwd: '/host',
    baseEnv: {},
    runner: async () => {
      calls++;
      return { stdout: '[]', exitCode: 0 };
    },
  });
  const broker = new AgentGitHubReadBroker({
    apiUrl: 'http://127.0.0.1:43210',
    ownerUserId: 'owner',
    resolvePrincipal: async (id) =>
      id === 'real-child' ? { invocationId: id, userId: 'owner', catId: 'zcode', threadId: 'thread' } : null,
    read,
    appendAudit: async () => {},
  });
  const lease = await broker.open('real-child');
  assert.ok(lease);
  const app = Fastify();
  await app.register(agentGitHubReadRoutes, { broker });
  const headers = { authorization: `Bearer ${lease.token}` };
  const query = { op: 'pr_list', repo: '08mamba24/clowder-ai', state: 'open', limit: 5 };
  return { app, broker, lease, headers, query, calls: () => calls };
}
test('direct route rejects spoofed credentials and identity and accepts the narrow query', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  t.after(() => h.broker.close());
  for (const headers of [{}, { authorization: 'Bearer forged', 'x-cat-id': 'zcode', 'x-user-id': 'owner' }]) {
    const response = await h.app.inject({ method: 'POST', url: '/api/agent-github-read', headers, payload: h.query });
    assert.equal(response.statusCode, 401);
  }
  const denied = await h.app.inject({
    method: 'POST',
    url: '/api/agent-github-read',
    headers: h.headers,
    payload: { ...h.query, argv: ['auth', 'token'] },
  });
  assert.equal(denied.json().code, 'unsupported_query');
  assert.equal(h.calls(), 0);
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/agent-github-read',
    headers: h.headers,
    payload: h.query,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.equal(h.calls(), 1);
  h.lease.revoke();
  assert.equal(
    (await h.app.inject({ method: 'POST', url: '/api/agent-github-read', headers: h.headers, payload: h.query }))
      .statusCode,
    401,
  );
});
test('MCP exposes only one typed read tool and cannot invoke family callbacks or arbitrary operations', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  t.after(() => h.broker.close());
  const rpc = (method, params) =>
    h.app.inject({
      method: 'POST',
      url: '/api/agent-github-read/mcp',
      headers: { ...h.headers, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' },
      payload: { jsonrpc: '2.0', id: 1, method, params },
    });
  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(init.statusCode, 200);
  assert.deepEqual(init.json().result.capabilities, { tools: { listChanged: true } });
  const listed = await rpc('tools/list', {});
  assert.deepEqual(
    listed.json().result.tools.map((tool) => tool.name),
    ['github_read'],
  );
  assert.equal(
    listed.json().result.tools[0].inputSchema.properties.query.type,
    'object',
    'Qoder needs an explicit object type to marshal the nested query argument',
  );
  const foreign = await rpc('tools/call', { name: 'cat_cafe_post_message', arguments: { content: 'forged' } });
  assert.ok(foreign.json().error || foreign.json().result?.isError);
  const bad = await rpc('tools/call', { name: 'github_read', arguments: { query: { op: 'api', repo: h.query.repo } } });
  assert.ok(bad.json().error || bad.json().result?.isError);
  const wrongFields = await rpc('tools/call', {
    name: 'github_read',
    arguments: { query: { ...h.query, number: 48 } },
  });
  assert.equal(JSON.parse(wrongFields.json().result.content[0].text).code, 'unsupported_query');
  assert.equal(h.calls(), 0);
  const read = await rpc('tools/call', { name: 'github_read', arguments: { query: h.query } });
  assert.equal(read.json().result.isError, false);
  assert.equal(JSON.parse(read.json().result.content[0].text).ok, true);
  assert.equal(h.calls(), 1);
});
