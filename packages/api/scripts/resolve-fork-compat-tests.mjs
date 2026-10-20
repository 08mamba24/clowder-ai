#!/usr/bin/env node
/**
 * Resolve the fork-compat suite selection.
 *
 * Why this exists: the fork's own provider integrations (Qoder, ZCode, DSH),
 * its origin↔upstream composition seam, and its MCP capability projection are
 * not covered by an upstream path filter. They must be re-checked on every
 * upstream merge even when the upstream diff does not touch those files.
 *
 * Single selection source: packages/api/config/fork-compat-tests.json.
 * CI (`.github/workflows/ci.yml` → `Fork compatibility`) and the local
 * pre-merge gate both execute the same resolver + runner. Do not duplicate
 * the file list in a workflow or shell script.
 *
 * Each group names the package that owns its files. API groups are validated
 * against the public test suite (a fork gate must not depend on a test the
 * public contract cannot run); MCP-server groups are validated against the
 * files that actually exist in that package.
 *
 * The resolver fails closed:
 *   - a declared file must exist in its package (and API files must be in the
 *     public test suite, never excluded);
 *   - every group must resolve to at least one file (a typo cannot silently
 *     shrink the gate);
 *   - duplicate declarations collapse deterministically.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicTestSelectionHash, resolvePublicTestFiles } from './resolve-public-test-files.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(PACKAGE_ROOT, 'config', 'fork-compat-tests.json');
const PACKAGE_DIRECTORIES = {
  api: PACKAGE_ROOT,
  'mcp-server': resolve(PACKAGE_ROOT, '..', 'mcp-server'),
};
const TEST_PATH_PATTERNS = {
  api: /^test\/.+\.test\.js$/u,
  'mcp-server': /^test\/.+\.test\.(?:js|ts)$/u,
};

export class ForkCompatSelectionError extends Error {}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function parseForkCompatGroup(name, group) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    throw new ForkCompatSelectionError(`fork-compat group "${name}" must be an object with package and files`);
  }
  const packageName = group.package;
  if (!Object.hasOwn(PACKAGE_DIRECTORIES, packageName)) {
    throw new ForkCompatSelectionError(
      `fork-compat group "${name}" package must be one of ${Object.keys(PACKAGE_DIRECTORIES).join(', ')}, got ${JSON.stringify(packageName)}`,
    );
  }
  const files = group.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new ForkCompatSelectionError(`fork-compat group "${name}" must declare a non-empty files array`);
  }
  const seen = new Set();
  for (const file of files) {
    if (typeof file !== 'string' || !TEST_PATH_PATTERNS[packageName].test(file)) {
      throw new ForkCompatSelectionError(
        `fork-compat group "${name}" entry must be a test path matching ${TEST_PATH_PATTERNS[packageName]}, got ${JSON.stringify(file)}`,
      );
    }
    if (seen.has(file)) {
      throw new ForkCompatSelectionError(`fork-compat group "${name}" declares ${file} twice`);
    }
    seen.add(file);
  }
  return { package: packageName, files: [...files] };
}

export async function loadForkCompatConfig(options = {}) {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const raw = await readFile(configPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ForkCompatSelectionError(
      `fork-compat config is not valid JSON: ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed?.version !== 2) {
    throw new ForkCompatSelectionError(`fork-compat config version must be 2, got ${JSON.stringify(parsed?.version)}`);
  }
  if (!parsed.groups || typeof parsed.groups !== 'object' || Array.isArray(parsed.groups)) {
    throw new ForkCompatSelectionError('fork-compat config must declare a "groups" object');
  }
  const groups = new Map(
    Object.entries(parsed.groups).map(([name, group]) => [name, parseForkCompatGroup(name, group)]),
  );
  if (groups.size === 0) throw new ForkCompatSelectionError('fork-compat config declares no groups');
  return { configPath, groups };
}

async function assertResolvedFile({ name, group, file, publicSuite, packageDirectory }) {
  if (group.package === 'api') {
    if (publicSuite.excludedFiles.has(file)) {
      throw new ForkCompatSelectionError(
        `fork-compat group "${name}" declares ${file}, which the public test registry excludes. ` +
          'A fork gate must not depend on a test the public contract cannot run.',
      );
    }
    if (!publicSuite.selectedFiles.has(file)) {
      throw new ForkCompatSelectionError(
        `fork-compat group "${name}" declares ${file}, but it does not exist in packages/api/test.`,
      );
    }
    return;
  }
  if (!(await isFile(resolve(packageDirectory, file)))) {
    throw new ForkCompatSelectionError(
      `fork-compat group "${name}" declares ${file}, but it does not exist in packages/${group.package}/test.`,
    );
  }
}

export async function resolveForkCompatTests(options = {}) {
  const { configPath, groups } = await loadForkCompatConfig(options);
  const packageDirectories = options.packageRoot
    ? {
        ...PACKAGE_DIRECTORIES,
        api: options.packageRoot,
        'mcp-server': resolve(options.packageRoot, '..', 'mcp-server'),
      }
    : PACKAGE_DIRECTORIES;
  // `configPath` here belongs to the fork selection, not the public exclusion
  // registry, so it must not be forwarded to the public resolver.
  const publicOptions = { ...options };
  delete publicOptions.configPath;
  delete publicOptions.packageRoot;
  const publicSuite = await resolvePublicTestFiles(publicOptions);
  const publicState = {
    selectedFiles: new Set(publicSuite.selectedFiles),
    excludedFiles: new Set(publicSuite.excludedFiles),
  };

  const resolvedGroups = new Map();
  const allFiles = new Set();
  for (const [name, group] of groups) {
    const packageDirectory = packageDirectories[group.package];
    for (const file of group.files) {
      await assertResolvedFile({ name, group, file, publicSuite: publicState, packageDirectory });
      allFiles.add(`${group.package}:${file}`);
    }
    resolvedGroups.set(name, { package: group.package, files: [...group.files] });
  }

  const selectedFiles = [...allFiles].sort();
  return {
    configPath,
    groups: resolvedGroups,
    selectedFiles,
    selectionHash: publicTestSelectionHash(selectedFiles),
    groupHashes: Object.fromEntries(
      [...resolvedGroups.entries()].map(([name, group]) => [
        name,
        publicTestSelectionHash(group.files.map((file) => `${group.package}:${file}`).sort()),
      ]),
    ),
  };
}

async function main() {
  if (process.argv.includes('--json')) {
    const result = await resolveForkCompatTests();
    process.stdout.write(
      JSON.stringify(
        {
          schemaVersion: 2,
          groups: Object.fromEntries(result.groups),
          selectedFiles: result.selectedFiles,
          selectionHash: result.selectionHash,
          groupHashes: result.groupHashes,
        },
        null,
        2,
      ),
    );
    return;
  }
  const { selectedFiles } = await resolveForkCompatTests();
  process.stdout.write(`${selectedFiles.join('\n')}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
