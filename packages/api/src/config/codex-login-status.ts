import { execFile } from 'node:child_process';
import { resolveWindowsSpawnPlan } from '../utils/cli-spawn-win.js';
import {
  applyCodexAccountRequirements,
  hasAlternativeCodexCredentials,
  validateCodexOAuthRequirements,
} from './codex-account-environment.js';
import { readCodexLaunchProjection } from './codex-launch-config.js';

export type CodexObservedAuthType = 'oauth' | 'api_key' | undefined;

/** Qualify native exec speed with an official-provider fence and native stored-login evidence. */
export async function readCodexLoginAuthType(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<CodexObservedAuthType> {
  const home = input.env.CODEX_HOME;
  if (!home || hasAlternativeCodexCredentials(input.env)) return undefined;
  let args: string[];
  try {
    // This bounded projection only admits known official provider/auth settings.
    // login status reads credentials but cannot prove which provider exec will use.
    if (input.args.some((arg) => arg === '--oss' || arg.startsWith('--local-provider'))) return undefined;
    const { config, requirements } = readCodexLaunchProjection(home, input.cwd, input.args, {
      nativeHome: input.env.HOME,
    });
    const effective = applyCodexAccountRequirements(config, requirements);
    validateCodexOAuthRequirements(effective, requirements);
    // 0.163 login status rejects exec's --profile/--ignore-user-config. Translate
    // the selected auth-store instead; native's default is file, not auto.
    const store = effective.cli_auth_credentials_store ?? 'file';
    if (!['file', 'keyring', 'auto', 'ephemeral'].includes(String(store))) return undefined;
    args = ['--config', `cli_auth_credentials_store=${JSON.stringify(store)}`, 'login', 'status'];
  } catch {
    return undefined;
  }
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
