// @ts-check
// Factory-level regression: the wiring assertions below run against the REAL
// AcpServiceFactory pool clients (pool.clientFactory()), not hand-crafted fakes —
// they exist to catch a merge that drops bootstrap env, per-attempt credentials,
// or forced retirement from the actual factory path again (R2 review P2).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const { createAcpServiceForConfig } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js'
);
const { applyZcodeHarnessSpawn } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/zcode/zcode-acp-bootstrap.js'
);

const pools = new Map();
const roots = [];
const catConfig = (id, model) => ({
  id,
  name: id,
  displayName: id,
  color: { primary: '#111827', secondary: '#e5e7eb' },
  avatar: '/avatars/default.png',
  mentionPatterns: [],
  roleDescription: 'factory wiring regression',
  clientId: 'acp',
  defaultModel: model,
  mcpSupport: false,
});

after(async () => {
  await Promise.allSettled([...pools.values()].map((pool) => pool.closeAll?.()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('factory-created client wiring (R2 review regression)', () => {
  it('threads ZCode bootstrap env into the actual pool client and forces single-flight', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-factory-zcode-'));
    roots.push(root);
    const project = join(root, 'project');
    mkdirSync(project);
    const zcodeBin = join(root, 'zcode.cjs');
    writeFileSync(zcodeBin, '#!/usr/bin/env node\nthrow new Error("MUST NEVER SPAWN");\n');
    const prev = {
      CAT_CAFE_ZCODE_BIN: process.env.CAT_CAFE_ZCODE_BIN,
      CAT_CAFE_ZCODE_HOME: process.env.CAT_CAFE_ZCODE_HOME,
      ZCODE_MODEL: process.env.ZCODE_MODEL,
      ZCODE_BIN: process.env.ZCODE_BIN,
    };
    process.env.CAT_CAFE_ZCODE_BIN = zcodeBin;
    process.env.CAT_CAFE_ZCODE_HOME = join(root, 'zcode-home');
    delete process.env.ZCODE_MODEL;
    delete process.env.ZCODE_BIN;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    if (prevKey === undefined) process.env.ANTHROPIC_API_KEY = 'synthetic-fixture-only';
    const poolsLocal = new Map();
    try {
      const service = await createAcpServiceForConfig({
        projectRoot: project,
        profileId: 'zcode-wiring',
        config: catConfig('zcode-wiring', 'GLM-5.2'),
        effectiveModel: 'GLM-5.2',
        acpConfig: { command: 'zcode', startupArgs: [], mcpWhitelist: [], supportsMultiplexing: true },
        poolRegistry: poolsLocal,
        bootstrapRoot: join(root, 'bootstrap'),
        log: { info() {}, warn() {} },
      });
      assert.ok(service, 'zcode member with prepared env must register, not return zcode-provider-unready');
      const pool = poolsLocal.get('zcode-wiring');
      const client = pool.clientFactory();
      assert.equal(client.config.env.ZCODE_MODEL, 'GLM-5.2');
      assert.equal(client.config.env.ZCODE_BIN, zcodeBin);
      assert.equal(client.config.retireAfterLease, true);
      assert.equal(pool.supportsMultiplexing, false);
      assert.equal(JSON.parse(pool.spawnSignature).supportsMultiplexing, false);
      await service.disposeHostService();
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('mints per-attempt DSH credentials and forbids warm reuse on factory-created clients', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-factory-dsh-'));
    roots.push(root);
    const project = join(root, 'project');
    mkdirSync(project);
    const dshRoot = join(root, 'dsh');
    mkdirSync(join(dshRoot, 'packages/examples/acp-demo/lib'), { recursive: true });
    writeFileSync(join(dshRoot, 'packages/examples/acp-demo/lib/bin.js'), '#!/usr/bin/env node\nthrow new Error("MUST NEVER SPAWN");\n');
    mkdirSync(join(dshRoot, 'packages/mcp/mcp-client/lib'), { recursive: true });
    writeFileSync(
      join(dshRoot, 'packages/mcp/mcp-client/package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-mcp-client', type: 'module', main: 'lib/index.js' }),
    );
    writeFileSync(join(dshRoot, 'packages/mcp/mcp-client/lib/index.js'), 'export default {}\n');
    mkdirSync(join(dshRoot, 'examples/acp-agent'), { recursive: true });
    writeFileSync(
      join(dshRoot, 'examples/acp-agent/cordis.yml'),
      "- id: acp-agent\n  name: '@deepseek-ai/dsh-acp-demo'\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-pro\n",
    );
    const prevRoot = process.env.CAT_CAFE_DSH_ROOT;
    const prevCreds = process.env.CAT_CAFE_MCP_CREDS_DIR;
    process.env.CAT_CAFE_DSH_ROOT = dshRoot;
    process.env.CAT_CAFE_MCP_CREDS_DIR = join(root, 'credentials');
    const poolsLocal = new Map();
    try {
      const service = await createAcpServiceForConfig({
        projectRoot: project,
        profileId: 'dsh-wiring',
        config: catConfig('dsh-wiring', 'test-model'),
        effectiveModel: 'test-model',
        acpConfig: {
          command: 'dsh',
          startupArgs: [],
          mcpWhitelist: [],
          supportsMultiplexing: true,
          pool: { maxLiveProcesses: 1 },
        },
        poolRegistry: poolsLocal,
        bootstrapRoot: join(root, 'bootstrap'),
        log: { info() {}, warn() {} },
      });
      assert.ok(service);
      const pool = poolsLocal.get('dsh-wiring');
      const first = pool.clientFactory();
      assert.ok(
        first.mcpCredentialFile?.startsWith(join(root, 'credentials')),
        'factory client must carry a minted credential file',
      );
      assert.equal(first.config.retireAfterLease, true);
      assert.equal(first.isSafeForSingleFlightReuse, false);
      assert.equal(pool.supportsMultiplexing, false);
      assert.equal(JSON.parse(pool.spawnSignature).supportsMultiplexing, false);
      const second = pool.clientFactory();
      assert.notEqual(first.mcpCredentialFile, second.mcpCredentialFile, 'each attempt gets fresh credentials');
      assert.equal(second.config.retireAfterLease, true);
      await service.disposeHostService();
    } finally {
      if (prevRoot === undefined) delete process.env.CAT_CAFE_DSH_ROOT;
      else process.env.CAT_CAFE_DSH_ROOT = prevRoot;
      if (prevCreds === undefined) delete process.env.CAT_CAFE_MCP_CREDS_DIR;
      else process.env.CAT_CAFE_MCP_CREDS_DIR = prevCreds;
    }
  });
});
