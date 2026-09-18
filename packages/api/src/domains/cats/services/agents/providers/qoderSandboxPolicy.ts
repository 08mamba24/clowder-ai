// Seatbelt policy primitives for the controlled Qoder sandbox.
//
// Incident this module encodes (2026-09-18, F317): the readonly memory MCP
// never started under the controlled policy because pnpm workspace symlinks
// resolve to their REAL paths under <runtimeRoot>/packages/<dep>, which the
// memory policy's allow list did not cover — node ESM resolution inside the
// sandbox failed with ERR_MODULE_NOT_FOUND, the MCP process exited, and the
// qoder init gate failed closed on every controlled invocation. The memory
// read surface must therefore equal the memory MCP's module-resolution
// closure: entry dist + node_modules + the workspace dependency roots derived
// from the runtime layout (never the whole runtime root, which carries
// deployment credentials).

import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const tail: string[] = [];
  let cursor = absolute;
  while (true) {
    try {
      // Policies may be built before every artifact exists (e.g. the memory
      // shim is written after its policy). Fall back to the deepest EXISTING
      // ancestor so symlinked prefixes (/var -> /private/var) still
      // canonicalize: a non-canonical allow can never override the canonical
      // deny of the same tree (2026-09-18 finding — the shim literal resolved
      // non-canonically and sandbox-exec denied its execution).
      return join(realpathSync(cursor), ...tail);
    } catch {
      if (cursor === dirname(cursor)) return absolute;
      tail.unshift(basename(cursor));
      cursor = dirname(cursor);
    }
  }
}

export function seatbeltLiteral(value: string): string {
  return JSON.stringify(value);
}

export function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function isPathWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export interface SeatbeltPolicyInput {
  deniedReadRoots: readonly string[];
  allowedReadRoots: readonly string[];
  allowedReadLiterals?: readonly string[];
  deniedReadRootsFinal?: readonly string[];
  deniedReadLiterals?: readonly string[];
  allowedWriteRoots: readonly string[];
  allowedWriteLiterals?: readonly string[];
  writeExclusions?: readonly string[];
  deniedWriteRoots?: readonly string[];
  deniedWriteLiterals?: readonly string[];
  deniedWriteUnlinkRoots?: readonly string[];
}

export function buildSeatbeltPolicy(input: SeatbeltPolicyInput): string {
  const unique = (values: readonly string[]) => [...new Set(values.map(canonicalPath))];
  const filters = (roots: readonly string[]) => unique(roots).map((root) => `(subpath ${seatbeltLiteral(root)})`);
  const readLiterals = unique(input.allowedReadLiterals ?? []);
  const metadataAncestors = unique([...input.allowedReadRoots, ...readLiterals]).flatMap((root) => {
    const ancestors: string[] = [];
    let cursor = root;
    while (cursor !== dirname(cursor)) {
      ancestors.push(cursor);
      cursor = dirname(cursor);
    }
    return ancestors;
  });
  const writeExclusions = unique(input.writeExclusions ?? []);
  const writeFilters = unique(input.allowedWriteRoots).map((root) => {
    const exclusions = writeExclusions.filter((candidate) => candidate !== root && isPathWithin(root, candidate));
    if (exclusions.length === 0) return `(subpath ${seatbeltLiteral(root)})`;
    return `(require-all (subpath ${seatbeltLiteral(root)}) ${exclusions
      .map((candidate) => `(require-not (subpath ${seatbeltLiteral(candidate)}))`)
      .join(' ')})`;
  });
  return [
    '(version 1)',
    '(allow default)',
    ...filters(input.deniedReadRoots).map((filter) => `(deny file-read* ${filter})`),
    ...unique(metadataAncestors).map((root) => `(allow file-read-metadata (literal ${seatbeltLiteral(root)}))`),
    ...filters(input.allowedReadRoots).map((filter) => `(allow file-read* ${filter})`),
    ...readLiterals.map((literal) => `(allow file-read* (literal ${seatbeltLiteral(literal)}))`),
    ...filters(input.deniedReadRootsFinal ?? []).map((filter) => `(deny file-read* ${filter})`),
    ...unique(input.deniedReadLiterals ?? []).map(
      (literal) => `(deny file-read* (literal ${seatbeltLiteral(literal)}))`,
    ),
    '(deny file-write*)',
    ...writeFilters.map((filter) => `(allow file-write* ${filter})`),
    ...unique(input.allowedWriteLiterals ?? []).map(
      (literal) => `(allow file-write* (literal ${seatbeltLiteral(literal)}))`,
    ),
    ...filters(input.deniedWriteRoots ?? []).map((filter) => `(deny file-write* ${filter})`),
    ...unique(input.deniedWriteLiterals ?? []).map(
      (literal) => `(deny file-write* (literal ${seatbeltLiteral(literal)}))`,
    ),
    ...filters(input.deniedWriteUnlinkRoots ?? []).map((filter) => `(deny file-write-unlink ${filter})`),
    '',
  ].join('\n');
}

/**
 * Workspace dependency roots reachable from an entry package's runtime
 * `dependencies`, as resolved by the runtime root's node_modules (pnpm
 * workspace symlinks point at `<runtimeRoot>/packages/<name>` real paths).
 * BFS with a visited set (manifest cycles are legal); only siblings under
 * `<runtimeRoot>/packages` widen the surface — registry dependencies already
 * live under the allowed `node_modules` root, and anything outside the
 * packages tree is not part of this pnpm layout. A new workspace dependency
 * is picked up automatically; the Seatbelt initialize regression test fails
 * loudly if the derivation ever misses a real import.
 */
