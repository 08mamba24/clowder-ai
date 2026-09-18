#!/usr/bin/env node

// Regression for the 2026-09-18 F317 incident: the controlled Qoder memory
// MCP never completed MCP initialize under the REAL Seatbelt policy, because
// pnpm workspace symlinks resolve to <runtimeRoot>/packages/<dep> realpaths
// that the legacy memory policy denied — node ESM resolution inside the
// sandbox threw ERR_MODULE_NOT_FOUND, the MCP process exited, and the qoder
// init gate failed closed on every controlled invocation (live 0% usable).
//
// Three locks:
//   1. resolveWorkspaceDependencyRoots walks the runtime layout (symlinks,
//      transitive deps, manifest cycles) — unit-tested on a fixture tree.
//   2. The REAL repo memory MCP completes `initialize` under the REAL
//      wrapper + sandbox-exec with the closure policy (darwin only).
//   3. The legacy surface (workspaceDependencyRoots: []) reproduces the
//      incident — the MCP cannot boot. This negative control proves the
//      test exercises the dependency surface rather than passing vacuously,
//      and it is the red evidence for the fix.

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildQoderMemorySeatbeltPolicy,
  buildQoderMemoryShimScript,
  isPathWithin,
  resolveWorkspaceDependencyRoots,
} from '../dist/domains/cats/services/agents/providers/qoderSandboxPolicy.js';

const here = import.meta.dirname;
const repoRoot = resolveRepoRoot();

function resolveRepoRoot() {
  // packages/api/test -> repo root (three levels up).
  let cursor = here;
  for (let i = 0; i < 3; i += 1) cursor = join(cursor, '..');
  return realpathSync(cursor);
}

describe('resolveWorkspaceDependencyRoots — runtime layout walk', () => {
  it('follows pnpm workspace symlinks transitively, tolerates cycles, skips non-workspace and missing deps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qoder-policy-deps-'));
    try {
      const runtimeRoot = join(dir, 'runtime');
      const makePackage = (name, dependencies) => {
        const packageRoot = join(runtimeRoot, 'packages', name);
        mkdirSync(join(packageRoot, 'dist'), { recursive: true });
        writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name, dependencies }));
        return packageRoot;
      };
      const entry = makePackage('mcp-server', {
        '@cat-cafe/shared': 'workspace:*',
        'external-thing': '^1.0.0',
        'not-installed': '^1.0.0',
      });
      const shared = makePackage('shared', { '@cat-cafe/finance': 'workspace:*' });
      const finance = makePackage('finance', { '@cat-cafe/shared': 'workspace:*' }); // cycle back to shared
      makePackage('unused-sibling', {});

      const scopedModules = join(runtimeRoot, 'node_modules', '@cat-cafe');
      mkdirSync(scopedModules, { recursive: true });
      symlinkSync(realpathSync(shared), join(scopedModules, 'shared'));
      symlinkSync(realpathSync(finance), join(scopedModules, 'finance'));
      const externalDir = join(runtimeRoot, 'node_modules', 'external-thing');
      mkdirSync(externalDir, { recursive: true });
      writeFileSync(join(externalDir, 'package.json'), JSON.stringify({ name: 'external-thing' }));

      const roots = resolveWorkspaceDependencyRoots(runtimeRoot, entry).map((root) => root);

      const expected = new Set([realpathSync(shared), realpathSync(finance)]);
      assert.deepEqual(
        new Set(roots),
        expected,
        `closure must be exactly the workspace siblings: ${JSON.stringify(roots)}`,
      );
      assert.ok(!roots.includes(realpathSync(entry)), 'entry package must not be re-added');
      assert.ok(!roots.includes(realpathSync(externalDir)), 'registry deps live under node_modules, not the closure');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins the real repo closure: every @cat-cafe runtime dependency of mcp-server is covered', () => {
    const entryRoot = join(repoRoot, 'packages', 'mcp-server');
    const manifest = JSON.parse(readFileSync(join(entryRoot, 'package.json'), 'utf8'));
    const workspaceDeps = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@cat-cafe/'));
    assert.ok(workspaceDeps.length > 0, 'mcp-server is expected to have workspace dependencies');

    const roots = new Set(resolveWorkspaceDependencyRoots(repoRoot, entryRoot));
    for (const name of workspaceDeps) {
      const resolved = realpathSync(join(repoRoot, 'node_modules', name));
      assert.ok(roots.has(resolved), `workspace dependency ${name} (${resolved}) must be in the closure`);
    }
    for (const root of roots) {
      assert.ok(
        // Same component-aware semantics as the production filter
        // (qoderSandboxPolicy.ts): startsWith would accept sibling
        // "packages-escape" style paths as subtree members.
        isPathWithin(join(repoRoot, 'packages'), root),
        `closure root outside the runtime packages tree is a policy widening: ${root}`,
      );
    }
  });
});

