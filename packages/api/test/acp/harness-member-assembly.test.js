// @ts-check

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_TEMPLATE_PATH = join(__dirname, '..', '..', '..', '..', 'cat-template.json');

const { createAcpServiceForConfig } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js'
);
const { resolveAcpMcpServers } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/acp-mcp-resolver.js'
);
const { getAcpConfig, loadCatConfig, toAllCatConfigs, _resetCachedConfig } = await import(
  '../../dist/config/cat-config-loader.js'
);
const { dshOmitsAcpSessionMcp } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/dsh-acp-bootstrap.js'
);

const SLIM_MCP = ['cat-cafe-memory', 'cat-cafe-collab', 'cat-cafe-signals'];

function isolateTemplate() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'harness-member-'));
  const templatePath = join(projectRoot, 'cat-template.json');
  copyFileSync(REPO_TEMPLATE_PATH, templatePath);
  return { projectRoot, templatePath };
}

function writeDshFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fixture-'));
  const binDir = join(root, 'packages', 'examples', 'acp-demo', 'lib');
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, 'bin.js');
  writeFileSync(bin, '#!/usr/bin/env node\n');
  const mcpClientLib = join(root, 'packages', 'mcp', 'mcp-client', 'lib');
  mkdirSync(mcpClientLib, { recursive: true });
  writeFileSync(
    join(root, 'packages', 'mcp', 'mcp-client', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-mcp-client', type: 'module', main: 'lib/index.js' }),
  );
  writeFileSync(join(mcpClientLib, 'index.js'), 'export default {}\n');
  const configDir = join(root, 'examples', 'acp-agent');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'cordis.yml'), "- id: acp-agent\n  name: '@deepseek-ai/dsh-acp-demo'\n");
  return { root, bin, overlay: join(configDir, 'cat-cafe-dsh-acp.cordis.yml') };
}

function withDshRoot(root, fn) {
  const prevRoot = process.env.CAT_CAFE_DSH_ROOT;
  const prevConfig = process.env.CAT_CAFE_DSH_ACP_CONFIG;
  process.env.CAT_CAFE_DSH_ROOT = root;
  delete process.env.CAT_CAFE_DSH_ACP_CONFIG;
  return fn().finally(() => {
    if (prevRoot === undefined) delete process.env.CAT_CAFE_DSH_ROOT;
    else process.env.CAT_CAFE_DSH_ROOT = prevRoot;
    if (prevConfig === undefined) delete process.env.CAT_CAFE_DSH_ACP_CONFIG;
    else process.env.CAT_CAFE_DSH_ACP_CONFIG = prevConfig;
  });
}

