#!/usr/bin/env node
/**
 * Native ZCode 0.16.3-shaped app-server fake for adapter contract tests.
 * No jsonrpc field. session/stop is a request (requires id).
 * Events include eventId/seq/timestamp. Results are snapshots, not {ok:true}.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

const isolatedHome = process.env.HOME;
const storePath = process.env.ZCODE_FAKE_STORE ?? join(isolatedHome ?? '', '.zcode', 'cli', 'sessions.json');
const logPath = process.env.ZCODE_FAKE_LOG;
const sessions = new Map();
if (storePath) {
  try {
    const saved = JSON.parse(readFileSync(storePath, 'utf8'));
    for (const [id, rec] of Object.entries(saved)) sessions.set(id, rec);
  } catch {
    /* empty store */
  }
}

if (isolatedHome) {
  mkdirSync(join(isolatedHome, '.zcode', 'cli'), { recursive: true });
  writeFileSync(join(isolatedHome, '.zcode', 'cli', 'hub-isolation-canary'), 'ok');
}

process.stderr.write('{"api_key":"stderr-secret-key"}\n');

function persist() {
  if (!storePath) return;
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(Object.fromEntries(sessions), null, 2));
}

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function logRpc(msg) {
  if (!logPath) return;
  appendFileSync(
    logPath,
    `${JSON.stringify({
      id: msg.id ?? null,
      method: msg.method ?? null,
      model: msg.params?.model ?? msg.params?.runtimeModel?.model ?? null,
      decision: msg.decision ?? null,
      home: isolatedHome ?? null,
    })}\n`,
  );
}

function emit(sessionId, type, payload = {}) {
  const rec = sessions.get(sessionId);
  rec.seq = (rec.seq ?? 0) + 1;
  const envelope = {
    eventId: `evt_${rec.seq}`,
    sessionId,
    seq: rec.seq,
    timestamp: Date.now(),
    deliveryKind: 'desktop-continuous',
    type,
    payload,
  };
  rec.events = rec.events ?? [];
  rec.events.push({ eventId: envelope.eventId, seq: envelope.seq, timestamp: envelope.timestamp, type });
  persist();
  write({ method: 'session/event', params: envelope });
}

function historyText(rec) {
  return rec.history.map((h) => h.text).join('\n');
}

function readModel(params) {
  const model = params?.model ?? params?.runtimeModel?.model;
  if (!model || typeof model !== 'object') return undefined;
  const providerId = typeof model.providerId === 'string' ? model.providerId.trim() : '';
  const modelId = typeof model.modelId === 'string' ? model.modelId.trim() : '';
  if (!providerId || !modelId) return undefined;
  const variant = typeof model.variant === 'string' && model.variant.trim() ? model.variant.trim() : undefined;
  return variant ? { providerId, modelId, variant } : { providerId, modelId };
}

function snapshot(sessionId) {
  return {
    session: { sessionId },
    protocol: { name: 'zcode', version: '0.16.3' },
  };
}

const inflight = new Map();
const permissionWaiters = new Map();