export function resolveWorkspaceDependencyRoots(runtimeRoot: string, entryPackageRoot: string): string[] {
  const canonicalRuntimeRoot = canonicalPath(runtimeRoot);
  const packagesRoot = canonicalPath(join(canonicalRuntimeRoot, 'packages'));
  const nodeModulesRoot = join(canonicalRuntimeRoot, 'node_modules');
  const entryRoot = realpathSync(entryPackageRoot);
  const visited = new Set([entryRoot]);
  const queue = [entryRoot];
  const roots: string[] = [];
  while (queue.length > 0) {
    const packageRoot = queue.shift();
    if (packageRoot === undefined) break;
    let dependencyNames: string[] = [];
    try {
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, unknown>;
      };
      dependencyNames = Object.keys(manifest.dependencies ?? {});
    } catch {
      continue;
    }
    for (const name of dependencyNames) {
      let resolved: string;
      try {
        resolved = realpathSync(join(nodeModulesRoot, name));
      } catch {
        continue;
      }
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      if (!isPathWithin(packagesRoot, resolved)) continue;
      roots.push(resolved);
      queue.push(resolved);
    }
  }
  return roots;
}

/** Immutable memory shim the CLI launches; the wrapper routes it to the memory policy. */
export function buildQoderMemoryShimScript(memoryMcpServerPath: string): string {
  return `#!/bin/sh\nexec ${shellLiteral(process.execPath)} ${shellLiteral(memoryMcpServerPath)}\n`;
}

export interface QoderMemoryPolicyInput {
  /** Runtime workspace the sandboxed CLI operates in. */
  workspace: string;
  /** Per-invocation scratch directory (the only writable root). */
  scratch: string;
  /** Absolute path of the compiled readonly memory MCP entry (…/mcp-server/dist/memory.js). */
  memoryMcpServerPath: string;
  /** Runtime deployment root hosting packages/ and node_modules/. */
  runtimeRoot: string;
  /** Absolute path of the immutable memory shim the CLI launches. */
  memoryShimPath: string;
  /**
   * Test seam: explicit workspace-dependency roots for the memory read
   * surface. Defaults to the runtime-derived closure. Passing [] reproduces
   * the pre-2026-09-18 legacy surface (no workspace dependencies readable)
   * and MUST make the memory MCP unbootable — the regression test uses that
   * as its negative control.
   */
  workspaceDependencyRoots?: readonly string[];
}

export function buildQoderMemorySeatbeltPolicy(input: QoderMemoryPolicyInput): string {
  const workspace = canonicalPath(input.workspace);
  const runtimeRoot = canonicalPath(input.runtimeRoot);
  const memoryDistRoot = canonicalPath(dirname(input.memoryMcpServerPath));
  const entryPackageRoot = dirname(memoryDistRoot);
  const scratch = canonicalPath(input.scratch);
  // Unlike os.homedir(), userInfo().homedir does not trust the mutable HOME
  // environment variable. The sandbox must fence the OS account home even if
  // a launcher omits or redirects HOME.
  const operatorHome = canonicalPath(userInfo().homedir);
  const deniedReadRoots = [operatorHome, canonicalPath('/tmp'), canonicalPath(tmpdir())];
  const protectedRuntimeReadRoots = [join(runtimeRoot, '.cat-cafe'), join(runtimeRoot, 'mcp-creds')];
  const protectedRuntimeReadLiterals = [
    join(runtimeRoot, '.env'),
    join(runtimeRoot, '.env.local'),
    join(runtimeRoot, '.npmrc'),
    join(runtimeRoot, 'credentials.json'),
    join(runtimeRoot, 'evidence.sqlite'),
    join(runtimeRoot, 'event-memory.sqlite'),
  ];
  const dependencyRoots =
    input.workspaceDependencyRoots ?? resolveWorkspaceDependencyRoots(runtimeRoot, entryPackageRoot);
  // Secrets that could ever appear inside an allowed dependency package stay
  // denied even though the package root itself is readable.
  const dependencySecretLiterals = dependencyRoots.flatMap((root) => [
    join(root, '.env'),
    join(root, '.env.local'),
    join(root, '.npmrc'),
  ]);
  return buildSeatbeltPolicy({
    deniedReadRoots,
    // Never grant the whole runtime root: it contains deployment credentials.
    // The readonly MCP reads compiled code, node_modules, its pnpm-resolved
    // workspace dependency closure, and its immutable shim.
    allowedReadRoots: [workspace, scratch, memoryDistRoot, join(runtimeRoot, 'node_modules'), ...dependencyRoots],
    allowedReadLiterals: [
      input.memoryShimPath,
      input.memoryMcpServerPath,
      process.execPath,
      join(runtimeRoot, 'package.json'),
      join(entryPackageRoot, 'package.json'),
    ],
    deniedReadRootsFinal: protectedRuntimeReadRoots,
    deniedReadLiterals: [...protectedRuntimeReadLiterals, ...dependencySecretLiterals],
    allowedWriteRoots: [scratch],
    allowedWriteLiterals: ['/dev/null'],
  });
}
