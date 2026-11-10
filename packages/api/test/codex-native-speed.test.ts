import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CodexSpeedValue } from '@cat-cafe/shared';
import type { RuntimeProviderProfile } from '../src/config/account-resolver.js';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { codexExecutionAccountSnapshot } from '../src/config/codex-execution-account.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import { F320AccountWire } from './helpers/f320-account-wire.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

for (const resume of [false, true]) {
  for (const { name, authType, speed, expected, omitSnapshot } of [
    { name: 'OAuth Fast', authType: 'oauth', speed: 'fast', expected: 'fast' },
    { name: 'OAuth Standard', authType: 'oauth', speed: 'standard', expected: null },
    { name: 'OAuth inherit', authType: 'oauth' },
    { name: 'API key', authType: 'api_key', speed: 'fast' },
    { name: 'unknown auth', authType: 'oauth', speed: 'fast', omitSnapshot: true },
  ] as const) {
    test(`native auto app-server ${resume ? 'resume' : 'start'} preserves ${name} speed eligibility`, async (t) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-native-speed-')));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const home = join(root, '.codex');
      mkdirSync(home);
      const account: RuntimeProviderProfile = {
        id: 'native-codex',
        authType,
        syntheticNative: true,
        envVars: { CODEX_HOME: home },
      };
      const launch = resolveCodexAccountLaunch(account, { cwd: root });
      assert.equal(launch.authMode, 'auto', 'native accounts leave login selection to Codex');
      const wire = new F320AccountWire({ model_provider: 'openai', sqlite_home: home });
      const service = new CodexAgentService({
        cliCommand: process.execPath,
        carrierMode: 'app_server',
        model: 'gpt-6.1-sol',
        l0CompilerFn: fakeL0Compiler,
        rawArchive: { append: async () => {} },
      });
      const events = [];
      for await (const event of service.invoke('native speed regression', {
        invocationId: `native-speed-${name}-${resume}`,
        workingDirectory: root,
        ...(resume ? { sessionId: 'fixture-thread' } : {}),
        requestedServiceTier: speed as CodexSpeedValue | undefined,
        codexAccountLaunch: launch,
        ...(!omitSnapshot ? { executionAccount: codexExecutionAccountSnapshot(account, launch) } : {}),
        agentCarrierSessionFactory: async (options) => {
          assert.equal(options.env?.CODEX_AUTH_MODE, 'auto');
          return wire;
        },
      }))
        events.push(event);
      assert.deepEqual(
        events.filter((event) => event.type === 'error'),
        [],
      );
      assert.ok(events.some((event) => event.type === 'done'));
      const request = wire.writes.find((message) => message.method === (resume ? 'thread/resume' : 'thread/start'));
      assert.ok(request, 'the real service must reach its thread RPC');
      const params = request.params as Record<string, unknown>;
      assert.equal(Object.hasOwn(params, 'serviceTier'), expected !== undefined);
      assert.equal(params.serviceTier, expected);
    });
  }
}
