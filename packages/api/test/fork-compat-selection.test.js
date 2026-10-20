/**
 * Fork-compat wiring contract.
 *
 * A selection source is only real if both entrypoints consume it. This test
 * fails closed when CI, the local pre-merge gate, or the package scripts drift
 * apart, and when the resolver would silently shrink to an empty/foreign set.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const apiRoot = join(here, '..');
const apiPackage = JSON.parse(readFileSync(join(apiRoot, 'package.json'), 'utf8'));

const { loadForkCompatConfig, resolveForkCompatTests } = await import(
  join(apiRoot, 'scripts', 'resolve-fork-compat-tests.mjs')
);

const REQUIRED_GROUPS = [
  'qoder-memory-surface',
  'zcode-acp-contract',
  'dsh-acp-contract',
  'origin-upstream-composition',
  'mcp-toolset-callback-capability',
];

test('the fork-compat selection is non-empty, package-scoped, and de-duplicated', async () => {
  const result = await resolveForkCompatTests();
  assert.ok(result.selectedFiles.length > 0, 'fork-compat selection must not be empty');
  assert.equal(new Set(result.selectedFiles).size, result.selectedFiles.length, 'selection must be de-duplicated');
  assert.match(result.selectionHash, /^[0-9a-f]{64}$/);
  for (const group of REQUIRED_GROUPS) {
    assert.ok(result.groups.has(group), `missing fork contract group: ${group}`);
    const resolved = result.groups.get(group);
    assert.ok(resolved.files.length > 0, `empty fork contract group: ${group}`);
    assert.ok(['api', 'mcp-server'].includes(resolved.package), `unknown package for group: ${group}`);
  }
  assert.equal(result.groups.get('mcp-toolset-callback-capability').package, 'mcp-server');
  assert.ok(
    result.selectedFiles.includes('mcp-server:test/toolset-callback-capability.test.ts'),
    'the MCP capability projection suite must run in the same fixed fork entry',
  );
});

test('a config may only name packages and test paths the runner can execute', async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), 'fork-compat-config-')), 'fork-compat-tests.json');
  try {
    writeFileSync(
      configPath,
      JSON.stringify({ version: 2, groups: { bad: { package: 'web', files: ['test/x.test.js'] } } }),
    );
    await assert.rejects(() => loadForkCompatConfig({ configPath }), /package must be one of api, mcp-server/);

    writeFileSync(
      configPath,
      JSON.stringify({ version: 2, groups: { bad: { package: 'api', files: ['test/x.test.ts'] } } }),
    );
    await assert.rejects(() => loadForkCompatConfig({ configPath }), /entry must be a test path matching/);

    writeFileSync(
      configPath,
      JSON.stringify({
        version: 2,
        groups: { missing: { package: 'mcp-server', files: ['test/does-not-exist.test.ts'] } },
      }),
    );
    await assert.rejects(() => resolveForkCompatTests({ configPath }), /does not exist in packages\/mcp-server\/test/);
  } finally {
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
});

test('the CI Fork compatibility job runs the same selection entrypoint', () => {
  const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = /^ {2}fork-compat:\n/m.exec(ci);
  assert.ok(job, 'ci.yml must declare a named `fork-compat` job');
  const section = ci.slice(job.index);
  assert.match(section, /name: Fork compatibility/, 'the job needs a stable required-check name');
  assert.match(
    section,
    /run: pnpm --filter @cat-cafe\/api run test:fork-compat\n/,
    'CI must execute the shared test:fork-compat entrypoint, not a copied file list',
  );
});

test('the local pre-merge gate runs the prepared variant of the same selection', () => {
  const gate = readFileSync(join(repoRoot, 'scripts', 'pre-merge-check.sh'), 'utf8');
  assert.match(
    gate,
    /pnpm --filter @cat-cafe\/api run test:fork-compat:prepared/,
    'the public gate must execute the fork-compat selection after its own build stage',
  );
  assert.match(gate, /GATE_REQUIRED_STAGES="[^"]*fork-compat[^"]*"/, 'fork-compat must be a required gate stage');
});

test('the prepared entrypoint builds nothing; the full entrypoint builds MCP and API first', () => {
  assert.match(apiPackage.scripts['test:fork-compat:prepared'], /run-fork-compat-tests\.sh/);
  assert.doesNotMatch(apiPackage.scripts['test:fork-compat:prepared'], /\bbuild\b/);
  const full = apiPackage.scripts['test:fork-compat'];
  assert.match(full, /--dir \.\.\/mcp-server build/, 'the full entrypoint must rebuild the MCP projection source');
  assert.match(full, /pnpm run build/, 'the full entrypoint must rebuild the API dist before testing');
  assert.match(full, /run-fork-compat-tests\.sh/);
});

test('the shared runner executes every selected package with its own test command', () => {
  const runner = readFileSync(join(apiRoot, 'scripts', 'run-fork-compat-tests.sh'), 'utf8');
  assert.match(runner, /api:\*\) api_files\+=/, 'API selections must be dispatched by their package prefix');
  assert.match(
    runner,
    /mcp-server:\*\) mcp_server_files\+=/,
    'MCP selections must be dispatched by their package prefix',
  );
  assert.match(runner, /cd \.\.\/mcp-server/, 'MCP suites must run from the MCP package');
  assert.match(runner, /--import tsx/, 'MCP TypeScript capability tests must reuse the package loader');
  assert.match(
    runner,
    /\$\{api_files\[@\]\}/,
    'the runner must execute the resolved API files rather than a second hard-coded list',
  );
});
