import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { KimiAgentService } from '../dist/domains/cats/services/agents/providers/KimiAgentService.js';
import { prepareKimiMcpConfig } from '../dist/domains/cats/services/agents/providers/kimi-mcp-config.js';
import { NativePluginActions } from '../dist/domains/plugin/declared/native-plugin-actions.js';
import { invalidateCliCommand } from '../dist/utils/cli-resolve.js';
import { kimiNativeFixture } from './helpers/kimi-native-fixture.js';
import { collect, createMockProcess, emitEvents } from './helpers/provider-archive-test-helpers.js';

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function fixture(t) {
  const f = await kimiNativeFixture(t, { nested: false });
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'kimi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  environment(t, { PATH: `${bin}${delimiter}${process.env.PATH}` });
  invalidateCliCommand('kimi');
  t.after(() => invalidateCliCommand('kimi'));
  return f;
}

const callback = (f) => ({
  CAT_CAFE_CAT_ID: 'kimi',
  CAT_CAFE_THREAD_ID: 'thread-effective-kimi',
  CAT_CAFE_INVOCATION_ID: 'inv-effective-kimi',
  CAT_CAFE_CALLBACK_TOKEN: 'test-current-callback',
  CAT_CAFE_MCP_TRANSPORT: 'stdio',
  CAT_CAFE_API_URL: 'http://127.0.0.1:1',
  CAT_CAFE_EXECUTION_ID: 'exec-effective-kimi',
  CAT_CAFE_PROCESS_EXECUTION_OWNER: 'must-not-cross-spawn',
  KIMI_CODE_HOME: f.native,
});

test('Kimi service spawns the same effective environment that validated its native plugin MCP', async (t) => {
  const f = await fixture(t);
  const actions = new NativePluginActions(async () => assert.fail('no action dispatch belongs to this test'));
  const instance = f.root;
  const before = { ...process.env };
  actions.activate(
    {
      instance: { pluginInstanceId: instance },
      packageRecord: { manifest: { contributions: [{ type: 'mcp', id: 'native' }] } },
    },
    0,
    async () => ({}),
  );
  const references = actions.environmentReferences(instance, 'native');
  const issued = actions.environment(instance, 'native');
  const tokenKey = references.CLOWDER_PLUGIN_ACTION_TOKEN.slice(2, -1);
  const pathKey = references.CLOWDER_PLUGIN_ACTION_PATH.slice(2, -1);
  t.after(() => {
    actions.deactivateAll();
    for (const key of [tokenKey, pathKey]) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  });
  await f.put(f.registry, {
    version: 2,
    capabilities: [
      {
        id: 'plugin:effective:native',
        type: 'mcp',
        source: 'plugin',
        globalEnabled: true,
        mcpServer: { command: process.execPath, args: ['never-executed.js'], env: references },
      },
    ],
  });
  const accountNative = join(f.root, 'account-native');
  await f.put(join(accountNative, 'mcp.json'), { mcpServers: { accountOnly: { command: 'never-executed' } } });
  environment(t, { KIMI_API_KEY: 'host-key', KIMI_MODEL_THINKING_EFFORT: 'host-effort' });
  const child = createMockProcess();
  let launched;
  let emission;
  let credentialFile;
  const service = new KimiAgentService({
    model: 'kimi-code/kimi-for-coding',
    mcpServerPath: join(f.dist, 'index.js'),
    l0CompilerFn: async () => 'OWNED KIMI ENV TEST',
    spawnFn(_command, _args, options) {
      launched = options.env;
      const servers = JSON.parse(readFileSync(f.file, 'utf8')).mcpServers;
      assert.equal(
        servers.plugin__effective__native.env.CLOWDER_PLUGIN_ACTION_TOKEN,
        issued.CLOWDER_PLUGIN_ACTION_TOKEN,
      );
      assert.equal(servers.accountOnly.enabled, false, 'account-selected native HOME must supply the denial layer');
      credentialFile = launched.CAT_CAFE_CREDENTIAL_FILE;
      assert.equal(JSON.parse(readFileSync(credentialFile, 'utf8')).callbackToken, 'test-current-callback');
      emission = emitEvents(child, [{ role: 'assistant', content: 'ok' }]);
      return child;
    },
  });
  const messages = await collect(
    service.invoke('hello', {
      workingDirectory: f.cwd,
      callbackEnv: { ...callback(f), CAT_CAFE_KIMI_API_KEY: 'callback-key' },
      accountEnv: { KIMI_API_KEY: 'account-key', KIMI_CODE_HOME: accountNative },
      beforeProviderLaunch: async () => {
        process.env[tokenKey] = 'later-host-value';
      },
    }),
  );
  await emission;
  assert.deepEqual(
    messages.filter((message) => message.type === 'error'),
    [],
  );
  assert.ok(launched, 'the real service must reach spawnCli and its concrete spawn function');
  assert.equal(launched[tokenKey], issued.CLOWDER_PLUGIN_ACTION_TOKEN);
  assert.equal(launched[pathKey], issued.CLOWDER_PLUGIN_ACTION_PATH);
  assert.equal(launched.KIMI_API_KEY, 'account-key');
  assert.equal(launched.KIMI_MODEL_THINKING_EFFORT, undefined);
  assert.equal(launched.CAT_CAFE_EXECUTION_ID, 'exec-effective-kimi');
  assert.equal(launched.CAT_CAFE_PROCESS_EXECUTION_OWNER, undefined);
  assert.equal(launched.CAT_CAFE_CALLBACK_TOKEN, undefined);
  assert.equal(launched.PWD, f.cwd);
  assert.equal(launched.INIT_CWD, f.cwd);
  assert.equal(existsSync(credentialFile), false, 'the invocation owns and disposes its private credential file');
});

