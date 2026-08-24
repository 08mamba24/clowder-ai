/**
 * ACP v1 stdio adapter over ZCode's private app-server protocol.
 * Stdout is ACP JSON-RPC only. Native frames never include a `jsonrpc` field.
 */
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { NativeAppServer } from './zcode-acp-native.js';
import {
  extractZcodeFailure,
  flattenAcpPrompt,
  formatZcodeTurnFailure,
  type JsonRpc,
  parseTurnEvent,
  readZcodeSessionId,
  requireZcodeNativeModel,
  sanitizeZcodeFailureText,
  type TurnEvent,
  type ZcodeNativeModel,
  zcodeLaunchPlan,
  zcodeWorkspace,
} from './zcode-acp-protocol.js';

export { flattenAcpPrompt, zcodeLaunchPlan };

function acpWrite(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function acpResult(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return;
  acpWrite({ jsonrpc: '2.0', id, result });
}

function acpError(id: number | string | undefined, code: number, message: string): void {
  if (id === undefined) return;
  acpWrite({ jsonrpc: '2.0', id, error: { code, message: sanitizeZcodeFailureText(message) } });
}

function requestTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.ZCODE_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

export async function runZcodeAcpAdapter(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const bin = env.ZCODE_BIN?.trim();
  if (!bin) {
    throw new Error('ZCODE_BIN must point at zcode.cjs or the zcode CLI');
  }
  const native = new NativeAppServer(bin, env);
  const sessions = new Map<string, string>();
  const inflight = new Set<Promise<void>>();
  const timeoutMs = requestTimeoutMs(env);

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: JsonRpc;
    try {
      msg = JSON.parse(trimmed) as JsonRpc;
    } catch {
      continue;
    }
    const task = handleAcp(native, sessions, msg, env, timeoutMs).catch((err) => {
      acpError(msg.id, -32603, formatZcodeTurnFailure(extractZcodeFailure(err)));
    });
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  }
  await Promise.all([...inflight]);
  native.close();
}