describe('Grok Build and DeepSeek Harness member assembly', () => {
  it('resolves Grok Build to ACP stdio and DSH to dsh-acp-demo with family MCP in --config', async () => {
    const { projectRoot, templatePath } = isolateTemplate();
    const fixture = writeDshFixture();
    const poolRegistry = new Map();
    _resetCachedConfig();
    await withDshRoot(fixture.root, async () => {
      try {
        const all = toAllCatConfigs(loadCatConfig(templatePath));
        const grok = all['grok-build'];
        const dsh = all.dsh;
        const deepseek = all.deepseek;
        assert.ok(grok, 'grok-build must exist in the template roster');
        assert.ok(dsh, 'dsh must exist in the template roster');
        assert.ok(deepseek, 'OpenCode 渊渊 must stay in the roster');
        assert.equal(grok.clientId, 'acp');
        assert.equal(dsh.clientId, 'acp');
        assert.equal(deepseek.clientId, 'opencode');
        assert.notEqual(dsh.id, deepseek.id);

        const grokAcp = getAcpConfig('grok-build', projectRoot);
        const dshAcp = getAcpConfig('dsh', projectRoot);
        assert.ok(grokAcp, 'grok-build must have an acp section');
        assert.ok(dshAcp, 'dsh must have an acp section');
        assert.equal(grokAcp.command, 'grok');
        assert.equal(dshAcp.command, 'dsh');
        assert.deepEqual(grokAcp.mcpWhitelist, SLIM_MCP);
        assert.deepEqual(dshAcp.mcpWhitelist, SLIM_MCP);
        assert.equal(dshOmitsAcpSessionMcp(dshAcp.command), true);
        assert.equal(dshOmitsAcpSessionMcp(grokAcp.command), false);

        const grokService = await createAcpServiceForConfig({
          projectRoot,
          profileId: 'grok-build',
          config: grok,
          acpConfig: grokAcp,
          poolRegistry,
          log: { info() {}, warn() {} },
        });
        const dshService = await createAcpServiceForConfig({
          projectRoot,
          profileId: 'dsh',
          config: dsh,
          acpConfig: dshAcp,
          poolRegistry,
          log: { info() {}, warn() {} },
        });

        assert.ok(grokService, 'Grok Build AgentService must not be skipped');
        assert.ok(dshService, 'DeepSeek Harness AgentService must not be skipped when ACP demo is present');
        assert.equal(grokService.catId, 'grok-build');
        assert.equal(dshService.catId, 'dsh');

        const grokSpawn = JSON.parse(grokService.pool.spawnSignature);
        const dshSpawn = JSON.parse(dshService.pool.spawnSignature);
        assert.equal(grokSpawn.cmd, 'grok');
        assert.ok(
          grokSpawn.args.includes('agent') && grokSpawn.args.includes('stdio'),
          `Grok spawn args must start ACP stdio, got ${JSON.stringify(grokSpawn.args)}`,
        );
        assert.notEqual(dshSpawn.cmd, 'dsh', 'must not speak ACP to the headless dsh CLI');
        assert.equal(dshSpawn.cmd, process.execPath);
        assert.equal(dshSpawn.args[0], fixture.bin);
        assert.equal(
          dshSpawn.cwd,
          join(fixture.root, 'examples', 'acp-agent'),
          'DSH ACP must spawn from the harness composition dir',
        );
        const configIdx = dshSpawn.args.indexOf('--config');
        assert.ok(configIdx >= 0, `DSH spawn must pass --config, got ${JSON.stringify(dshSpawn.args)}`);
        assert.equal(dshSpawn.args[configIdx + 1], fixture.overlay);
        assert.notEqual(
          dshSpawn.args[configIdx + 1],
          join(fixture.root, 'examples', 'acp-agent', 'cordis.yml'),
          'Hub argv must be the sibling overlay, not official-only cordis.yml',
        );
        const overlayYaml = readFileSync(fixture.overlay, 'utf-8');
        assert.match(overlayYaml, /serverName: 'cat-cafe-memory'/);
        assert.match(overlayYaml, /serverName: 'cat-cafe-collab'/);
        assert.match(overlayYaml, /serverName: 'cat-cafe-signals'/);
        assert.match(overlayYaml, /transport: stdio/);
        assert.match(overlayYaml, /CAT_CAFE_API_URL:/);
        assert.match(overlayYaml, /CAT_CAFE_CREDENTIAL_FILE:/);
        assert.match(overlayYaml, /failOnStartupError: true/);
        assert.doesNotMatch(overlayYaml, /serverName: 'cat-cafe-limb'/);
        assert.doesNotMatch(overlayYaml, /serverName: 'cat-cafe-audio'/);
        assert.doesNotMatch(overlayYaml, /serverName: 'cat-cafe-finance'/);
        assert.match(overlayYaml, /name: '\.\.\/\.\.\/packages\/mcp\/mcp-client\/lib\/index\.js'/);
        assert.ok(overlayYaml.includes('mcp-client'), 'plugin name must be a path containing mcp-client');
        assert.doesNotMatch(overlayYaml, /name: '@deepseek-ai\/dsh-mcp-client'/);
      } finally {
        await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
        _resetCachedConfig();
        rmSync(projectRoot, { recursive: true, force: true });
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  });

  it('skips DSH registration when the official ACP demo is missing', async () => {
    const { projectRoot, templatePath } = isolateTemplate();
    const poolRegistry = new Map();
    const prevRoot = process.env.CAT_CAFE_DSH_ROOT;
    const prevConfig = process.env.CAT_CAFE_DSH_ACP_CONFIG;
    const prevPath = process.env.PATH;
    delete process.env.CAT_CAFE_DSH_ROOT;
    delete process.env.CAT_CAFE_DSH_ACP_CONFIG;
    process.env.PATH = '/nonexistent';
    _resetCachedConfig();
    try {
      const all = toAllCatConfigs(loadCatConfig(templatePath));
      const dshAcp = getAcpConfig('dsh', projectRoot);
      assert.ok(dshAcp);
      const warnings = [];
      const dshService = await createAcpServiceForConfig({
        projectRoot,
        profileId: 'dsh',
        config: all.dsh,
        acpConfig: dshAcp,
        poolRegistry,
        log: {
          info() {},
          warn(_payload, message) {
            warnings.push(String(message ?? _payload));
          },
        },
      });
      assert.equal(dshService, null, 'missing dsh-acp-demo must skip, not spawn bare dsh');
      assert.ok(
        warnings.some((message) => message.includes('dsh-acp-demo') || message.includes('ACP stdio')),
        `skip warning should mention the ACP demo, got ${JSON.stringify(warnings)}`,
      );
    } finally {
      if (prevRoot === undefined) delete process.env.CAT_CAFE_DSH_ROOT;
      else process.env.CAT_CAFE_DSH_ROOT = prevRoot;
      if (prevConfig === undefined) delete process.env.CAT_CAFE_DSH_ACP_CONFIG;
      else process.env.CAT_CAFE_DSH_ACP_CONFIG = prevConfig;
      process.env.PATH = prevPath;
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
      _resetCachedConfig();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('resolves the slim cat-cafe MCP whitelist through the shipped ACP resolver', async () => {
    const { projectRoot } = isolateTemplate();
    try {
      const grokAcp = getAcpConfig('grok-build', projectRoot);
      const dshAcp = getAcpConfig('dsh', projectRoot);
      assert.ok(grokAcp && dshAcp);
      const grokServers = await resolveAcpMcpServers(projectRoot, grokAcp.mcpWhitelist ?? [], undefined, {
        mcpSupport: true,
        catId: 'grok-build',
      });
      const dshServers = await resolveAcpMcpServers(projectRoot, dshAcp.mcpWhitelist ?? [], undefined, {
        mcpSupport: true,
        catId: 'dsh',
      });
      const grokNames = grokServers.map((server) => server.name);
      const dshNames = dshServers.map((server) => server.name);
      assert.ok(
        grokNames.some((name) => name === 'cat-cafe' || name.startsWith('cat-cafe')),
        `Grok Build MCP resolve must include family servers, got ${grokNames.join(',')}`,
      );
      assert.ok(
        dshNames.some((name) => name === 'cat-cafe' || name.startsWith('cat-cafe')),
        `DeepSeek Harness MCP resolve must include family servers, got ${dshNames.join(',')}`,
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