// ---- Real Seatbelt initialize (darwin only) ----
const itSeatbelt = process.platform === 'darwin' ? it : it.skip;

function runMemoryShimUnderPolicy({ policyText, dir }) {
  const scratchDir = join(dir, 'scratch');
  const homeDir = join(scratchDir, 'home');
  const mcpDataDir = join(scratchDir, 'mcp-data');
  const workspace = join(dir, 'workspace');
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  mkdirSync(mcpDataDir, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'canary.txt'), 'workspace-canary\n');

  const memoryMcpServerPath = join(repoRoot, 'packages', 'mcp-server', 'dist', 'memory.js');
  const memoryShimPath = join(dir, 'memory-shim');
  const policyPath = join(dir, 'memory.sb');
  writeFileSync(memoryShimPath, buildQoderMemoryShimScript(memoryMcpServerPath), {
    encoding: 'utf8',
    mode: 0o700,
  });
  writeFileSync(policyPath, policyText, { encoding: 'utf8', mode: 0o600 });

  const initializeRequest = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'seatbelt-regression', version: '0.0.0' },
    },
  })}\n`;

  const wrapper = join(repoRoot, 'scripts', 'qoder-shell-sandbox.mjs');
  return spawnSync(process.execPath, [wrapper, memoryShimPath], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: homeDir,
      TMPDIR: scratchDir,
      ALLOWED_WORKSPACE_DIRS: workspace,
      CAT_CAFE_DATA_DIR: mcpDataDir,
      CAT_CAFE_READONLY: 'true',
      CAT_CAFE_READONLY_AGENT_KEY_UNION: 'false',
      CAT_CAFE_QODER_SANDBOX_BIN: '/usr/bin/sandbox-exec',
      CAT_CAFE_QODER_WORKSPACE_POLICY: policyPath,
      CAT_CAFE_QODER_MEMORY_POLICY: policyPath,
      CAT_CAFE_QODER_MEMORY_SHIM: memoryShimPath,
    },
    input: initializeRequest,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('memory MCP under the real Seatbelt memory policy (darwin)', () => {
  itSeatbelt('closure policy: memory shim completes MCP initialize', () => {
    const memoryMcpServerPath = join(repoRoot, 'packages', 'mcp-server', 'dist', 'memory.js');
    assert.ok(existsSync(memoryMcpServerPath), 'packages/mcp-server/dist/memory.js missing — build before testing');
    const dir = mkdtempSync(join(tmpdir(), 'qoder-memory-seatbelt-'));
    try {
      const policyText = buildQoderMemorySeatbeltPolicy({
        workspace: join(dir, 'workspace'),
        scratch: join(dir, 'scratch'),
        memoryMcpServerPath,
        runtimeRoot: repoRoot,
        memoryShimPath: join(dir, 'memory-shim'),
      });
      const result = runMemoryShimUnderPolicy({ policyText, dir });
      assert.ok(
        result.stdout.includes('"result"') && result.stdout.includes('"serverInfo"'),
        `memory MCP must answer initialize under the closure policy; stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  itSeatbelt('legacy surface (no workspace dependency roots): reproduces the incident, MCP cannot boot', () => {
    const memoryMcpServerPath = join(repoRoot, 'packages', 'mcp-server', 'dist', 'memory.js');
    assert.ok(existsSync(memoryMcpServerPath), 'packages/mcp-server/dist/memory.js missing — build before testing');
    const dir = mkdtempSync(join(tmpdir(), 'qoder-memory-seatbelt-legacy-'));
    try {
      const policyText = buildQoderMemorySeatbeltPolicy({
        workspace: join(dir, 'workspace'),
        scratch: join(dir, 'scratch'),
        memoryMcpServerPath,
        runtimeRoot: repoRoot,
        memoryShimPath: join(dir, 'memory-shim'),
        workspaceDependencyRoots: [],
      });
      const result = runMemoryShimUnderPolicy({ policyText, dir });
      assert.ok(
        !result.stdout.includes('"serverInfo"'),
        `legacy surface must NOT boot the MCP (negative control); stdout=${JSON.stringify(result.stdout)}`,
      );
      // Pin the incident signature itself (2026-09-18 live failure mode), so a
      // timeout or unrelated startup fault cannot pass this control vacuously:
      // the shim's node process must die on Seatbelt-blocked ESM resolution.
      assert.match(
        result.stderr ?? '',
        /ERR_MODULE_NOT_FOUND/,
        `legacy surface must fail via module resolution denial, not some other fault; stderr=${JSON.stringify(result.stderr)}`,
      );
      assert.notEqual(result.status, 0, 'the shim process must exit nonzero under the legacy surface');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