async function handleAcp(
  native: NativeAppServer,
  sessions: Map<string, string>,
  msg: JsonRpc,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  switch (msg.method) {
    case undefined:
      return;
    case 'initialize':
      acpResult(msg.id, {
        protocolVersion: 1,
        authMethods: [],
        agentInfo: { name: 'zcode-acp-adapter', title: 'ZCode', version: '0.16' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
      });
      return;
    case 'session/new':
      return handleSessionNew(native, sessions, msg, env, timeoutMs);
    case 'session/load':
      return handleSessionLoad(native, sessions, msg, env, timeoutMs);
    case 'session/prompt':
      return handleSessionPrompt(native, sessions, msg, timeoutMs);
    case 'session/cancel': {
      const params = (msg.params ?? {}) as { sessionId?: string };
      if (params.sessionId) {
        await native.request('session/stop', { sessionId: params.sessionId }, timeoutMs);
      }
      return;
    }
    default:
      acpError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

async function handleSessionNew(
  native: NativeAppServer,
  sessions: Map<string, string>,
  msg: JsonRpc,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  const params = (msg.params ?? {}) as { cwd?: string };
  const cwd = params.cwd || process.cwd();
  const model = requireZcodeNativeModel(env);
  const created = await native.request(
    'session/create',
    {
      workspace: zcodeWorkspace(cwd),
      mode: 'yolo',
      model,
      persistence: 'immediate',
    },
    timeoutMs,
  );
  if (created.error) {
    acpError(msg.id, -32603, formatZcodeTurnFailure(extractZcodeFailure(created.error)));
    return;
  }
  const sessionId = readZcodeSessionId(created.result);
  if (!sessionId) {
    acpError(msg.id, -32603, 'zcode session/create missing sessionId');
    return;
  }
  if (!(await subscribeSession(native, sessionId, msg.id, timeoutMs))) return;
  sessions.set(sessionId, sessionId);
  acpResult(msg.id, { sessionId });
}

async function handleSessionLoad(
  native: NativeAppServer,
  sessions: Map<string, string>,
  msg: JsonRpc,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  const params = (msg.params ?? {}) as { sessionId?: string; cwd?: string };
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    acpError(msg.id, -32602, 'session/load requires sessionId');
    return;
  }
  const cwd = params.cwd || process.cwd();
  const model = requireZcodeNativeModel(env);
  const resumed = await native.request(
    'session/resume',
    {
      sessionId,
      workspace: zcodeWorkspace(cwd),
    },
    timeoutMs,
  );
  if (resumed.error) {
    acpError(msg.id, -32603, formatZcodeTurnFailure(extractZcodeFailure(resumed.error)));
    return;
  }
  if (!(await applyResumeModel(native, sessionId, model, msg.id, timeoutMs))) return;
  if (!(await subscribeSession(native, sessionId, msg.id, timeoutMs))) return;
  sessions.set(sessionId, sessionId);
  acpResult(msg.id, { sessionId });
}

async function applyResumeModel(
  native: NativeAppServer,
  sessionId: string,
  model: ZcodeNativeModel,
  acpId: number | string | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const setModel = await native.request('session/setModel', { sessionId, model }, timeoutMs);
  if (setModel.error) {
    acpError(acpId, -32603, formatZcodeTurnFailure(extractZcodeFailure(setModel.error)));
    return false;
  }
  return true;
}

async function subscribeSession(
  native: NativeAppServer,
  sessionId: string,
  acpId: number | string | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const sub = await native.request(
    'session/subscribe',
    {
      sessionId,
      deliveryKind: 'desktop-continuous',
      includeSnapshot: true,
      afterSeq: 0,
    },
    timeoutMs,
  );
  if (sub.error) {
    acpError(acpId, -32603, formatZcodeTurnFailure(extractZcodeFailure(sub.error)));
    return false;
  }
  return true;
}

async function handleSessionPrompt(
  native: NativeAppServer,
  sessions: Map<string, string>,
  msg: JsonRpc,
  timeoutMs: number,
): Promise<void> {
  const params = (msg.params ?? {}) as { sessionId?: string; prompt?: unknown };
  const sessionId = params.sessionId;
  if (!sessionId || !sessions.has(sessionId)) {
    acpError(msg.id, -32602, 'unknown sessionId');
    return;
  }
  const waiter = waitForTurn(native, sessionId, (delta) => {
    acpWrite({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } },
      },
    });
  });
  try {
    const sent = await native.request(
      'session/send',
      { sessionId, content: flattenAcpPrompt(params.prompt) },
      timeoutMs,
    );
    if (sent.error) {
      acpError(msg.id, -32603, formatZcodeTurnFailure(extractZcodeFailure(sent.error)));
      return;
    }
    const outcome = await waiter.promise;
    if (outcome.terminal === 'failed') {
      acpError(msg.id, -32603, formatZcodeTurnFailure(outcome.failure));
      return;
    }
    acpResult(msg.id, { stopReason: outcome.terminal === 'cancelled' ? 'cancelled' : 'end_turn' });
  } catch (err) {
    acpError(msg.id, -32603, formatZcodeTurnFailure(extractZcodeFailure(err)));
  } finally {
    waiter.dispose();
  }
}

function waitForTurn(
  native: NativeAppServer,
  sessionId: string,
  onDelta: (text: string) => void,
): { promise: Promise<TurnEvent>; dispose: () => void } {
  let disposed = false;
  let stop = (): void => {};
  const promise = new Promise<TurnEvent>((resolve) => {
    stop = native.onEvent((msg) => {
      if (disposed) return;
      const event = parseTurnEvent(msg, sessionId);
      if (!event) return;
      if (event.delta) onDelta(event.delta);
      if (event.terminal) {
        disposed = true;
        stop();
        resolve(event);
      }
    });
  });
  return {
    promise,
    dispose: () => {
      disposed = true;
      stop();
    },
  };
}

const isMain = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (isMain) {
  runZcodeAcpAdapter().catch((err) => {
    process.stderr.write(`${sanitizeZcodeFailureText(formatZcodeTurnFailure(extractZcodeFailure(err)))}\n`);
    process.exit(1);
  });
}
