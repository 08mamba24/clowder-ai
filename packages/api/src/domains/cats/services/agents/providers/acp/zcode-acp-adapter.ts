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
  readZcodeEnvModel,
  readZcodeSessionId,
  sanitizeZcodeFailureText,
  type TurnEvent,
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
  // Create on the first ACP request so discovery/spawn errors can be returned
  // with its id instead of exiting before the client receives a diagnosis.
  let native: NativeAppServer | undefined;
  const sessions = new Map<string, string>();
  // Bumped on every session/cancel. The -32031 recovery window (setModel await
  // + resend) has no active native turn, so native session/stop is a no-op
  // there; the generation check is the only guard against resending a prompt
  // the client already cancelled.
  const cancelGenerations = new Map<string, number>();
  const inflight = new Set<Promise<void>>();
  const timeoutMs = requestTimeoutMs(env);
  const shutdown = (): void => {
    if (!native) process.exit(0);
    native.close();
    const done = (): void => {
      process.exit(0);
    };
    const timer = setTimeout(done, 4000);
    void native.whenExited().then(() => {
      clearTimeout(timer);
      done();
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

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
    const task = Promise.resolve()
      .then(() => {
        native ??= new NativeAppServer(bin, env);
        return handleAcp(native, sessions, cancelGenerations, env, msg, timeoutMs);
      })
      .catch((err) => {
        acpError(msg.id, -32603, formatZcodeTurnFailure(extractZcodeFailure(err)));
      });
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  }
  await Promise.all([...inflight]);
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
  native?.close();
}

async function handleAcp(
  native: NativeAppServer,
  sessions: Map<string, string>,
  cancelGenerations: Map<string, number>,
  env: NodeJS.ProcessEnv,
  msg: JsonRpc,
  timeoutMs: number,
): Promise<void> {
  switch (msg.method) {
    case undefined:
      return;
    case 'initialize': {
      const ready = await native.request('session/list', { includeArchived: false }, Math.min(timeoutMs, 10_000));
      if (ready.error) {
        acpError(msg.id, -32603, formatZcodeTurnFailure(extractZcodeFailure(ready.error)));
        native.close();
        return;
      }
      if (!Array.isArray((ready.result as { sessions?: unknown } | undefined)?.sessions)) {
        acpError(msg.id, -32603, 'invalid ZCode session/list response during initialization');
        native.close();
        return;
      }
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
    }
    case 'session/new':
      return handleSessionNew(native, sessions, msg, timeoutMs);
    case 'session/load':
      return handleSessionLoad(native, sessions, env, msg, timeoutMs);
    case 'session/prompt':
      return handleSessionPrompt(native, sessions, cancelGenerations, env, msg, timeoutMs);
    case 'session/cancel': {
      const params = (msg.params ?? {}) as { sessionId?: string };
      if (params.sessionId) {
        cancelGenerations.set(params.sessionId, (cancelGenerations.get(params.sessionId) ?? 0) + 1);
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
  timeoutMs: number,
): Promise<void> {
  const params = (msg.params ?? {}) as { cwd?: string };
  const cwd = params.cwd || process.cwd();
  const created = await native.request(
    'session/create',
    {
      workspace: zcodeWorkspace(cwd),
      mode: 'yolo',
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
  env: NodeJS.ProcessEnv,
  msg: JsonRpc,
  timeoutMs: number,
): Promise<void> {
  const params = (msg.params ?? {}) as { sessionId?: string; cwd?: string };
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    acpError(msg.id, -32602, 'session/load requires sessionId');
    return;
  }
  const cwd = params.cwd || process.cwd();
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
  // A persisted session can reference the previously configured model. Bind
  // this invocation's model before admitting a new turn, without changing
  // the workspace default used by concurrent native processes.
  const selected = await selectConfiguredModel(native, sessionId, env, resumed.result, timeoutMs);
  if (selected.error) {
    acpError(msg.id, -32603, formatZcodeTurnFailure(extractZcodeFailure(selected.error)));
    return;
  }
  if (!(await subscribeSession(native, sessionId, msg.id, timeoutMs))) return;
  sessions.set(sessionId, sessionId);
  acpResult(msg.id, { sessionId });
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

/**
 * A deferred native adapter can return -32031 before admitting a turn.
 * Re-select the configured model once; never resend after ACP cancellation.
 */
function isRuntimeModelUnavailable(error: unknown): boolean {
  const failure = extractZcodeFailure(error);
  const code = String(failure.code ?? '');
  return code === '32031' || code === '-32031';
}

async function selectConfiguredModel(
  native: NativeAppServer,
  sessionId: string,
  env: NodeJS.ProcessEnv,
  snapshot: unknown,
  timeoutMs: number,
): Promise<JsonRpc> {
  const modelId = readZcodeEnvModel(env.ZCODE_MODEL);
  if (!modelId) return { error: { message: 'ZCODE_MODEL is missing' } };
  const settings = (snapshot as { settings?: { model?: { available?: unknown } } })?.settings;
  const available = settings?.model?.available;
  type NativeModelOption = { ref?: { providerId?: string; modelId?: string }; reasoning?: { defaultLevel?: string } };
  const selected = Array.isArray(available)
    ? (available as NativeModelOption[]).find(
        (option) => option.ref?.providerId === 'anthropic' && option.ref?.modelId === modelId,
      )
    : undefined;
  const reasoningLevel = selected?.reasoning?.defaultLevel;
  if (!reasoningLevel) return { error: { message: `ZCode registry has no usable model selection for ${modelId}` } };
  return native.request(
    'session/setModel',
    {
      sessionId,
      model: { providerId: 'anthropic', modelId, options: { reasoningLevel } },
      persistAsWorkspaceLastUsed: false,
    },
    timeoutMs,
  );
}

async function recoverRuntimeModel(
  native: NativeAppServer,
  sessionId: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<boolean> {
  const snapshot = await native.request('session/read', { sessionId }, timeoutMs);
  if (snapshot.error) return false;
  const set = await selectConfiguredModel(native, sessionId, env, snapshot.result, timeoutMs);
  if (set.error) {
    process.stderr.write(
      `[zcode-acp-adapter] -32031 recovery via session/setModel failed: ${sanitizeZcodeFailureText(
        formatZcodeTurnFailure(extractZcodeFailure(set.error)),
      )}\n`,
    );
    return false;
  }
  return true;
}

async function handleSessionPrompt(
  native: NativeAppServer,
  sessions: Map<string, string>,
  cancelGenerations: Map<string, number>,
  env: NodeJS.ProcessEnv,
  msg: JsonRpc,
  timeoutMs: number,
): Promise<void> {
  const params = (msg.params ?? {}) as { sessionId?: string; prompt?: unknown };
  const sessionId = params.sessionId;
  if (!sessionId || !sessions.has(sessionId)) {
    acpError(msg.id, -32602, 'unknown sessionId');
    return;
  }
  const cancelGenerationAtStart = cancelGenerations.get(sessionId) ?? 0;
  const cancelledSinceStart = (): boolean => (cancelGenerations.get(sessionId) ?? 0) !== cancelGenerationAtStart;
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
    let sent = await native.request('session/send', { sessionId, content: flattenAcpPrompt(params.prompt) }, timeoutMs);
    if (sent.error && isRuntimeModelUnavailable(sent.error)) {
      // A cancel that landed while the first send was in flight (or during
      // recovery) settles as cancelled, never as a surfaced -32031 failure.
      if (
        !cancelledSinceStart() &&
        (await recoverRuntimeModel(native, sessionId, env, timeoutMs)) &&
        !cancelledSinceStart()
      ) {
        sent = await native.request('session/send', { sessionId, content: flattenAcpPrompt(params.prompt) }, timeoutMs);
      }
      if (cancelledSinceStart()) {
        acpResult(msg.id, { stopReason: 'cancelled' });
        return;
      }
    }
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
  let stopEvent = (): void => {};
  let stopClose = (): void => {};
  const promise = new Promise<TurnEvent>((resolve) => {
    const finish = (event: TurnEvent): void => {
      if (disposed) return;
      disposed = true;
      stopEvent();
      stopClose();
      resolve(event);
    };
    stopEvent = native.onEvent((msg) => {
      const event = parseTurnEvent(msg, sessionId);
      if (!event) return;
      if (event.delta) onDelta(event.delta);
      if (event.terminal) finish(event);
    });
    stopClose = native.onClose((reason) => {
      finish({ terminal: 'failed', failure: { code: 'native_exit', message: reason } });
    });
  });
  return {
    promise,
    dispose: () => {
      disposed = true;
      stopEvent();
      stopClose();
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
