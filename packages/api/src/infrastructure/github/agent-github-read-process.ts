import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { buildUnixSupervisedSpawnPlan } from '../../utils/cli-supervised-process.js';
import type { GhReadFailure } from './agent-github-read-schema.js';
import { buildGhCliEnv, withHiddenGhCliWindow } from './gh-cli-env.js';

export interface GhReadProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeout: number;
  maxBuffer: number;
  shell: false;
  windowsHide: true;
}
export type GhReadRunner = (
  file: string,
  args: string[],
  options: GhReadProcessOptions,
) => Promise<{
  stdout: string;
  stderr?: string;
  exitCode: number;
}>;
export class GhReadError extends Error {
  constructor(readonly code: GhReadFailure) {
    super(code);
  }
}

export const runGhReadProcess: GhReadRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    if (!isAbsolute(file) || !isAbsolute(options.cwd)) {
      reject(new GhReadError('capability_unavailable'));
      return;
    }
    // The canonical wrapper may spawn gh. Reuse the process owner so abort,
    // timeout and output overflow reclaim descendants, including detached ones.
    const plan =
      process.platform === 'win32'
        ? { command: file, args, env: options.env }
        : buildUnixSupervisedSpawnPlan(file, args, { env: options.env, killGraceMs: 250 });
    const child = execFile(
      plan.command,
      plan.args,
      { ...options, env: plan.env, encoding: 'utf8', killSignal: 'SIGTERM' },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== 'number')) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr, exitCode: typeof error?.code === 'number' ? error.code : 0 });
      },
    );
    // No TTY, stdin prompt or hanging pager can borrow the API process input.
    child.stdin?.end();
  });

export function ghReadProcessOptions(input: {
  cwd: string;
  baseEnv: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeout: number;
  maxBuffer: number;
}): GhReadProcessOptions {
  // Keep authentication in the existing host gh store. Never copy API secrets
  // into a subprocess environment inspectable by another same-UID process.
  const allowed = new Set([
    'HOME',
    'PATH',
    'XDG_CONFIG_HOME',
    'GH_CONFIG_DIR',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SYSTEMROOT',
    'USERPROFILE',
    'APPDATA',
    'CAT_CAFE_REAL_GH_PATH',
  ]);
  // New entries expand a credential-adjacent boundary and require independent review.
  // Retain the caller's ProcessEnv type (Next.js augments it), then enforce the allowlist.
  const env = buildGhCliEnv({ baseEnv: input.baseEnv });
  for (const key of Object.keys(env)) if (!allowed.has(key)) delete env[key];
  return withHiddenGhCliWindow({
    cwd: input.cwd,
    signal: input.signal,
    timeout: input.timeout,
    maxBuffer: input.maxBuffer,
    shell: false as const,
    env: {
      ...env,
      GH_HOST: 'github.com',
      GH_PROMPT_DISABLED: '1',
      GH_PAGER: 'cat',
      PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      NO_COLOR: '1',
    },
  });
}

/** Bound even an injected runner that doesn't honour AbortSignal. */
export async function withGhReadAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
