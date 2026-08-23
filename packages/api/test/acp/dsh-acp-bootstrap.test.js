// @ts-check

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const {
  buildDshMcpClientPlugins,
  dshOmitsAcpSessionMcp,
  isBareDshMcpClientPlugin,
  isDshHarnessCommand,
  prepareDshAcpSpawnForProject,
  resolveDshAcpStdioSpawn,
  mintDshCredentialFile,
  resolveDshMcpClientPluginName,
  writeDshAcpOverlayConfig,
} = await import('../../dist/domains/cats/services/agents/providers/acp/dsh-acp-bootstrap.js');

const RELATIVE_MCP_CLIENT = '../../packages/mcp/mcp-client/lib/index.js';

function writeDshFixture(root) {
  const binDir = join(root, 'packages', 'examples', 'acp-demo', 'lib');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'bin.js'), '#!/usr/bin/env node\n');
  const mcpClientLib = join(root, 'packages', 'mcp', 'mcp-client', 'lib');
  mkdirSync(mcpClientLib, { recursive: true });
  writeFileSync(
    join(root, 'packages', 'mcp', 'mcp-client', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-mcp-client', type: 'module', main: 'lib/index.js' }),
  );
  writeFileSync(join(mcpClientLib, 'index.js'), 'export default {}\n');
  const configDir = join(root, 'examples', 'acp-agent');
  mkdirSync(configDir, { recursive: true });
  const config = join(configDir, 'cordis.yml');
  writeFileSync(config, "- id: acp-agent\n  name: '@deepseek-ai/dsh-acp-demo'\n");
  return { bin: join(binDir, 'bin.js'), config, overlay: join(configDir, 'cat-cafe-dsh-acp.cordis.yml') };
}

