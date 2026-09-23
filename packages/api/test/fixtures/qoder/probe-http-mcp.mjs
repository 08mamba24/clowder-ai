/**
 * Installed-carrier, auth-free MCP initialization probe. Usage:
 * node test/fixtures/qoder/probe-http-mcp.mjs /absolute/path/to/qoderclicn.js
 *
 * Proves native descriptor/header support and scans generated output/files.
 * Does NOT prove a model-driven tool call or live AC1; no real account is used.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const binary = process.argv[2];
assert.ok(binary && isAbsolute(binary), 'pass an absolute installed CLI JavaScript path');
const root = mkdtempSync(join(tmpdir(), 'qoder-http-mcp-probe-'));
const profile = join(root, 'profile');
const home = join(root, 'home');
const workspace = join(root, 'workspace');
for (const path of [profile, home, workspace]) mkdirSync(path);
const token = 'h'.repeat(43);
const requests = [];
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let data = '';
  for await (const chunk of req) data += chunk;
  const message = JSON.parse(data);
  requests.push({ method: message.method, authorized: req.headers.authorization === `Bearer ${token}` });
  if (message.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'synthetic-read', version: '1' },
        }
      : {
          tools: [
            {
              name: 'github_read',
              description: 'Synthetic local read',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const config = join(root, 'mcp.json');
writeFileSync(
  config,
  JSON.stringify({
    mcpServers: {
      'clowder-repository-read': {
        type: 'http',
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  }),
  { mode: 0o600 },
);
const args = [
  binary,
  '--config-dir',
  profile,
  '--mcp-config',
  config,
  '--strict-mcp-config',
  '--allowed-mcp-server-names',
  'clowder-repository-read',
  '--allowed-tools',
  'mcp__clowder-repository-read__github_read',
  '--setting-sources',
  'user',
  '--tools',
  '',
  '-p',
  'Synthetic local initialization only',
  '-o',
  'stream-json',
  '-m',
  'Auto',
];
const child = spawn(process.execPath, args, {
  cwd: workspace,
  env: {
    PATH: '/usr/bin:/bin',
    HOME: home,
    TMPDIR: root,
    QODERCN_CONFIG_DIR: profile,
    QODERCN_FORCE_ENCRYPTED_FILE_STORAGE: 'true',
    QODERCN_FORCE_FILE_STORAGE: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '',
  stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});
let killTimer;
const timer = setTimeout(() => {
  child.kill('SIGTERM');
  killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
}, 20000);
let terminal;
try {
  terminal = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
} finally {
  clearTimeout(timer);
  clearTimeout(killTimer);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
function leaks(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const file = join(path, entry.name);
    return entry.isDirectory()
      ? leaks(file)
      : entry.isFile() && file !== config && readFileSync(file).includes(token)
        ? [file]
        : [];
  });
}
const events = stdout
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
assert.ok(init, 'native CLI must initialize MCP before its expected account-auth failure');
assert.deepEqual(init.tools, ['mcp__clowder-repository-read__github_read']);
assert.deepEqual(init.mcp_servers, [{ name: 'clowder-repository-read', status: 'connected' }]);
assert.ok(requests.some((r) => r.method === 'tools/list'));
assert.ok(requests.every((r) => r.authorized));
assert.equal(`${stdout}${stderr}`.includes(token), false, 'header must stay out of stream and stderr');
assert.deepEqual(leaks(root), [], 'header must stay out of native logs, settings and session files');
assert.ok(
  events.some((e) => e.error === 'authentication_failed'),
  'probe must never use a real model account',
);
console.log(
  JSON.stringify(
    {
      root,
      terminal,
      binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
      nativeVersion: init.qodercli_version,
      requests,
      leakedFiles: [],
      outputLeak: false,
      scope: 'MCP init/discovery + account-error persistence; model-driven tools/call and live AC1 untested',
    },
    null,
    2,
  ),
);
