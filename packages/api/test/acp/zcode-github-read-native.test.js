/** Installed native carrier, synthetic model/MCP only; never a real account or repository. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { NativeAppServer } from '../../dist/domains/cats/services/agents/providers/acp/zcode-acp-native.js';
import {
  parseTurnEvent,
  readZcodeSessionId,
  zcodeWorkspace,
} from '../../dist/domains/cats/services/agents/providers/acp/zcode-acp-protocol.js';

function syntheticMessage(res, model, toolName) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({
    type: 'message_start',
    message: {
      id: 'msg_synthetic',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 0 },
    },
  });
  if (toolName) {
    send({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'query_local', name: toolName, input: {} },
    });
    send({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ repo: '08mamba24/clowder-ai' }) },
    });
  } else {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LOCAL_QUERY_COMPLETE' } });
  }
  send({ type: 'content_block_stop', index: 0 });
  send({
    type: 'message_delta',
    delta: { stop_reason: toolName ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  send({ type: 'message_stop' });
  res.end();
}

async function turn(native, sessionId, content) {
  let unsubscribe = () => {};
  let timer;
  const terminal = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('native synthetic turn timed out')), 20000);
    unsubscribe = native.onEvent((event) => {
      const parsed = parseTurnEvent(event, sessionId);
      if (parsed?.terminal) resolve(parsed.terminal);
    });
  });
  try {
    const sent = await native.request('session/send', { sessionId, content }, 10000);
    assert.equal(sent.error, undefined, 'native must admit the synthetic turn');
    assert.equal(await terminal, 'completed');
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

function filesContaining(root, needles) {
  const hits = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) hits.push(...filesContaining(file, needles));
    else if (entry.isFile() && needles.some((needle) => readFileSync(file).includes(needle))) hits.push(file);
  }
  return hits;
}

it(
  'native HTTP MCP keeps attempt headers out of model/history/files and cold-resumes with a fresh header',
  { skip: process.env.CAT_CAFE_ZCODE_LIVE !== '1', timeout: 90000 },
  async (t) => {
    const bin = process.env.CAT_CAFE_ZCODE_BIN || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zcode-gh-read-native-')));
    const tokens = ['fake-ghread-attempt-A-canary', 'fake-ghread-attempt-B-canary'];
    const modelBodies = [];
    const mcpCalls = [];
    const clients = [];
    let activeToken = tokens[0];
    const server = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        if (req.url === '/v1/messages') {
          modelBodies.push(body);
          const latest = JSON.stringify(body.messages.at(-1));
          const tool = body.tools?.find((tool) => tool.name.includes('read_repository'));
          if (!tool) {
            syntheticMessage(res, body.model);
            return;
          } // Native title generation.
          assert.ok(tool, 'native model must see the narrow read tool');
          syntheticMessage(res, body.model, latest.includes('tool_result') ? undefined : tool.name);
          return;
        }
        if (req.headers.authorization !== `Bearer ${activeToken}`) {
          res.writeHead(401);
          res.end();
          return;
        }
        const mcp = new Server({ name: 'synthetic-read', version: '1' }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            {
              name: 'read_repository',
              description: 'Synthetic repository read',
              inputSchema: {
                type: 'object',
                properties: { repo: { type: 'string' } },
                required: ['repo'],
                additionalProperties: false,
              },
            },
          ],
        }));
        mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
          mcpCalls.push({ token: req.headers.authorization, query: request.params.arguments });
          return { content: [{ type: 'text', text: 'SYNTHETIC_REPO_RESULT' }] };
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        t.diagnostic(`synthetic handler: ${error.message}`);
        res.writeHead(500);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const env = {
      PATH: process.env.PATH,
      CAT_CAFE_ZCODE_HOME: join(dir, 'home'),
      HOME: dir,
      ZCODE_MODEL: 'GLM-5.3',
      ANTHROPIC_API_KEY: 'synthetic-model-key',
      ANTHROPIC_BASE_URL: `${origin}/v1`,
      NO_COLOR: '1',
    };
    const start = async () => {
      const native = new NativeAppServer(bin, env);
      clients.push(native);
      assert.equal((await native.request('session/list', { includeArchived: false }, 10000)).error, undefined);
      return native;
    };
    const config = (token) => [
      {
        name: 'clowder-read',
        type: 'http',
        url: `${origin}/mcp`,
        headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
        protocolVersion: 'legacy',
      },
    ];
    try {
      const first = await start();
      const created = await first.request(
        'session/create',
        { workspace: zcodeWorkspace(dir), mode: 'yolo', persistence: 'immediate', mcpServers: config(activeToken) },
        20000,
      );
      assert.equal(created.error, undefined, JSON.stringify(created.error));
      const sid = readZcodeSessionId(created.result);
      assert.ok(sid, 'native create returns a session');
      assert.equal(
        (
          await first.request('session/subscribe', {
            sessionId: sid,
            deliveryKind: 'desktop-continuous',
            includeSnapshot: true,
            afterSeq: 0,
          })
        ).error,
        undefined,
      );
      await turn(first, sid, 'Remember SYNTHETIC_HISTORY_MARKER and call read_repository.');
      assert.equal(mcpCalls.length, 1);
      assert.deepEqual(filesContaining(dir, tokens), [], 'headers must not be persisted while live');
      first.close();
      await first.whenExited();
      activeToken = tokens[1];
      const second = await start();
      const loaded = await second.request(
        'session/resume',
        { sessionId: sid, workspace: zcodeWorkspace(dir), mcpServers: config(activeToken) },
        20000,
      );
      assert.equal(loaded.error, undefined, JSON.stringify(loaded.error));
      assert.equal(
        (
          await second.request('session/subscribe', {
            sessionId: sid,
            deliveryKind: 'desktop-continuous',
            includeSnapshot: true,
            afterSeq: 0,
          })
        ).error,
        undefined,
      );
      await turn(second, sid, 'Call read_repository again after cold resume.');
      assert.equal(mcpCalls.length, 2);
      assert.equal(mcpCalls[1].token, `Bearer ${tokens[1]}`);
      assert.match(JSON.stringify(modelBodies.at(-1).messages), /SYNTHETIC_HISTORY_MARKER/);
      for (const token of tokens) assert.ok(!JSON.stringify(modelBodies).includes(token));
      second.close();
      await second.whenExited();
      assert.deepEqual(filesContaining(dir, tokens), [], 'headers must not be in logs, SQLite/WAL, state or history');
      t.diagnostic(
        `native sha256=${createHash('sha256').update(readFileSync(bin)).digest('hex')}; ${mcpCalls.length} synthetic tool calls; evidence=${dir}`,
      );
    } finally {
      for (const native of clients) {
        native.close();
        await native.whenExited();
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
