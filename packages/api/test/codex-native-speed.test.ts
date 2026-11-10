import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { CodexSpeedValue } from '@cat-cafe/shared';
import { resolveByAccountRef } from '../src/config/account-resolver.js';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { codexExecutionAccountSnapshot } from '../src/config/codex-execution-account.js';
import { readCodexLoginAuthType } from '../src/config/codex-login-status.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import { F320AccountWire } from './helpers/f320-account-wire.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

interface NativeAccountCase {
  name: string;
  account: Record<string, unknown> | null;
  isChatGpt: boolean;
}

const nativeChatGpt: NativeAccountCase = { name: 'ChatGPT', account: { type: 'chatgpt' }, isChatGpt: true };
const nativeAccounts: readonly NativeAccountCase[] = [
  nativeChatGpt,
  { name: 'API key', account: { type: 'apiKey' }, isChatGpt: false },
  { name: 'no account', account: null, isChatGpt: false },
  { name: 'unknown account', account: { type: 'fixture-unknown' }, isChatGpt: false },
];

function nativeAccountFixture(t: TestContext, native: NativeAccountCase) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-native-speed-')));
  const home = join(root, '.codex');
  mkdirSync(home);
  mkdirSync(join(root, '.cat-cafe'));
  writeFileSync(join(root, '.cat-cafe', 'accounts.json'), '{}');
  // Without a catalog entry or ambient API key, the real resolver produces an
  // OAuth placeholder even when the native credential store selects API key.
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify(
      native.account?.type === 'apiKey'
        ? { auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-native-key' }
        : { auth_mode: 'chatgpt' },
    ),
  );
  const environment = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: home,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    OPENAI_API_BASE: undefined,
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
  assert.equal(account.authType, 'oauth', 'the resolver value is deliberately only a placeholder');
  const launch = resolveCodexAccountLaunch(account, { cwd: root });
  assert.equal(launch.authMode, 'auto', 'native accounts leave login selection to Codex');
  assert.equal(launch.credentialHome, home);
  return { root, home, account, launch };
}

async function checkNativeSpeed(
  t: TestContext,
  resume: boolean,
  native: NativeAccountCase,
  speed: CodexSpeedValue | undefined,
  omitSnapshot = false,
) {
  const { root, home, account, launch } = nativeAccountFixture(t, native);
  const wire = new F320AccountWire({ model_provider: 'openai', sqlite_home: home }, false, native.account);
  const service = new CodexAgentService({
    cliCommand: process.execPath,
    carrierMode: 'app_server',
    model: 'gpt-6.1-sol',
    l0CompilerFn: fakeL0Compiler,
    rawArchive: { append: async () => {} },
  });
  const events = [];
  for await (const event of service.invoke('native speed regression', {
    invocationId: `native-speed-${native.name}-${speed ?? 'inherit'}-${resume}-${omitSnapshot}`,
    workingDirectory: root,
    ...(resume ? { sessionId: 'fixture-thread' } : {}),
    ...(speed ? { requestedServiceTier: speed } : {}),
    codexAccountLaunch: launch,
    ...(!omitSnapshot ? { executionAccount: codexExecutionAccountSnapshot(account, launch) } : {}),
    agentCarrierSessionFactory: async (options) => {
      assert.equal(options.env?.CODEX_AUTH_MODE, 'auto');
      assert.equal(options.env?.CODEX_HOME, home);
      return wire;
    },
  }))
    events.push(event);
  assert.deepEqual(
    events.filter((event) => event.type === 'error'),
    [],
  );
  assert.ok(events.some((event) => event.type === 'done'));
  const threadMethod = resume ? 'thread/resume' : 'thread/start';
  const requestIndex = wire.writes.findIndex((message) => message.method === threadMethod);
  assert.ok(requestIndex >= 0, 'the real service must reach its thread RPC');
  const accountReadIndex = wire.writes.findIndex((message) => message.method === 'account/read');
  assert.ok(accountReadIndex >= 0 && accountReadIndex < requestIndex, 'inspect the same host before its thread RPC');
  assert.deepEqual(wire.writes[accountReadIndex].params, { refreshToken: false });
  const params = wire.writes[requestIndex].params as Record<string, unknown>;
  const expected = native.isChatGpt && speed ? (speed === 'fast' ? 'fast' : null) : undefined;
  assert.equal(Object.hasOwn(params, 'serviceTier'), expected !== undefined);
  assert.equal(params.serviceTier, expected);
}

for (const resume of [false, true]) {
  for (const native of nativeAccounts) {
    for (const speed of ['fast', 'standard', undefined] as const) {
      test(`native auto app-server ${resume ? 'resume' : 'start'} uses same-host ${native.name} for ${speed ?? 'inherit'}`, (t) =>
        checkNativeSpeed(t, resume, native, speed));
    }
  }
  for (const speed of ['fast', 'standard'] as const) {
    test(`native auto app-server ${resume ? 'resume' : 'start'} permits confirmed ChatGPT ${speed} without a snapshot`, (t) =>
      checkNativeSpeed(t, resume, nativeChatGpt, speed, true));
  }
}

for (const { name, output, code = 0, expected } of [
  { name: 'ChatGPT', output: 'Logged in using ChatGPT', expected: 'oauth' },
  { name: 'API key', output: 'Logged in using an API key', expected: 'api_key' },
  { name: 'no login', output: 'Not logged in', code: 1 },
  { name: 'unknown', output: 'Unrecognized status' },
  { name: 'ambiguous', output: 'Logged in using ChatGPT\nLogged in using an API key' },
  { name: 'failed inspection', output: 'Logged in using ChatGPT', code: 1 },
] as const) {
  test(`native login status rejects unverified speed evidence: ${name}`, async () => {
    const observed = await readCodexLoginAuthType({
      command: process.execPath,
      args: ['-e', `console.error(${JSON.stringify(output)}); process.exit(${code})`, '--'],
      cwd: process.cwd(),
      env: {},
    });
    assert.equal(observed, expected);
  });
}
