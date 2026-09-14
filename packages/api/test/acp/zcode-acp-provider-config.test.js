import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';

const providers = await import('../../dist/domains/cats/services/agents/providers/acp/zcode-acp-provider-paths.js');

it('gives concurrent native processes private provider configs without changing session storage', () => {
  const home = mkdtempSync(join(tmpdir(), 'zcode-provider-'));
  const state = join(home, 'session-canary');
  writeFileSync(state, 'persistent history');
  const first = providers.createZcodeProviderConfig(home, {
    ZCODE_MODEL: 'GLM-5.3',
    ANTHROPIC_API_KEY: 'test-first',
    ANTHROPIC_BASE_URL: 'https://example.invalid/api/anthropic',
  });
  const second = providers.createZcodeProviderConfig(home, {
    ZCODE_MODEL: 'GLM-5.2',
    ZCODE_API_KEY: 'test-second',
  });
  assert.notEqual(first.path, second.path);
  assert.equal(statSync(first.path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(first.path)).mode & 0o777, 0o700);
  const config = JSON.parse(readFileSync(first.path, 'utf8')).config;
  assert.deepEqual(config.defaultModelSelection, { providerId: 'anthropic', modelId: 'GLM-5.3' });
  assert.equal(config.providerConfigRules.providerRules[0].config.access.apiKey, 'test-first');
  assert.equal(
    config.providerConfigRules.providerRules[0].config.api.baseUrl,
    'https://example.invalid/api/anthropic/v1',
  );
  assert.equal(
    JSON.parse(readFileSync(second.path, 'utf8')).config.providerConfigRules.providerRules[0].config.access.apiKey,
    'test-second',
  );
  first.dispose();
  assert.equal(existsSync(first.path), false);
  assert.equal(existsSync(second.path), true);
  assert.equal(readFileSync(state, 'utf8'), 'persistent history');
  second.dispose();
});

it('reclaims a dead process input while preserving a live process input and history', () => {
  const home = mkdtempSync(join(tmpdir(), 'zcode-provider-crash-'));
  const state = join(home, 'session-canary');
  writeFileSync(state, 'persistent history');
  const live = providers.createZcodeProviderConfig(home, { ZCODE_MODEL: 'GLM-5.3' });
  const moduleUrl = new URL(
    '../../dist/domains/cats/services/agents/providers/acp/zcode-acp-provider-paths.js',
    import.meta.url,
  ).href;
  const orphan = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { createZcodeProviderConfig } from ${JSON.stringify(moduleUrl)};
     console.log(createZcodeProviderConfig(${JSON.stringify(home)}, { ZCODE_MODEL: 'GLM-5.3', ANTHROPIC_API_KEY: 'dummy-orphan' }).path);`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(orphan.status, 0, orphan.stderr);
  const orphanPath = orphan.stdout.trim();
  assert.equal(existsSync(orphanPath), true);
  const next = providers.createZcodeProviderConfig(home, { ZCODE_MODEL: 'GLM-5.3' });
  assert.equal(existsSync(orphanPath), false);
  assert.equal(existsSync(live.path), true);
  assert.equal(readFileSync(state, 'utf8'), 'persistent history');
  live.dispose();
  next.dispose();
});