async function handle(msg) {
  logRpc(msg);
  const method = msg.method;
  const id = msg.id;
  const params = msg.params ?? {};
  if (method === 'session/create') {
    const model = readModel(params);
    if (!model) {
      write({ id, error: { code: -32602, message: 'model must be {providerId,modelId}' } });
      return;
    }
    const sessionId = `sess_${sessions.size + 1}`;
    sessions.set(sessionId, {
      history: [],
      cwd: params.workspace?.workspacePath ?? '',
      model,
      seq: 0,
      events: [],
    });
    persist();
    write({ id, result: snapshot(sessionId) });
    return;
  }
  if (method === 'session/resume') {
    const rec = sessions.get(params.sessionId);
    if (!rec) {
      write({ id, error: { code: -32004, message: `Session not found: ${params.sessionId}` } });
      return;
    }
    const model = readModel(params);
    if (model) rec.model = model;
    persist();
    write({ id, result: snapshot(params.sessionId) });
    return;
  }
  if (method === 'session/setModel') {
    const rec = sessions.get(params.sessionId);
    if (!rec) {
      write({ id, error: { code: -32004, message: `Session not found: ${params.sessionId}` } });
      return;
    }
    const model = readModel(params);
    if (!model) {
      write({ id, error: { code: -32602, message: 'model must be {providerId,modelId}' } });
      return;
    }
    rec.model = model;
    persist();
    write({ id, result: { sessionId: params.sessionId, changed: true } });
    return;
  }
  if (method === 'session/subscribe') {
    const rec = sessions.get(params.sessionId);
    write({
      id,
      result: { sessionId: params.sessionId, eventSeq: rec?.seq ?? 0, events: [] },
    });
    return;
  }
  if (method === 'session/stop') {
    const pending = inflight.get(params.sessionId);
    if (pending) pending.abort();
    write({ id, result: {} });
    return;
  }
  if (method === 'session/send') {
    const rec = sessions.get(params.sessionId);
    if (!rec) {
      write({ id, error: { code: -32004, message: `Session not found: ${params.sessionId}` } });
      return;
    }
    const content = String(params.content ?? '');
    if (content.includes('FAIL_SEND')) {
      write({ id, error: { code: -32010, message: 'send failed once' } });
      return;
    }
    if (content.includes('HANG_SEND')) {
      return;
    }
    rec.history.push({ role: 'user', text: content });
    persist();
    write({ id, result: snapshot(params.sessionId) });
    const ac = new AbortController();
    inflight.set(params.sessionId, ac);
    emit(params.sessionId, 'turn.started', {});
    if (content.includes('ASK_PERMISSION')) {
      const permId = 900000 + sessions.size;
      const decision = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('permission timeout')), 2000);
        permissionWaiters.set(String(permId), (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        write({
          id: permId,
          method: 'interaction/requestPermission',
          params: {
            requestId: `perm_${permId}`,
            sessionId: params.sessionId,
            toolCallId: 'tool_1',
            toolName: 'read',
            reason: 'contract test',
            riskLevel: 'low',
          },
        });
      });
      logRpc({ method: 'interaction/requestPermission/reply', decision: decision?.decision });
      if (decision?.decision !== 'allow') {
        emit(params.sessionId, 'turn.failed', {
          error: { type: 'PERMISSION_DENIED', message: 'permission was not allow' },
          turnPhase: 'tool',
        });
        inflight.delete(params.sessionId);
        return;
      }
    }
    if (content.includes('FAIL_SECRET')) {
      emit(params.sessionId, 'turn.failed', {
        error: {
          type: 'MISSING_CREDENTIAL',
          message: 'provider rejected sk-secret-LIVEKEY99 Bearer abc.def.ghi ANTHROPIC_API_KEY=supersecret',
        },
        turnPhase: 'model',
      });
      inflight.delete(params.sessionId);
      return;
    }
    if (content.includes('SLEEP_TURN')) {
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 30_000);
          ac.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { aborted: true }));
          });
        });
      } catch (err) {
        if (err && typeof err === 'object' && 'aborted' in err) {
          emit(params.sessionId, 'turn.completed', { resultType: 'cancelled' });
          inflight.delete(params.sessionId);
          return;
        }
        throw err;
      }
    }
    let reply = 'PONG';
    if (historyText(rec).includes('TOKEN_A') && /what was the token/i.test(content)) {
      reply = 'TOKEN_A';
    } else if (content.includes('TOKEN_A')) {
      reply = 'ok TOKEN_A';
    }
    rec.history.push({ role: 'assistant', text: reply });
    persist();
    emit(params.sessionId, 'model.streaming', { kind: 'text_delta', delta: reply });
    emit(params.sessionId, 'turn.completed', { resultType: 'success' });
    inflight.delete(params.sessionId);
    return;
  }
  if (id != null && method) {
    write({ id, error: { code: -32601, message: `unhandled ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    continue;
  }
  if (msg.id != null && msg.result && !msg.method) {
    const waiter = permissionWaiters.get(String(msg.id));
    if (waiter) {
      permissionWaiters.delete(String(msg.id));
      waiter(msg.result);
    }
    continue;
  }
  if (msg.method === 'session/requestRuntimePreferences' && msg.id != null) {
    write({
      id: msg.id,
      result: {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      },
    });
    continue;
  }
  void handle(msg);
}
