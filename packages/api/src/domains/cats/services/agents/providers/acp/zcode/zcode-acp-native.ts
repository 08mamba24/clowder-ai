import { type ChildProcess, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  ensureZcodeIsolatedHome,
  type JsonRpc,
  resolveZcodeIsolatedHome,
  sanitizeZcodeFailureText,
  ZcodeStderrRedactor,
  zcodeAppServerEnv,
  zcodeLaunchPlan,
} from './zcode-acp-protocol.js';
import { createZcodeProviderConfig, zcodeProviderPaths } from './zcode-acp-provider-paths.js';

type PendingWaiter = {
  resolve: (msg: JsonRpc) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Private ZCode app-server client. Frames never include `jsonrpc`. */
export class NativeAppServer {
  private child: ChildProcess;
  private pending = new Map<string, PendingWaiter>();
  private nextId = 1;
  private listeners: Array<(msg: JsonRpc) => void> = [];
  private closeListeners: Array<(reason: string) => void> = [];
  private closedReason: string | undefined;
  private stderr = new ZcodeStderrRedactor();
  private stderrTail: string[] = [];
  private exited = false;
  private disposePersonal: () => void;
  readonly isolatedHome: string;

  constructor(bin: string, env: NodeJS.ProcessEnv = process.env) {
    const plan = zcodeLaunchPlan(realpathSync(bin));
    this.isolatedHome = ensureZcodeIsolatedHome(resolveZcodeIsolatedHome(env));
    const providerPaths = zcodeProviderPaths(bin);
    const personal = createZcodeProviderConfig(this.isolatedHome, env);
    this.disposePersonal = () => {
      personal.dispose();
      process.removeListener('exit', this.disposePersonal);
    };
    process.once('exit', this.disposePersonal);
    this.child = spawn(plan.command, plan.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...zcodeAppServerEnv(env, this.isolatedHome),
        ...providerPaths,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal.path,
      },
    });
    if (!this.child.stdout || !this.child.stdin) {
      throw new Error('zcode app-server spawn missing stdio pipes');
    }
    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.onLine(line));
    this.child.stderr?.on('data', (buf) => {
      for (const line of this.stderr.push(buf.toString())) {
        this.recordStderr(line);
      }
    });
    this.child.on('error', (err) => {
      this.fail(`zcode app-server error: ${err instanceof Error ? err.message : 'spawn failed'}`);
    });
    // close follows the final stdio bytes; exit alone can lose the root cause.
    this.child.on('close', (code, signal) => {
      this.exited = true;
      this.disposePersonal();
      this.flushStderr();
      const detail = this.stderrTail.join(' | ');
      this.fail(sanitizeZcodeFailureText(`zcode app-server exited code=${code} signal=${signal}: ${detail}`));
    });
    this.child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      // EPIPE is followed by close; let it include the drained stderr cause.
      if (err.code !== 'EPIPE') this.fail(`zcode app-server stdin error: ${err.code}`);
    });
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  onEvent(listener: (msg: JsonRpc) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  onClose(listener: (reason: string) => void): () => void {
    if (this.closedReason) {
      queueMicrotask(() => listener(this.closedReason as string));
      return () => {};
    }
    this.closeListeners.push(listener);
    return () => {
      const index = this.closeListeners.indexOf(listener);
      if (index >= 0) this.closeListeners.splice(index, 1);
    };
  }

  request(method: string, params: unknown, timeoutMs = 120_000): Promise<JsonRpc> {
    if (this.closedReason) {
      return Promise.resolve({ error: { code: -32000, message: this.closedReason } });
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        resolve({ error: { code: -32000, message: `timeout waiting for ${method}` } });
      }, timeoutMs);
      this.pending.set(String(id), { resolve, timer });
      this.writeNative({ id, method, params });
    });
  }

  reply(id: number | string, result: unknown): void {
    this.writeNative({ id, result });
  }

  close(): void {
    // The outer process supervisor may cut short the child's shutdown grace.
    // Revoke the generated credential input before waiting on any child event.
    this.disposePersonal();
    this.fail('zcode app-server closed');
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    this.child.kill('SIGTERM');
  }

  whenExited(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      this.child.once('close', () => resolve());
    });
  }

  private fail(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    const err: JsonRpc = { error: { code: -32000, message: reason } };
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(err);
    }
    this.pending.clear();
    const listeners = [...this.closeListeners];
    this.closeListeners = [];
    for (const listener of listeners) listener(reason);
  }

  private flushStderr(): void {
    const leftover = this.stderr.flush();
    if (leftover) this.recordStderr(leftover);
  }

  private recordStderr(line: string): void {
    this.stderrTail.push(line);
    if (this.stderrTail.length > 4) this.stderrTail.shift();
    process.stderr.write(`[zcode-app-server] ${line}\n`);
  }

  private writeNative(payload: JsonRpc): void {
    if (this.closedReason) return;
    this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpc;
    try {
      msg = JSON.parse(trimmed) as JsonRpc;
    } catch {
      return;
    }
    if (msg.method === 'session/requestRuntimePreferences' && msg.id != null) {
      this.reply(msg.id, {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      });
      return;
    }
    if (msg.method === 'interaction/requestPermission' && msg.id != null) {
      this.reply(msg.id, { decision: 'allow', reason: 'Hub yolo mode' });
      return;
    }
    if (msg.method && msg.id != null) {
      this.writeNative({ id: msg.id, error: { code: -32601, message: `unhandled ${msg.method}` } });
      return;
    }
    if (msg.id != null && this.pending.has(String(msg.id))) {
      const waiter = this.pending.get(String(msg.id));
      this.pending.delete(String(msg.id));
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
      return;
    }
    for (const listener of this.listeners) listener(msg);
  }
}
