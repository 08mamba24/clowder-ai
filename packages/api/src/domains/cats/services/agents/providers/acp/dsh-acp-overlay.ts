/**
 * Cordis overlay YAML for DeepSeek Harness ACP family MCP.
 * Overlay lives next to official cordis.yml; plugin names are filesystem paths.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AcpMcpServer, AcpMcpServerHttp, AcpMcpServerStdio } from './types.js';

const BARE_DSH_MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';

export function writeDshAcpOverlayConfig(input: {
  baseConfigPath: string;
  servers: readonly AcpMcpServer[];
  outputPath: string;
  pluginName?: string;
}): string {
  if (resolve(input.outputPath) === resolve(input.baseConfigPath)) {
    throw new Error('DSH ACP overlay must be a sibling of the official cordis.yml, not overwrite it');
  }
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
  const name = pluginName ?? BARE_DSH_MCP_CLIENT;
  const lines: string[] = [];
  for (const server of servers) {
    if (isStdioMcpServer(server)) lines.push(...stdioPluginLines(server, name));
    else if (isHttpMcpServer(server)) lines.push(...httpPluginLines(server, name));
  }
  return lines.join('\n');
}

/** @deprecated Use buildDshMcpClientPlugins. */
export function buildDshMcpClientInserts(servers: readonly AcpMcpServer[]): string {
  return buildDshMcpClientPlugins(servers);
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
  lines.push('    failOnStartupError: true');
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
  lines.push('    failOnStartupError: true');
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
