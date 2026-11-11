import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, type TestContext, test } from 'node:test';
import type { CodexSpeedValue } from '@cat-cafe/shared';
import { resolveByAccountRef } from '../src/config/account-resolver.js';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { codexExecutionAccountSnapshot } from '../src/config/codex-execution-account.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import type { SpawnFn } from '../src/utils/cli-types.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

// Opt in explicitly: this exercises the installed CLI's read-only login command.
// The model process is always a fixture; HOME contains only synthetic auth/config.
const binary = process.env.CAT_CAFE_TEST_CODEX_BINARY;
const fileStore = 'cli_auth_credentials_store="file"\n';
const apiProvider = `model_provider="fixture-key"
[model_providers.fixture-key]
name="fixture"
base_url="https://fixture.invalid/v1"
env_key="FIXTURE_API_KEY"
requires_openai_auth=false
wire_api="responses"
`;
const apiProviderOverrides = [
  '--config model_provider="fixture-key"',
  '--config model_providers.fixture-key.name="fixture"',
  '--config model_providers.fixture-key.base_url="https://fixture.invalid/v1"',
  '--config model_providers.fixture-key.env_key="FIXTURE_API_KEY"',
  '--config model_providers.fixture-key.requires_openai_auth=false',
  '--config model_providers.fixture-key.wire_api="responses"',
];

interface NativeExecCase {
  name: string;
  oauth: boolean;
  config?: string;
  profile?: string;
  args?: string[];
  auth?: 'chatgpt' | 'apikey' | 'absent';
  codexApiKey?: string;
}

