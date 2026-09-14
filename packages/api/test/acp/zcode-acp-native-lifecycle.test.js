/** Real installed CLI + local deterministic Anthropic transport, never a real credential/model call. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { assistantText, startAdapter } from './helpers/zcode-acp-test-harness.mjs';

async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(25);
  }
}

async function stop(acp) {
  if (acp.child.exitCode !== null || acp.child.signalCode !== null) return;
  const exited = once(acp.child, 'exit');
  acp.child.kill('SIGTERM');
  await exited;
}

it(
  'native CLI generates, cancels upstream, continues, cold-resumes history and isolates parallel sessions',
  {
    skip: process.env.CAT_CAFE_ZCODE_LIVE !== '1',
    timeout: 90000,
  },
  async (t) => {
    const bin = process.env.CAT_CAFE_ZCODE_BIN || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
    t.diagnostic(
      `node=${process.version}; native sha256=${createHash('sha256').update(readFileSync(bin)).digest('hex')}; provider=local synthetic SSE`,
    );
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zcode-native-lifecycle-')));
    const requests = [];
    const concurrentResponses = [];
    let slowClosed = false;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const users = body.messages.filter((message) => message.role === 'user');
      const latest = JSON.stringify(users.at(-1)?.content);
      const slow = latest.includes('SLOW_CURRENT_TURN');
      requests.push({ body, latest, slow, path: req.url, key: req.headers['x-api-key'], port: req.socket.localPort });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({
        type: 'message_start',
        message: {
          id: 'msg_local_test',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      });
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: slow ? 'WAITING' : 'LOCAL_PONG' },
      });
      if (slow) {
        const timer = setInterval(() => res.write(': keepalive\n\n'), 100);
        res.on('close', () => {
          clearInterval(timer);
          slowClosed = true;
        });
        return;
      }
      const finish = () => {
        send({ type: 'content_block_stop', index: 0 });
        send({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        });
        send({ type: 'message_stop' });
        res.end();
      };
      if (latest.includes('ACCOUNT_CONCURRENT')) {
        concurrentResponses.push(finish);
        if (concurrentResponses.length === 2) for (const respond of concurrentResponses) respond();
      } else finish();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const secondServer = createServer(server.listeners('request')[0]);
    secondServer.listen(0, '127.0.0.1');
    await once(secondServer, 'listening');
    const env = {
      ZCODE_BIN: bin,
      ZCODE_MODEL: 'GLM-5.3',
      ANTHROPIC_API_KEY: 'dummy-local-test-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      ZCODE_REQUEST_TIMEOUT_MS: '15000',
    };
    const clients = [];
    const start = async (extra = {}) => {
      const client = startAdapter(dir, { ...env, ...extra });
      clients.push(client);
      const init = await client.request('initialize', { protocolVersion: 1 });
      assert.equal(init.error, undefined, JSON.stringify(init));
      return client;
    };
    const create = async (client) => {
      const result = await client.request('session/new', { cwd: dir, mcpServers: [] });
      assert.equal(result.error, undefined, JSON.stringify(result));
      return result.result.sessionId;
    };
    const prompt = (client, sessionId, text) =>
      client.request(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text }],
        },
        20000,
      );
    try {
      const first = await start();
      const sid = await create(first);
      assert.equal((await prompt(first, sid, 'Remember HISTORY_MARKER_A and reply.')).result?.stopReason, 'end_turn');
      assert.match(assistantText(first.updates, sid), /LOCAL_PONG/);
      assert.equal(requests.at(-1).body.model, 'GLM-5.3');
      assert.equal(requests.at(-1).path, '/v1/messages');
      assert.equal(requests.at(-1).key, 'dummy-local-test-key');
      const slow = prompt(first, sid, 'SLOW_CURRENT_TURN');
      await until(() => requests.some((request) => request.slow), 'slow provider request never started');
      first.notify('session/cancel', { sessionId: sid });
      assert.equal((await slow).result?.stopReason, 'cancelled');
      await until(() => slowClosed, 'cancel did not close the upstream response');
      assert.equal((await prompt(first, sid, 'Continue after cancellation.')).result?.stopReason, 'end_turn');
      await stop(first);
      assert.equal(
        readdirSync(first.isolatedHome).some((file) => file.startsWith('.provider-runtime-')),
        false,
      );
      const resumed = await start();
      const loaded = await resumed.request('session/load', { sessionId: sid, cwd: dir, mcpServers: [] });
      assert.equal(loaded.error, undefined, JSON.stringify(loaded));
      const continued = await prompt(resumed, sid, 'Continue after process restart.');
      assert.equal(continued.result?.stopReason, 'end_turn', JSON.stringify(continued));
      assert.match(JSON.stringify(requests.at(-1).body.messages), /HISTORY_MARKER_A/);
      const otherId = await create(resumed);
      const both = await Promise.all([
        prompt(resumed, sid, 'SESSION_A_ONLY'),
        prompt(resumed, otherId, 'SESSION_B_ONLY'),
      ]);
      for (const result of both) assert.equal(result.result?.stopReason, 'end_turn', JSON.stringify(result));
      const otherRequest = requests.find((request) => request.latest.includes('SESSION_B_ONLY'));
      assert.ok(otherRequest);
      assert.doesNotMatch(JSON.stringify(otherRequest.body.messages), /HISTORY_MARKER_A|SESSION_A_ONLY/);
      const alternateEnv = {
        ANTHROPIC_API_KEY: 'dummy-second-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${secondServer.address().port}/v1`,
      };
      const alternate = await start(alternateEnv);
      const alternateId = await create(alternate);
      const accountTurns = await Promise.all([
        prompt(resumed, sid, 'ACCOUNT_CONCURRENT_A'),
        prompt(alternate, alternateId, 'ACCOUNT_CONCURRENT_B'),
      ]);
      for (const result of accountTurns) assert.equal(result.result?.stopReason, 'end_turn', JSON.stringify(result));
      const accountA = requests.find((request) => request.latest.includes('ACCOUNT_CONCURRENT_A'));
      const accountB = requests.find((request) => request.latest.includes('ACCOUNT_CONCURRENT_B'));
      assert.equal(accountA.body.model, 'GLM-5.3');
      assert.equal(accountB.body.model, 'GLM-5.3');
      assert.equal(accountA.key, 'dummy-local-test-key');
      assert.equal(accountB.key, 'dummy-second-key');
      assert.equal(accountA.port, server.address().port);
      assert.equal(accountB.port, secondServer.address().port);
      assert.doesNotMatch(JSON.stringify(accountB.body.messages), /HISTORY_MARKER_A|SESSION_A_ONLY/);
      await stop(alternate);
      await stop(resumed);
      for (const [restoreId, restoreEnv, marker, absent] of [
        [sid, {}, 'HISTORY_MARKER_A', 'ACCOUNT_CONCURRENT_B'],
        [alternateId, alternateEnv, 'ACCOUNT_CONCURRENT_B', 'HISTORY_MARKER_A'],
      ]) {
        const restored = await start(restoreEnv);
        const loaded = await restored.request('session/load', { sessionId: restoreId, cwd: dir, mcpServers: [] });
        assert.equal(loaded.error, undefined, JSON.stringify(loaded));
        assert.equal((await prompt(restored, restoreId, 'Cold restore this account.')).result?.stopReason, 'end_turn');
        const request = requests.at(-1);
        assert.ok(JSON.stringify(request.body.messages).includes(marker));
        assert.ok(!JSON.stringify(request.body.messages).includes(absent));
        assert.equal(request.key, restoreEnv.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY);
        await stop(restored);
      }
      const switched = await start({ ZCODE_MODEL: 'GLM-5.4' });
      const switchedLoad = await switched.request('session/load', { sessionId: sid, cwd: dir, mcpServers: [] });
      assert.equal(switchedLoad.error, undefined, JSON.stringify(switchedLoad));
      const switchedTurn = await prompt(switched, sid, 'Continue with the newly configured model.');
      assert.equal(switchedTurn.result?.stopReason, 'end_turn', JSON.stringify(switchedTurn));
      assert.equal(requests.at(-1).body.model, 'GLM-5.4');
      t.diagnostic(`verified ${requests.length} local requests; evidence home=${dir}`);
    } finally {
      for (const client of clients) await stop(client);
      server.closeAllConnections();
      secondServer.closeAllConnections();
      await new Promise((resolve) => secondServer.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
