// @ts-check

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const adapterPath = join(__dirname, '../../dist/domains/cats/services/agents/providers/acp/zcode-acp-adapter.js');
const fakeBin = join(__dirname, 'helpers/fake-zcode-app-server.mjs');

const {
  diagnoseZcodeSpawnReady,
  extractZcodeFailure,
  formatZcodeTurnFailure,
  parseTurnEvent,
  sanitizeZcodeFailureText,
} = await import('../../dist/domains/cats/services/agents/providers/acp/zcode-acp-protocol.js');

function startAdapter(dir) {
  const child = spawn(process.execPath, [adapterPath], {
    cwd: dir,
    env: {
      ...process.env,
      ZCODE_BIN: fakeBin,
      ZCODE_FAKE_STORE: join(dir, 'store.json'),
      ZCODE_FAKE_LOG: join(dir, 'rpc.log'),
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const updates = [];
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.method === 'session/update') {
      updates.push(msg);
      return;
    }
    if (msg.id != null && pending.has(String(msg.id))) {
      pending.get(String(msg.id))(msg);
      pending.delete(String(msg.id));
    }
  });
  let nextId = 1;
  function request(method, params, timeoutMs = 8000) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
      pending.set(String(id), (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }
  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  function rpcLog() {
    try {
      return readFileSync(join(dir, 'rpc.log'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
  return { child, request, notify, updates, rpcLog };
}

function assistantText(updates, sessionId) {
  return updates
    .filter((u) => u.params?.sessionId === sessionId)
    .map((u) => u.params?.update?.content?.text)
    .filter((text) => typeof text === 'string')
    .join('');
}

describe('ZCode ACP adapter contract (fake app-server)', () => {
  it('initialize / session/new / prompt returns PONG with end_turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-prompt-'));
    const acp = startAdapter(dir);
    try {
      const init = await acp.request('initialize', { protocolVersion: 1 });
      assert.equal(init.result.agentCapabilities.loadSession, true);
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
      const sessionId = created.result.sessionId;
      const prompted = await acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Reply PONG' }],
      });
      assert.equal(prompted.error, undefined);
      assert.equal(prompted.result.stopReason, 'end_turn');
      assert.equal(assistantText(acp.updates, sessionId), 'PONG');
    } finally {
      acp.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('session/cancel becomes a native session/stop request with id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-cancel-'));
    const acp = startAdapter(dir);
    try {
      await acp.request('initialize', { protocolVersion: 1 });
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
      const sessionId = created.result.sessionId;
      const prompt = acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'SLEEP_TURN' }],
      });
      await new Promise((r) => setTimeout(r, 80));
      acp.notify('session/cancel', { sessionId });
      const prompted = await prompt;
      assert.equal(prompted.result.stopReason, 'cancelled');
      const stop = acp.rpcLog().find((row) => row.method === 'session/stop');
      assert.ok(stop, 'native session/stop must be recorded');
      assert.notEqual(stop.id, null);
      assert.notEqual(stop.id, undefined);
    } finally {
      acp.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('session/load keeps history in-process and after adapter restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-load-'));
    const first = startAdapter(dir);
    let sessionId;
    try {
      await first.request('initialize', { protocolVersion: 1 });
      const created = await first.request('session/new', { cwd: dir, mcpServers: [] });
      sessionId = created.result.sessionId;
      const round1 = await first.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'remember TOKEN_A' }],
      });
      assert.equal(round1.result.stopReason, 'end_turn');
      assert.match(assistantText(first.updates, sessionId), /TOKEN_A/);
      const loaded = await first.request('session/load', { sessionId, cwd: dir, mcpServers: [] });
      assert.equal(loaded.result.sessionId, sessionId);
      const afterLoad = first.updates.length;
      const round2 = await first.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'what was the token?' }],
      });
      assert.equal(round2.error, undefined);
      assert.equal(round2.result.stopReason, 'end_turn');
      assert.match(assistantText(first.updates.slice(afterLoad), sessionId), /TOKEN_A/);
    } finally {
      first.child.kill('SIGTERM');
    }

    const second = startAdapter(dir);
    try {
      await second.request('initialize', { protocolVersion: 1 });
      const loaded = await second.request('session/load', { sessionId, cwd: dir, mcpServers: [] });
      assert.equal(loaded.error, undefined, JSON.stringify(loaded.error));
      assert.equal(loaded.result.sessionId, sessionId);
      const beforeRestartPrompt = second.updates.length;
      const round3 = await second.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'what was the token after restart?' }],
      });
      assert.equal(round3.error, undefined);
      assert.match(assistantText(second.updates.slice(beforeRestartPrompt), sessionId), /TOKEN_A/);
    } finally {
      second.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turn.failed becomes a sanitized ACP error, not empty refusal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-fail-'));
    const acp = startAdapter(dir);
    try {
      await acp.request('initialize', { protocolVersion: 1 });
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
      const prompted = await acp.request('session/prompt', {
        sessionId: created.result.sessionId,
        prompt: [{ type: 'text', text: 'FAIL_SECRET' }],
      });
      assert.ok(prompted.error, 'turn.failed must be an ACP error');
      assert.notEqual(prompted.result?.stopReason, 'refusal');
      const message = String(prompted.error.message);
      assert.match(message, /MISSING_CREDENTIAL/);
      assert.match(message, /provider rejected/);
      assert.doesNotMatch(message, /ZCode turn failed/);
      assert.doesNotMatch(message, /sk-secret-LIVEKEY99/);
      assert.doesNotMatch(message, /supersecret/);
      assert.doesNotMatch(message, /Bearer abc\.def\.ghi/);
    } finally {
      acp.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readiness requires ZCODE_MODEL and a provider key without using ZCODE_BASE_URL', () => {
    const missingModel = diagnoseZcodeSpawnReady({ ANTHROPIC_API_KEY: 'sk-test' });
    assert.equal(missingModel.ok, false);
    if (!missingModel.ok) assert.match(missingModel.error.message, /ZCODE_MODEL/);

    const missingKey = diagnoseZcodeSpawnReady({ ZCODE_MODEL: 'GLM-5.2' });
    assert.equal(missingKey.ok, false);
    if (!missingKey.ok) {
      assert.match(missingKey.error.message, /ANTHROPIC_API_KEY/);
      assert.doesNotMatch(missingKey.error.message, /cli\/config\.json to make/);
    }

    const ready = diagnoseZcodeSpawnReady({ ZCODE_MODEL: 'GLM-5.2', ANTHROPIC_API_KEY: 'sk-test' });
    assert.equal(ready.ok, true);

    const leaked = formatZcodeTurnFailure({
      code: 'MISSING_CREDENTIAL',
      message: 'bad sk-secret-LIVEKEY99 ANTHROPIC_API_KEY=supersecret',
    });
    assert.match(leaked, /MISSING_CREDENTIAL/);
    assert.doesNotMatch(leaked, /sk-secret-LIVEKEY99/);
    assert.doesNotMatch(leaked, /supersecret/);
    assert.equal(sanitizeZcodeFailureText('Bearer abc.def').includes('abc.def'), false);
    assert.doesNotMatch(sanitizeZcodeFailureText('{"api_key":"dummy-short-secret"}'), /dummy-short-secret/);
    assert.doesNotMatch(sanitizeZcodeFailureText('{"ZCODE_API_KEY":"dummy-zcode-key"}'), /dummy-zcode-key/);
    assert.doesNotMatch(sanitizeZcodeFailureText('{"ANTHROPIC_API_KEY":"dummy-anthropic-key"}'), /dummy-anthropic-key/);
    assert.doesNotMatch(sanitizeZcodeFailureText('{"x-api-key":"dummy-x-api-key"}'), /dummy-x-api-key/);
    const unstructured = extractZcodeFailure({ api_key: 'dummy-short-secret', nested: true });
    assert.equal(unstructured.message, undefined);
    assert.doesNotMatch(formatZcodeTurnFailure(unstructured), /dummy-short-secret/);
  });

  it('maps ZCode 0.16.3 turn envelopes, not invented event names', () => {
    const sid = 'sess_1';
    const cancelled = parseTurnEvent(
      {
        method: 'session/event',
        params: { sessionId: sid, type: 'turn.completed', payload: { resultType: 'cancelled' } },
      },
      sid,
    );
    assert.equal(cancelled?.terminal, 'cancelled');
    const success = parseTurnEvent(
      {
        method: 'session/event',
        params: { sessionId: sid, type: 'turn.completed', payload: { resultType: 'success' } },
      },
      sid,
    );
    assert.equal(success?.terminal, 'completed');
    const failed = parseTurnEvent(
      {
        method: 'session/event',
        params: {
          sessionId: sid,
          type: 'turn.failed',
          payload: { error: { type: 'MISSING_CREDENTIAL', message: 'nope' }, turnPhase: 'model' },
        },
      },
      sid,
    );
    assert.equal(failed?.terminal, 'failed');
    assert.equal(failed?.failure?.code, 'MISSING_CREDENTIAL');
    assert.equal(failed?.failure?.message, 'nope');
    const flatCheat = parseTurnEvent(
      {
        method: 'session/event',
        params: { sessionId: sid, type: 'turn.failed', payload: { code: 'MISSING_CREDENTIAL', message: 'nope' } },
      },
      sid,
    );
    assert.equal(flatCheat?.failure?.code, undefined);
    assert.equal(flatCheat?.failure?.message, undefined);
    const invented = parseTurnEvent(
      { method: 'session/event', params: { sessionId: sid, type: 'turn.cancelled', payload: {} } },
      sid,
    );
    assert.equal(invented, undefined);
  });
});
