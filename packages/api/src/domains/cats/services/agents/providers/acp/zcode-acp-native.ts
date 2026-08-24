import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  ensureZcodeIsolatedHome,
  type JsonRpc,
  resolveZcodeIsolatedHome,
  sanitizeZcodeFailureText,
  zcodeAppServerEnv,
  zcodeLaunchPlan,
} from './zcode-acp-protocol.js';

/** Private ZCode 0.16.3 app-server client. Frames never include `jsonrpc`. */
export class NativeAppServer {
  private child: ChildProcess;
  private pending = new Map<string, { resolve: (msg: JsonRpc) => void }>();
  private nextId = 1;
  private listeners: Array<(msg: JsonRpc) => void> = [];
  readonly isolatedHome: string;

  constructor(bin: string, env: NodeJS.ProcessEnv = process.env) {
    const plan = zcodeLaunchPlan(bin);
    this.isolatedHome = ensureZcodeIsolatedHome(resolveZcodeIsolatedHome(env));
    this.child = spawn(plan.command, plan.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: zcodeAppServerEnv(env, this.isolatedHome),
    });
    if (!this.child.stdout || !this.child.stdin) {
      throw new Error('zcode app-server spawn missing stdio pipes');
    }
    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.onLine(line));
    this.child.stderr?.on('data', (buf) => {
      const text = sanitizeZcodeFailureText(buf.toString()).trim();
      if (text) process.stderr.write(`[zcode-app-server] ${text}\n`);
    });
    this.child.on('exit', (code, signal) => {
      for (const waiter of this.pending.values()) {
        waiter.resolve({
          error: { code: -32000, message: `zcode app-server exited code=${code} signal=${signal}` },
        });
      }
      this.pending.clear();
    });
  }

  onEvent(listener: (msg: JsonRpc) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  request(method: string, params: unknown, timeoutMs = 120_000): Promise<JsonRpc> {
    const id = this.nextId++;
    this.writeNative({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  reply(id: number | string, result: unknown): void {
    this.writeNative({ id, result });
  }

  close(): void {
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    this.child.kill('SIGTERM');
  }

  private writeNative(payload: JsonRpc): void {
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
      this.pending.get(String(msg.id))?.resolve(msg);
      this.pending.delete(String(msg.id));
      return;
    }
    for (const listener of this.listeners) listener(msg);
  }
}