for (const variable of ['CAT_CAFE_CALLBACK_TOKEN', 'KIMI_MODEL_THINKING_EFFORT']) {
  test(`Kimi refuses an MCP reference to removed ${variable} before spawn`, async (t) => {
    const f = await fixture(t);
    environment(t, { [variable]: 'inherited-value-must-not-prove-a-removed-reference' });
    await f.put(f.registry, {
      version: 2,
      capabilities: [
        {
          id: 'removed-reference',
          type: 'mcp',
          source: 'external',
          globalEnabled: true,
          mcpServer: { command: process.execPath, env: { TOKEN: `\${${variable}}` } },
        },
      ],
    });
    let spawns = 0;
    const service = new KimiAgentService({
      model: 'kimi-code/kimi-for-coding',
      mcpServerPath: join(f.dist, 'index.js'),
      l0CompilerFn: async () => 'OWNED KIMI ENV TEST',
      spawnFn() {
        spawns++;
        assert.fail('missing authority must not spawn');
      },
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: f.cwd, callbackEnv: callback(f) }));
    assert.equal(spawns, 0);
    assert.ok(messages.some((message) => message.type === 'error' && message.error.includes(variable)));
    assert.equal(existsSync(f.file), false);
  });
}

test('an explicit Kimi child environment cannot borrow a missing reference from the Host', async (t) => {
  const f = await fixture(t);
  environment(t, { PR62_KIMI_HOST_ONLY: 'present-only-in-host' });
  await f.put(f.registry, {
    version: 2,
    capabilities: [
      {
        id: 'host-only',
        type: 'mcp',
        source: 'external',
        globalEnabled: true,
        mcpServer: { command: process.execPath, env: { TOKEN: '${PR62_KIMI_HOST_ONLY}' } },
      },
    ],
  });
  await assert.rejects(
    prepareKimiMcpConfig({
      workingDirectory: f.cwd,
      mcpServerPath: join(f.dist, 'index.js'),
      callbackEnv: callback(f),
      childEnv: { HOME: f.root, KIMI_CODE_HOME: f.native },
    }),
    /PR62_KIMI_HOST_ONLY/,
  );
  assert.equal(existsSync(f.file), false);
});
