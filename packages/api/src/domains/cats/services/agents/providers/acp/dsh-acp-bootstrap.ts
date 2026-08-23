/**
 * DeepSeek Harness (`dsh`) speaks ACP only through the official automation
 * server (`dsh-acp-demo`). Catalog identity stays `dsh`; spawn never talks
 * JSON-RPC to `dsh --profile headless`. Missing demo/composition → skip.
 *
 * Official ACP rejects non-empty session/new.mcpServers. Hub writes a sibling
 * overlay next to `examples/acp-agent/cordis.yml` (config-dir baseUrl requires
 * that; a cat-cafe generated dir breaks initialize). Family MCP uses a
 * dot-relative path to `packages/mcp/mcp-client/lib/index.js`. Overlay MCP env
 * carries CAT_CAFE_CREDENTIAL_FILE; invoke rewrites that file.
 */
import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { formatCliNotFoundError, resolveCliCommandOrBare } from '../../../../../../utils/cli-resolve.js';
import { resolveAcpMcpServers, resolveDisabledServerIds } from './acp-mcp-resolver.js';
import { buildDshMcpClientInserts, buildDshMcpClientPlugins, writeDshAcpOverlayConfig } from './dsh-acp-overlay.js';
import type { AcpMcpServer, AcpMcpServerStdio } from './types.js';

export { buildDshMcpClientInserts, buildDshMcpClientPlugins, writeDshAcpOverlayConfig };

const DSH_HARNESS_BASENAMES = new Set(['dsh', 'dsh-acp-demo']);
const DSH_ACP_OVERLAY_FILENAME = 'cat-cafe-dsh-acp.cordis.yml';
const DSH_MCP_CLIENT_REL = join('packages', 'mcp', 'mcp-client');
const BARE_DSH_MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';

export function isDshHarnessCommand(command: string): boolean {
  return DSH_HARNESS_BASENAMES.has(basenameCommand(command));
}

export function dshOmitsAcpSessionMcp(command: string): boolean {
  return isDshHarnessCommand(command);
}

export type DshAcpStdioSpawnResult =
  | {
      ok: true;
      command: string;
      args: string[];
      env: Record<string, string>;
      overlayPath: string;
      baseConfigPath: string;
      cwd: string;
    }
  | { ok: false; error: Error };

export interface PrepareDshAcpSpawnInput {
  command: string;
  args: readonly string[];
  projectRoot: string;
  bootstrapCwd: string;
  mcpWhitelist: string[];
  mcpSupport: boolean;
  catId: string;
  env?: NodeJS.ProcessEnv;
}

export async function prepareDshAcpSpawnForProject(input: PrepareDshAcpSpawnInput): Promise<DshAcpStdioSpawnResult> {
  const env = input.env ?? process.env;
  const binary = resolveDshAcpStdioBinary(input.command, input.args, env);
  if (!binary.ok) return binary;

  const compositionDir = dirname(binary.baseConfigPath);
  const overlayPath = join(compositionDir, DSH_ACP_OVERLAY_FILENAME);
  const pluginName = resolveDshMcpClientPluginName(compositionDir, env);
  const credentialFile = resolveDshCredentialFile(input.projectRoot, input.catId, env);
  const servers = await resolveDshOverlayServers(input, env, credentialFile);
  if (servers.length > 0 && isBareDshMcpClientPlugin(pluginName)) {
    return {
      ok: false,
      error: new Error(
        'DeepSeek Harness ACP family MCP needs a filesystem path to packages/mcp/mcp-client/lib/index.js. The ACP demo cannot load @deepseek-ai/dsh-mcp-client. Set CAT_CAFE_DSH_ROOT to a deepseek-harness checkout.',
      ),
    };
  }

  try {
    writeDshAcpOverlayConfig({
      baseConfigPath: binary.baseConfigPath,
      servers,
      outputPath: overlayPath,
      pluginName: pluginName ?? BARE_DSH_MCP_CLIENT,
    });
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `DeepSeek Harness ACP overlay could not be written next to ${binary.baseConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }

  return {
    ok: true,
    command: binary.command,
    args: [...withoutConfigArgs(binary.args), '--config', overlayPath],
    env: { ...binary.env, CAT_CAFE_CREDENTIAL_FILE: credentialFile },
    overlayPath,
    baseConfigPath: binary.baseConfigPath,
    cwd: compositionDir,
  };
}

export function resolveDshAcpStdioSpawn(input: {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
}):
  | { ok: true; command: string; args: string[]; env: Record<string, string>; baseConfigPath: string }
  | { ok: false; error: Error } {
  return resolveDshAcpStdioBinary(input.command, input.args, input.env ?? process.env);
}

export function resolveDshMcpClientPluginName(
  overlayDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const entry = resolveDshMcpClientEntry(overlayDir, env);
  return entry ? toDotRelative(overlayDir, entry) : undefined;
}

export function isBareDshMcpClientPlugin(name: string | undefined): boolean {
  return !name || name === BARE_DSH_MCP_CLIENT || name.startsWith(`${BARE_DSH_MCP_CLIENT}/`);
}

export function resolveDshCredentialFile(
  projectRoot: string,
  catId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = env.CAT_CAFE_MCP_CREDS_DIR?.trim() || join(projectRoot, '.cat-cafe', 'mcp-creds');
  const safe = catId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'dsh';
  return join(dir, `dsh-${safe}.json`);
}

function resolveDshAcpStdioBinary(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
):
  | { ok: true; command: string; args: string[]; env: Record<string, string>; baseConfigPath: string }
  | { ok: false; error: Error } {
  const permissionEnv = { DSH_PERMISSION_MODE: env.DSH_PERMISSION_MODE?.trim() || 'danger-full-access' };
  const baseConfigPath = resolveDshAcpBaseConfig(env);
  const demoCommand = resolveDshAcpDemoCommand(command, env);

  if (!demoCommand) {
    return {
      ok: false,
      error: new Error(
        `${formatCliNotFoundError('dsh-acp-demo')} Hub dispatch requires the official ACP stdio server, not \`dsh --profile headless\`. Install \`@deepseek-ai/dsh-acp-demo\` or set CAT_CAFE_DSH_ROOT to a deepseek-harness checkout.`,
      ),
    };
  }
  if (!baseConfigPath) {
    return {
      ok: false,
      error: new Error(
        'DeepSeek Harness ACP composition not found. Set CAT_CAFE_DSH_ACP_CONFIG or CAT_CAFE_DSH_ROOT (examples/acp-agent/cordis.yml).',
      ),
    };
  }

  const demoArgs = basenameCommand(command) === 'dsh-acp-demo' ? withoutConfigArgs([...args]) : [];
  return {
    ok: true,
    command: demoCommand.command,
    args: [...demoArgs, ...demoCommand.prefixArgs],
    env: permissionEnv,
    baseConfigPath,
  };
}

function resolveDshAcpDemoCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): { command: string; prefixArgs: string[] } | undefined {
  if (basenameCommand(command) === 'dsh-acp-demo') {
    return { command, prefixArgs: [] };
  }
  const demoOnPath = whichCommand('dsh-acp-demo', env);
  if (demoOnPath) return { command: demoOnPath, prefixArgs: [] };
  const demoBin = resolveDshAcpDemoBin(env);
  if (demoBin) return { command: process.execPath, prefixArgs: [demoBin] };
  return undefined;
}

async function resolveDshOverlayServers(
  input: PrepareDshAcpSpawnInput,
  env: NodeJS.ProcessEnv,
  credentialFile: string,
): Promise<AcpMcpServer[]> {
  if (input.mcpSupport === false) return [];
  const disabled = resolveDisabledServerIds(input.projectRoot, input.catId);
  const resolved = await resolveAcpMcpServers(input.projectRoot, input.mcpWhitelist, undefined, {
    mcpSupport: true,
    catId: input.catId,
    disabledServerIds: disabled,
    env,
  });
  const spawnEnv: Record<string, string> = {
    CAT_CAFE_API_URL: env.CAT_CAFE_API_URL?.trim() || 'http://localhost:3004',
    CAT_CAFE_CREDENTIAL_FILE: credentialFile,
    CAT_CAFE_CAT_ID: input.catId,
  };
  const agentKey = env.CAT_CAFE_AGENT_KEY_FILE?.trim();
  if (agentKey) spawnEnv.CAT_CAFE_AGENT_KEY_FILE = agentKey;
  return resolved.map((server) => attachStdioSpawnEnv(server, spawnEnv));
}

function attachStdioSpawnEnv(server: AcpMcpServer, spawnEnv: Record<string, string>): AcpMcpServer {
  if (!('command' in server) || typeof server.command !== 'string' || 'type' in server) return server;
  const stdio = server as AcpMcpServerStdio;
  const envMap = new Map((stdio.env ?? []).map((entry) => [entry.name, entry.value]));
  for (const [name, value] of Object.entries(spawnEnv)) envMap.set(name, value);
  return { ...stdio, env: [...envMap.entries()].map(([name, value]) => ({ name, value })) };
}

function resolveDshMcpClientEntry(overlayDir: string, env: NodeJS.ProcessEnv): string | undefined {
  const roots: string[] = [];
  const fromEnv = env.CAT_CAFE_DSH_ROOT?.trim();
  if (fromEnv) roots.push(fromEnv);
  roots.push(join(overlayDir, '..', '..'));
  for (const root of roots) {
    const entry = join(root, DSH_MCP_CLIENT_REL, 'lib', 'index.js');
    if (existsSync(entry)) return entry;
  }
  return undefined;
}

function toDotRelative(fromDir: string, absoluteTarget: string): string {
  const rel = relative(fromDir, absoluteTarget).split('\\').join('/');
  if (!rel || rel === '.') return './index.js';
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function resolveDshAcpBaseConfig(env: NodeJS.ProcessEnv): string | undefined {
  const configPath = env.CAT_CAFE_DSH_ACP_CONFIG?.trim();
  if (configPath && existsSync(configPath)) return configPath;
  const fromRoot = env.CAT_CAFE_DSH_ROOT?.trim();
  if (fromRoot) {
    const candidate = join(fromRoot, 'examples', 'acp-agent', 'cordis.yml');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveDshAcpDemoBin(env: NodeJS.ProcessEnv): string | undefined {
  const fromRoot = env.CAT_CAFE_DSH_ROOT?.trim();
  if (fromRoot) {
    const candidate = join(fromRoot, 'packages', 'examples', 'acp-demo', 'lib', 'bin.js');
    if (existsSync(candidate)) return candidate;
  }
  const dshBin = whichCommand('dsh', env);
  if (!dshBin || !isAbsolute(dshBin)) return undefined;
  const nearby = join(dirname(dshBin), '..', 'packages', 'examples', 'acp-demo', 'lib', 'bin.js');
  return existsSync(nearby) ? nearby : undefined;
}

function whichCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (env === process.env) {
    const resolved = resolveCliCommandOrBare(command);
    if (resolved !== command && existsSync(resolved)) return resolved;
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function withoutConfigArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--config=')) continue;
    out.push(arg);
  }
  return out;
}

function basenameCommand(command: string): string {
  const trimmed = command.trim();
  const parts = trimmed.split(/[/\\]/);
  return (parts[parts.length - 1] ?? trimmed).replace(/\.(js|mjs|cjs|exe|cmd|bat)$/i, '');
}