describe('dsh ACP bootstrap', () => {
  it('treats dsh and dsh-acp-demo as the same harness family', () => {
    assert.equal(isDshHarnessCommand('dsh'), true);
    assert.equal(isDshHarnessCommand('dsh-acp-demo'), true);
    assert.equal(isDshHarnessCommand('/opt/dsh-acp-demo'), true);
    assert.equal(isDshHarnessCommand('grok'), false);
    assert.equal(dshOmitsAcpSessionMcp('dsh'), true);
    assert.equal(dshOmitsAcpSessionMcp('grok'), false);
  });

  it('resolves catalog `dsh` to the official ACP demo when CAT_CAFE_DSH_ROOT is set', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-acp-root-'));
    const { bin, config } = writeDshFixture(root);

    const spawn = resolveDshAcpStdioSpawn({
      command: 'dsh',
      args: ['--profile', 'headless'],
      env: { CAT_CAFE_DSH_ROOT: root, PATH: '/nonexistent' },
    });

    assert.equal(spawn.ok, true);
    if (!spawn.ok) return;
    assert.equal(spawn.command, process.execPath);
    assert.deepEqual(spawn.args, [bin]);
    assert.equal(spawn.baseConfigPath, config);
    assert.equal(spawn.env.DSH_PERMISSION_MODE, 'danger-full-access');
  });

  it('fails closed when no ACP demo is installed instead of spawning bare dsh', () => {
    const spawn = resolveDshAcpStdioSpawn({
      command: 'dsh',
      args: [],
      env: { PATH: '/nonexistent' },
    });
    assert.equal(spawn.ok, false);
    if (spawn.ok) return;
    assert.match(spawn.error.message, /dsh-acp-demo/);
    assert.match(spawn.error.message, /not `dsh --profile headless`/);
  });

  it('merges family MCP plugins including stdio env into the cordis overlay', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-overlay-'));
    const { config } = writeDshFixture(root);
    const outputPath = join(root, 'merged.cordis.yml');
    writeDshAcpOverlayConfig({
      baseConfigPath: config,
      servers: [
        {
          name: 'cat-cafe-memory',
          command: '/usr/bin/node',
          args: ['packages/mcp-server/dist/memory.js'],
          env: [{ name: 'CAT_CAFE_API_URL', value: 'http://127.0.0.1:9' }],
        },
      ],
      outputPath,
      pluginName: RELATIVE_MCP_CLIENT,
    });
    const yaml = readFileSync(outputPath, 'utf-8');
    assert.match(yaml, /id: acp-agent/);
    assert.match(yaml, /name: '\.\.\/\.\.\/packages\/mcp\/mcp-client\/lib\/index\.js'/);
    assert.doesNotMatch(yaml, /name: '@deepseek-ai\/dsh-mcp-client'/);
    assert.match(yaml, /serverName: 'cat-cafe-memory'/);
    assert.match(yaml, /transport: stdio/);
    assert.match(yaml, /command: '\/usr\/bin\/node'/);
    assert.match(yaml, /CAT_CAFE_API_URL: 'http:\/\/127\.0\.0\.1:9'/);
  });

  it('prepareDshAcpSpawnForProject writes a sibling overlay with relative mcp-client + family MCP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-prepare-'));
    const { bin, config, overlay } = writeDshFixture(root);
    const bootstrapCwd = join(root, 'boot');
    const projectRoot = mkdtempSync(join(tmpdir(), 'dsh-project-'));
    const prepared = await prepareDshAcpSpawnForProject({
      command: 'dsh',
      args: [],
      projectRoot,
      bootstrapCwd,
      mcpWhitelist: ['cat-cafe-memory'],
      mcpSupport: true,
      catId: 'dsh',
      env: {
        CAT_CAFE_DSH_ROOT: root,
        PATH: '/nonexistent',
        CAT_CAFE_API_URL: 'http://127.0.0.1:9',
      },
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal(prepared.command, process.execPath);
    assert.notEqual(prepared.command, 'dsh');
    assert.equal(prepared.args[0], bin);
    assert.equal(prepared.cwd, join(root, 'examples', 'acp-agent'));
    const configIdx = prepared.args.indexOf('--config');
    assert.ok(configIdx >= 0, 'spawn args must pass --config');
    assert.equal(prepared.args[configIdx + 1], overlay);
    assert.notEqual(prepared.args[configIdx + 1], config, 'Hub must not spawn official-only cordis.yml');
    const yaml = readFileSync(overlay, 'utf-8');
    assert.match(yaml, /id: acp-agent/);
    assert.match(yaml, /serverName: 'cat-cafe-memory'/);
    assert.match(yaml, /transport: stdio/);
    assert.match(yaml, /CAT_CAFE_API_URL: 'http:\/\/127\.0\.0\.1:9'/);
    assert.match(yaml, /CAT_CAFE_CREDENTIAL_FILE: !!js process\.env\.CAT_CAFE_CREDENTIAL_FILE/);
    assert.match(yaml, /CAT_CAFE_CAT_ID: 'dsh'/);
    assert.match(yaml, /failOnStartupError: true/);
    assert.doesNotMatch(yaml, /serverName: 'cat-cafe-limb'/);
    assert.doesNotMatch(yaml, /serverName: 'cat-cafe-audio'/);
    assert.doesNotMatch(yaml, /serverName: 'cat-cafe-finance'/);
    assert.match(yaml, /name: '\.\.\/\.\.\/packages\/mcp\/mcp-client\/lib\/index\.js'/);
    assert.doesNotMatch(yaml, /name: '@deepseek-ai\/dsh-mcp-client'/);
    assert.equal(prepared.env.CAT_CAFE_CREDENTIAL_FILE, undefined);
    assert.notEqual(mintDshCredentialFile(projectRoot, 'dsh'), mintDshCredentialFile(projectRoot, 'dsh'));
    assert.equal(resolveDshMcpClientPluginName(prepared.cwd, { CAT_CAFE_DSH_ROOT: root }), RELATIVE_MCP_CLIENT);
    assert.equal(isBareDshMcpClientPlugin(RELATIVE_MCP_CLIENT), false);
    assert.equal(isBareDshMcpClientPlugin('@deepseek-ai/dsh-mcp-client'), true);
  });

  it('skips Hub overlay when family MCP is requested but mcp-client entry is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-prepare-nomcp-'));
    const binDir = join(root, 'packages', 'examples', 'acp-demo', 'lib');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'bin.js'), '#!/usr/bin/env node\n');
    const configDir = join(root, 'examples', 'acp-agent');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'cordis.yml'), "- id: acp-agent\n  name: '@deepseek-ai/dsh-acp-demo'\n");
    const prepared = await prepareDshAcpSpawnForProject({
      command: 'dsh',
      args: [],
      projectRoot: mkdtempSync(join(tmpdir(), 'dsh-project-nomcp-')),
      bootstrapCwd: join(root, 'boot'),
      mcpWhitelist: ['cat-cafe-memory'],
      mcpSupport: true,
      catId: 'dsh',
      env: { CAT_CAFE_DSH_ROOT: root, PATH: '/nonexistent' },
    });
    assert.equal(prepared.ok, false);
    if (prepared.ok) return;
    assert.match(prepared.error.message, /mcp-client/);
    assert.match(prepared.error.message, /@deepseek-ai\/dsh-mcp-client/);
  });

  it('renders dsh-mcp-client plugins from ACP stdio MCP servers', () => {
    const yaml = buildDshMcpClientPlugins(
      [
        {
          name: 'cat-cafe-memory',
          command: '/usr/bin/node',
          args: ['packages/mcp-server/dist/memory.js'],
          env: [{ name: 'TOKEN', value: 'abc' }],
        },
      ],
      RELATIVE_MCP_CLIENT,
    );
    assert.match(yaml, /name: '\.\.\/\.\.\/packages\/mcp\/mcp-client\/lib\/index\.js'/);
    assert.doesNotMatch(yaml, /name: '@deepseek-ai\/dsh-mcp-client'/);
    assert.match(yaml, /serverName: 'cat-cafe-memory'/);
    assert.match(yaml, /transport: stdio/);
    assert.match(yaml, /command: '\/usr\/bin\/node'/);
    assert.match(yaml, /TOKEN: 'abc'/);
    assert.match(yaml, /failOnStartupError: true/);
  });

  it('omits blockedCats family servers from the overlay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-blocked-'));
    const { overlay } = writeDshFixture(root);
    const projectRoot = mkdtempSync(join(tmpdir(), 'dsh-project-blocked-'));
    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.cat-cafe', 'capabilities.json'),
      JSON.stringify({
        version: 2,
        capabilities: [
          {
            id: 'cat-cafe-collab',
            type: 'mcp',
            enabled: true,
            globalEnabled: true,
            source: 'builtin',
            blockedCats: ['dsh'],
          },
        ],
      }),
    );
    const prepared = await prepareDshAcpSpawnForProject({
      command: 'dsh',
      args: [],
      projectRoot,
      bootstrapCwd: join(root, 'boot'),
      mcpWhitelist: ['cat-cafe-memory', 'cat-cafe-collab', 'cat-cafe-signals'],
      mcpSupport: true,
      catId: 'dsh',
      env: { CAT_CAFE_DSH_ROOT: root, PATH: '/nonexistent', CAT_CAFE_API_URL: 'http://127.0.0.1:9' },
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const yaml = readFileSync(overlay, 'utf-8');
    assert.match(yaml, /serverName: 'cat-cafe-memory'/);
    assert.match(yaml, /serverName: 'cat-cafe-signals'/);
    assert.doesNotMatch(yaml, /serverName: 'cat-cafe-collab'/);
  });

  it('skips DSH when the composition dir is not writable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-readonly-'));
    const { overlay } = writeDshFixture(root);
    const configDir = join(root, 'examples', 'acp-agent');
    chmodSync(configDir, 0o555);
    try {
      const prepared = await prepareDshAcpSpawnForProject({
        command: 'dsh',
        args: [],
        projectRoot: mkdtempSync(join(tmpdir(), 'dsh-project-ro-')),
        bootstrapCwd: join(root, 'boot'),
        mcpWhitelist: ['cat-cafe-memory'],
        mcpSupport: true,
        catId: 'dsh',
        env: { CAT_CAFE_DSH_ROOT: root, PATH: '/nonexistent' },
      });
      assert.equal(prepared.ok, false);
      if (prepared.ok) return;
      assert.match(prepared.error.message, /overlay could not be written/);
    } finally {
      chmodSync(configDir, 0o755);
    }
    assert.equal(existsSync(overlay), false);
  });
});
