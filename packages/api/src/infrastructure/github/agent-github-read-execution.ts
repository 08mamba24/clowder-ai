import { GhReadError, type GhReadRunner, ghReadProcessOptions, withGhReadAbort } from './agent-github-read-process.js';
import type { GhReadFailure, GhReadResult } from './agent-github-read-schema.js';
import { classifyGhValidationFailure } from './github-object-validator.js';

export function ghReadFailure(code: GhReadFailure): GhReadResult {
  return { ok: false, code, retryable: ['rate_limited', 'timeout', 'stale_head', 'unavailable'].includes(code) };
}

interface ExecutionOptions {
  ghPath: string;
  cwd: string;
  baseEnv: NodeJS.ProcessEnv;
  runner: GhReadRunner;
  timeoutMs: number;
  maxOutputBytes: number;
  authoritySignal: AbortSignal;
  requestSignal?: AbortSignal;
  validateAuthority?: () => Promise<boolean>;
}

/** One request owns the total deadline and output budget across every gh call. */
export class GhReadExecution {
  private readonly deadline = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly signal: AbortSignal;
  private readonly expiresAt: number;
  private bytes = 0;

  constructor(private readonly options: ExecutionOptions) {
    this.expiresAt = Date.now() + options.timeoutMs;
    this.timer = setTimeout(() => this.deadline.abort(new GhReadError('timeout')), options.timeoutMs);
    const signals = [options.authoritySignal, this.deadline.signal];
    if (options.requestSignal) signals.push(options.requestSignal);
    this.signal = AbortSignal.any(signals);
  }

  private ended(): GhReadFailure | undefined {
    if (this.options.authoritySignal.aborted) return 'invocation_ended';
    if (this.options.requestSignal?.aborted) return 'cancelled';
    if (this.deadline.signal.aborted || Date.now() >= this.expiresAt) return 'timeout';
    return undefined;
  }

  assertActive(): void {
    const reason = this.ended();
    if (reason) throw new GhReadError(reason);
  }

  async validateActive(): Promise<void> {
    this.assertActive();
    const validate = this.options.validateAuthority;
    if (validate && !(await withGhReadAbort(this.signal, validate))) throw new GhReadError('invocation_ended');
    this.assertActive();
  }

  async execute(args: string[], checks = false): Promise<string> {
    await this.validateActive();
    const options = this.options;
    const output = await withGhReadAbort(this.signal, () =>
      options.runner(
        options.ghPath,
        args,
        ghReadProcessOptions({
          cwd: options.cwd,
          baseEnv: options.baseEnv,
          signal: this.signal,
          timeout: Math.max(1, this.expiresAt - Date.now()),
          maxBuffer: options.maxOutputBytes,
        }),
      ),
    );
    await this.validateActive();
    this.bytes += Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr ?? '');
    if (this.bytes > options.maxOutputBytes) throw new GhReadError('output_limit');
    const checksResult = checks && [1, 8].includes(output.exitCode) && output.stdout.trim().startsWith('[');
    if (output.exitCode !== 0 && !checksResult) {
      const error = Object.assign(new Error('gh query failed'), { code: output.exitCode, stderr: output.stderr });
      throw new GhReadError(classifyGhValidationFailure(error));
    }
    return output.stdout;
  }

  failure(error: unknown): GhReadResult {
    const ended = this.ended();
    if (ended) return ghReadFailure(ended);
    if (error instanceof GhReadError) return ghReadFailure(error.code);
    if (error instanceof Error && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return ghReadFailure('output_limit');
    if (error instanceof Error && 'killed' in error && error.killed) return ghReadFailure('timeout');
    return ghReadFailure('unavailable');
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