function prepareNativeFixture(t: TestContext, native: NativeExecCase) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-native-exec-speed-')));
  const home = join(root, '.codex');
  mkdirSync(home);
  mkdirSync(join(root, '.cat-cafe'));
  writeFileSync(join(root, '.cat-cafe/accounts.json'), '{}');
  writeFileSync(join(home, 'config.toml'), native.config ?? fileStore);
  if (native.profile !== undefined) writeFileSync(join(home, 'fixture-native.config.toml'), native.profile);
  if (native.auth !== 'absent') {
    const claims = {
      email: 'fixture@example.test',
      'https://api.openai.com/auth': {
        chatgpt_user_id: 'fixture-user',
        chatgpt_account_id: 'fixture-account',
        chatgpt_plan_type: 'pro',
      },
    };
    writeFileSync(
      join(home, 'auth.json'),
      JSON.stringify(
        native.auth === 'apikey'
          ? { auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-native-api-key' }
          : {
              auth_mode: 'chatgpt',
              tokens: {
                id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`,
                access_token: 'fixture-no-real-token',
                refresh_token: 'fixture-no-real-refresh',
                account_id: 'fixture-account',
              },
              last_refresh: new Date().toISOString(),
            },
      ),
    );
  }
  const environment = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: home,
    CAT_CAFE_DATA_DIR: join(root, '.cat-cafe-data'),
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CODEX_API_KEY: native.codexApiKey,
    CODEX_ACCESS_TOKEN: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    OPENAI_API_BASE: undefined,
    OPENAI_FEDERATION_RULE_ID: undefined,
    OPENAI_IDENTITY_TOKEN_FILE: undefined,
    FIXTURE_API_KEY: 'fixture-only-api-key',
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const account = resolveByAccountRef(root, 'codex');
  assert.ok(account);
  assert.equal(account.syntheticNative, true);
  assert.equal(account.authType, 'oauth', 'the synthetic label does not describe the native provider or login');
  const launch = resolveCodexAccountLaunch(account, { cwd: root });
  assert.equal(launch.authMode, 'auto');
  assert.equal(launch.credentialHome, home);
  return { root, home, account, launch };
}

async function checkNativeExec(
  t: TestContext,
  native: NativeExecCase,
  resume: boolean,
  speed: CodexSpeedValue | undefined,
) {
  assert.ok(binary);
  const { root, home, account, launch } = prepareNativeFixture(t, native);
  let observed: { args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;
  const spawnFn: SpawnFn = (command, args, options) => {
    assert.equal(command, binary, 'only the model spawn is intercepted');
    assert.equal(observed, undefined, 'the service must spawn exactly one model fixture');
    observed = { args: [...args], env: options.env };
    const proc = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      kill: () => true,
    });
    setImmediate(() => {
      proc.stdout.end(`${JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' })}\n`);
      proc.exitCode = 0;
      proc.emit('exit', 0, null);
      setImmediate(() => proc.emit('close', 0, null));
    });
    return proc;
  };
  const service = new CodexAgentService({
    cliCommand: binary,
    model: 'gpt-6.1-sol',
    l0CompilerFn: fakeL0Compiler,
    rawArchive: { append: async () => {} },
    spawnFn,
  });
  const events = [];
  for await (const event of service.invoke('native speed contract; fixture model only', {
    workingDirectory: root,
    ...(resume ? { sessionId: 'fixture-thread' } : {}),
    ...(speed ? { requestedServiceTier: speed } : {}),
    cliConfigArgs: native.args ?? [],
    codexAccountLaunch: launch,
    executionAccount: codexExecutionAccountSnapshot(account, launch),
  }))
    events.push(event);
  assert.deepEqual(
    events.filter((event) => event.type === 'error'),
    [],
  );
  assert.ok(events.some((event) => event.type === 'done'));
  assert.ok(observed, 'the real service must reach its model spawn');
  assert.ok(observed.args.includes('exec'));
  assert.equal(observed.args.includes('resume'), resume);
  assert.equal(observed.env?.CODEX_HOME, home);
  assert.equal(observed.env?.CODEX_AUTH_MODE, 'auto', 'speed eligibility must preserve native auth selection');
  const expected = native.oauth && speed ? [`service_tier="${speed === 'standard' ? 'default' : 'fast'}"`] : [];
  assert.deepEqual(
    observed.args.filter((arg) => arg.startsWith('service_tier=')),
    expected,
    native.name,
  );
}

describe('installed Codex native exec speed contract', { skip: !binary, concurrency: false }, () => {
  for (const resume of [false, true]) {
    for (const speed of ['fast', 'standard', undefined] as const) {
      test(`official OAuth ${resume ? 'resume' : 'start'} ${speed ?? 'inherit'}`, (t) =>
        checkNativeExec(t, { name: 'official OAuth', oauth: true }, resume, speed));
    }
    for (const native of [
      {
        name: 'named model-only OAuth profile',
        oauth: true,
        profile: 'model="gpt-6.1-sol"\n',
        args: ['--profile fixture-native'],
      },
      {
        name: 'profile selects API-key provider over base OAuth',
        oauth: false,
        profile: apiProvider,
        args: ['--profile fixture-native'],
      },
      { name: 'API-key provider with stored ChatGPT', oauth: false, config: fileStore + apiProvider },
      {
        name: 'ignore user API-key provider restores official OAuth',
        oauth: true,
        config: fileStore + apiProvider,
        args: ['--ignore-user-config'],
      },
      {
        name: 'ignore skips both base ephemeral store and API-key profile',
        oauth: true,
        config: 'cli_auth_credentials_store="ephemeral"\n',
        profile: apiProvider,
        args: ['--profile fixture-native --ignore-user-config'],
      },
    ]) {
      test(`${native.name} ${resume ? 'resume' : 'start'} Fast`, (t) => checkNativeExec(t, native, resume, 'fast'));
    }
  }
  for (const native of [
    {
      name: 'profile selects file credentials over empty ephemeral store',
      oauth: true,
      config: 'cli_auth_credentials_store="ephemeral"\n',
      profile: fileStore,
      args: ['--profile fixture-native'],
    },
    {
      name: 'CLI provider overlay selects API key over stored ChatGPT',
      oauth: false,
      args: apiProviderOverrides,
    },
    {
      name: 'ignore user config retains explicit CLI API-key provider',
      oauth: false,
      args: ['--ignore-user-config', ...apiProviderOverrides],
    },
    { name: 'native API-key login', oauth: false, auth: 'apikey' },
    { name: 'native login unknown', oauth: false, auth: 'absent' },
    { name: 'CODEX_API_KEY overrides stored ChatGPT for exec', oauth: false, codexApiKey: 'fixture-codex-api-key' },
  ] satisfies NativeExecCase[]) {
    test(`${native.name} start Fast`, (t) => checkNativeExec(t, native, false, 'fast'));
  }
});
