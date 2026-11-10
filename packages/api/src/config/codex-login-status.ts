import { execFile } from 'node:child_process';
import { resolveWindowsSpawnPlan } from '../utils/cli-spawn-win.js';

export type CodexObservedAuthType = 'oauth' | 'api_key' | undefined;

/** Read-only native credential-store inspection, using the exact invocation's launch context. */
export async function readCodexLoginAuthType(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<CodexObservedAuthType> {
  const args = [...input.args, 'login', 'status'];
  const plan =
    process.platform === 'win32' ? resolveWindowsSpawnPlan(input.command, args) : { command: input.command, args };
  return new Promise((resolve) => {
    execFile(
      plan.command,
      plan.args,
      {
        cwd: input.cwd,
        env: input.env,
        ...(input.signal ? { signal: input.signal } : {}),
        shell: 'shell' in plan ? plan.shell : false,
        windowsHide: true,
        timeout: 6_000,
        maxBuffer: 16_384,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) return resolve(undefined);
        const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim());
        const oauth = lines.some((line) => /^Logged in using ChatGPT(?:\s|$)/.test(line));
        const apiKey = lines.some((line) => /^Logged in using an API key(?:\s|$)/.test(line));
        resolve(oauth === apiKey ? undefined : oauth ? 'oauth' : 'api_key');
      },
    );
  });
}
