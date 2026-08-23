/**
 * DeepSeek Harness (`dsh`) speaks ACP only through the official automation
 * server (`dsh-acp-demo`). Catalog identity stays `dsh`; spawn never talks
 * JSON-RPC to `dsh --profile headless`. Missing demo/composition → skip.
 *
 * Official ACP rejects non-empty session/new.mcpServers. Extra dsh-mcp-client
 * plugins are not in the ACP demo graph and fail initialize, so Hub `--config`
 * is the official `examples/acp-agent/cordis.yml`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, delimiter, isAbsolute, join } from 'node:path';
import { formatCliNotFoundError, resolveCliCommandOrBare } from '../../../../../../utils/cli-resolve.js';
import type { AcpMcpServer, AcpMcpServerHttp, AcpMcpServerStdio } from './types.js';

const DSH_HARNESS_BASENAMES = new Set(['dsh', 'dsh-acp-demo']);

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

/**
 * Resolve the official ACP stdio binary and the composition the demo can load.
 *
 * The ACP demo's plugin graph cannot load extra `@deepseek-ai/dsh-mcp-client`
 * entries (pnpm-isolated; inserting them fails `cordis:include` at initialize).
 * Hub therefore passes the official `examples/acp-agent/cordis.yml` — the same
 * argv that handshake-succeeds. Family MCP stays on the catalog whitelist +
 * session omit (the protocol rejects non-empty session/new.mcpServers).
 */
export async function prepareDshAcpSpawnForProject(input: PrepareDshAcpSpawnInput): Promise<DshAcpStdioSpawnResult> {
  const env = input.env ?? process.env;
  const binary = resolveDshAcpStdioBinary(input.command, input.args, env);
  if (!binary.ok) return binary;

  return {
    ok: true,
    command: binary.command,
    args: [...withoutConfigArgs(binary.args), '--config', binary.baseConfigPath],
    env: binary.env,
    overlayPath: binary.baseConfigPath,
    baseConfigPath: binary.baseConfigPath,
    cwd: dirname(binary.baseConfigPath),
  };
}

export function resolveDshAcpStdioSpawn(input: {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
}): { ok: true; command: string; args: string[]; env: Record<string, string>; baseConfigPath: string } | { ok: false; error: Error } {
  return resolveDshAcpStdioBinary(input.command, input.args, input.env ?? process.env);
}

export function writeDshAcpOverlayConfig(input: {
  baseConfigPath: string;
  servers: readonly AcpMcpServer[];
  outputPath: string;
  pluginName?: string;
}): string {
  const base = readFileSync(input.baseConfigPath, 'utf-8');
  const plugins = buildDshMcpClientPlugins(input.servers, input.pluginName);
  const merged = plugins ? `${base.replace(/\s*$/, '')}\n\n# cat-cafe family MCP via dsh-mcp-client\n${plugins}` : base;
  const dir = dirname(input.outputPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${input.outputPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, merged.endsWith('\n') ? merged : `${merged}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tempPath, input.outputPath);
  return input.outputPath;
}

export function buildDshMcpClientPlugins(servers: readonly AcpMcpServer[], pluginName?: string): string {
  const name = pluginName ?? '@deepseek-ai/dsh-mcp-client';
  const lines: string[] = [];
  for (const server of servers) {
    if (isStdioMcpServer(server)) lines.push(...stdioPluginLines(server, name));
    else if (isHttpMcpServer(server)) lines.push(...httpPluginLines(server, name));
  }
  return lines.join('\n');
}

/** @deprecated Use buildDshMcpClientPlugins — composition entries for --config merge. */
export function buildDshMcpClientInserts(servers: readonly AcpMcpServer[]): string {
  return buildDshMcpClientPlugins(servers);
}

function resolveDshAcpStdioBinary(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { ok: true; command: string; args: string[]; env: Record<string, string>; baseConfigPath: string } | { ok: false; error: Error } {
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

function resolveDshMcpClientPluginName(env: NodeJS.ProcessEnv): string {
  const root = env.CAT_CAFE_DSH_ROOT?.trim();
  if (root) {
    const local = join(root, 'packages', 'mcp', 'mcp-client');
    if (existsSync(join(local, 'package.json'))) return local;
  }
  return '@deepseek-ai/dsh-mcp-client';
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

function isStdioMcpServer(server: AcpMcpServer): server is AcpMcpServerStdio {
  return 'command' in server && typeof server.command === 'string' && !('type' in server);
}

function isHttpMcpServer(server: AcpMcpServer): server is AcpMcpServerHttp {
  return 'type' in server && server.type === 'http';
}

function stdioPluginLines(server: AcpMcpServerStdio, pluginName: string): string[] {
  const id = sanitizeYamlId(server.name);
  const lines = [
    `- id: mcp-${id}`,
    `  name: ${yamlQuote(pluginName)}`,
    '  config:',
    `    serverName: ${yamlQuote(server.name)}`,
    '    transport: stdio',
    `    command: ${yamlQuote(server.command)}`,
  ];
  if (server.args.length > 0) {
    lines.push(`    args: [${server.args.map(yamlQuote).join(', ')}]`);
  }
  appendEnvLines(lines, server.env);
  return lines;
}

function httpPluginLines(server: AcpMcpServerHttp, pluginName: string): string[] {
  const id = sanitizeYamlId(server.name);
  const lines = [
    `- id: mcp-${id}`,
    `  name: ${yamlQuote(pluginName)}`,
    '  config:',
    `    serverName: ${yamlQuote(server.name)}`,
    '    transport: streamable-http',
    `    url: ${yamlQuote(server.url)}`,
  ];
  if (server.headers.length > 0) {
    lines.push('    headers:');
    for (const header of server.headers) {
      lines.push(`      ${header.name}: ${yamlQuote(header.value)}`);
    }
  }
  return lines;
}

function appendEnvLines(lines: string[], env: AcpMcpServerStdio['env']): void {
  if (!env || env.length === 0) return;
  lines.push('    env:');
  for (const entry of env) {
    lines.push(`      ${entry.name}: ${yamlQuote(entry.value)}`);
  }
}

function sanitizeYamlId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'server';
}

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
