#!/usr/bin/env node
/**
 * Native ZCode 0.16.3-shaped app-server fake for adapter contract tests.
 * No jsonrpc field. session/stop is a request (requires id).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import readline from 'node:readline';

const storePath = process.env.ZCODE_FAKE_STORE;
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
  appendFileSync(logPath, `${JSON.stringify({ id: msg.id ?? null, method: msg.method ?? null })}\n`);
}

function emit(sessionId, type, payload = {}) {
  write({ method: 'session/event', params: { sessionId, type, payload } });
}

function historyText(rec) {
  return rec.history.map((h) => h.text).join('\n');
}

const inflight = new Map();

async function handle(msg) {
  logRpc(msg);
  const method = msg.method;
  const id = msg.id;
  const params = msg.params ?? {};
  if (method === 'session/create') {
    const sessionId = `sess_${sessions.size + 1}`;
    sessions.set(sessionId, { history: [], cwd: params.workspace?.workspacePath ?? '' });
    persist();
    write({ id, result: { session: { sessionId } } });
    return;
  }
  if (method === 'session/resume') {
    const rec = sessions.get(params.sessionId);
    if (!rec) {
      write({ id, error: { code: -32004, message: `Session not found: ${params.sessionId}` } });
      return;
    }
    write({ id, result: { session: { sessionId: params.sessionId }, history: rec.history } });
    return;
  }
  if (method === 'session/subscribe') {
    write({ id, result: { ok: true } });
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
    rec.history.push({ role: 'user', text: content });
    persist();
    write({ id, result: { ok: true } });
    const ac = new AbortController();
    inflight.set(params.sessionId, ac);
    emit(params.sessionId, 'turn.started', {});
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
