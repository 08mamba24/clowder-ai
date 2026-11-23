import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { readAcpImageBlocks } from '../../dist/domains/cats/services/agents/providers/acp/acp-image-input.js';
import { assistantText, ZCODE_TEST_PNG as PNG, startAdapter } from './helpers/zcode-acp-test-harness.mjs';

it(
  'uploaded image traverses ACP adapter and real ZCode to a fake provider with identical bytes',
  {
    skip: process.env.CAT_CAFE_ZCODE_LIVE !== '1',
    timeout: 60000,
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-image-live-'));
    const captures = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      const images = (body.messages ?? [])
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((block) => block.type === 'image');
      captures.push(images.map((image) => image.source?.data));
      const message = {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'PONG' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(message));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      emit('message_start', { message: { ...message, content: [], stop_reason: null } });
      emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'PONG' } });
      emit('content_block_stop', { index: 0 });
      emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      emit('message_stop', {});
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const acp = startAdapter(dir, {
      ZCODE_BIN: '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
      ZCODE_MODEL: 'glm-5.4',
      ANTHROPIC_API_KEY: 'dummy-image-live-not-a-secret',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    });
    try {
      const init = await acp.request('initialize', { protocolVersion: 1 }, 20000);
      assert.equal(init.error, undefined);
      assert.equal(init.result.agentCapabilities.promptCapabilities.image, true);
      const session = await acp.request('session/new', { cwd: dir, mcpServers: [] }, 25000);
      assert.equal(session.error, undefined, JSON.stringify(session.error));
      writeFileSync(join(dir, 'probe.png'), Buffer.from(PNG, 'base64'));
      const blocks = await readAcpImageBlocks(
        [{ type: 'image', url: '/uploads/probe.png' }],
        init.result.agentCapabilities.promptCapabilities,
        undefined,
        dir,
      );
      const out = await acp.request(
        'session/prompt',
        {
          sessionId: session.result.sessionId,
          prompt: [{ type: 'text', text: 'Reply PONG. Do not use tools.' }, ...blocks],
        },
        25000,
      );
      assert.equal(out.error, undefined, JSON.stringify(out.error));
      assert.ok(captures.some((images) => images.length === 1 && images[0] === PNG));
      assert.equal(assistantText(acp.updates, session.result.sessionId), 'PONG');
      const loaded = await acp.request(
        'session/load',
        {
          sessionId: session.result.sessionId,
          cwd: dir,
          mcpServers: [],
        },
        20000,
      );
      assert.equal(loaded.error, undefined, JSON.stringify(loaded.error));
      const before = acp.updates.length;
      const resumed = await acp.request(
        'session/prompt',
        {
          sessionId: session.result.sessionId,
          prompt: [{ type: 'text', text: 'Reply PONG again. Do not use tools.' }, ...blocks],
        },
        25000,
      );
      assert.equal(resumed.error, undefined, `${JSON.stringify(resumed.error)} ${acp.stderr()}`);
      assert.ok(captures.some((images) => images.length === 2 && images.every((data) => data === PNG)));
      assert.equal(assistantText(acp.updates.slice(before), session.result.sessionId), 'PONG');
    } finally {
      acp.child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => acp.child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
