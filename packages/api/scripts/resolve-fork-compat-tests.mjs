#!/usr/bin/env node
/**
 * Resolve the fork-compat suite selection.
 *
 * Why this exists: the fork's own provider integrations (Qoder, ZCode, DSH)
 * and its origin↔upstream composition seam are not covered by an upstream
 * path filter. They must be re-checked on every upstream merge even when the
 * upstream diff does not touch those files.
 *
 * Single selection source: packages/api/config/fork-compat-tests.json.
 * CI (`.github/workflows/ci.yml` → `Fork compatibility`) and the local
 * pre-merge gate both execute the same resolver + runner. Do not duplicate
 * the file list in a workflow or shell script.
 *
 * The resolver fails closed:
 *   - a declared file must exist in the public test suite (never excluded);
 *   - every group must resolve to at least one file (a typo cannot silently
 *     shrink the gate);
 *   - duplicate declarations collapse deterministically.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicTestSelectionHash, resolvePublicTestFiles } from './resolve-public-test-files.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(PACKAGE_ROOT, 'config', 'fork-compat-tests.json');

export class ForkCompatSelectionError extends Error {}

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
  if (parsed?.version !== 1) {
    throw new ForkCompatSelectionError(`fork-compat config version must be 1, got ${JSON.stringify(parsed?.version)}`);
  }
  if (!parsed.groups || typeof parsed.groups !== 'object' || Array.isArray(parsed.groups)) {
    throw new ForkCompatSelectionError('fork-compat config must declare a "groups" object');
  }
  const groups = new Map();
  for (const [name, files] of Object.entries(parsed.groups)) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new ForkCompatSelectionError(`fork-compat group "${name}" must be a non-empty array`);
    }
    const seen = new Set();
    for (const file of files) {
      if (typeof file !== 'string' || !file.startsWith('test/') || !file.endsWith('.test.js')) {
        throw new ForkCompatSelectionError(
          `fork-compat group "${name}" entry must be a test/.../*.test.js path, got ${JSON.stringify(file)}`,
        );
      }
      if (seen.has(file)) {
        throw new ForkCompatSelectionError(`fork-compat group "${name}" declares ${file} twice`);
      }
      seen.add(file);
    }
    groups.set(name, [...files]);
  }
  if (groups.size === 0) throw new ForkCompatSelectionError('fork-compat config declares no groups');
  return { configPath, groups };
}

export async function resolveForkCompatTests(options = {}) {
  const { configPath, groups } = await loadForkCompatConfig(options);
  const publicSuite = await resolvePublicTestFiles(options);
  const selected = new Set(publicSuite.selectedFiles);
  const excluded = new Set(publicSuite.excludedFiles);

  const resolvedGroups = new Map();
  const allFiles = new Set();
  for (const [name, files] of groups) {
    for (const file of files) {
      if (excluded.has(file)) {
        throw new ForkCompatSelectionError(
          `fork-compat group "${name}" declares ${file}, which the public test registry excludes. ` +
            'A fork gate must not depend on a test the public contract cannot run.',
        );
      }
      if (!selected.has(file)) {
        throw new ForkCompatSelectionError(
          `fork-compat group "${name}" declares ${file}, but it does not exist in packages/api/test.`,
        );
      }
      allFiles.add(file);
    }
    resolvedGroups.set(name, [...files]);
  }

  const selectedFiles = [...allFiles].sort();
  return {
    configPath,
    groups: resolvedGroups,
    selectedFiles,
    selectionHash: publicTestSelectionHash(selectedFiles),
    groupHashes: Object.fromEntries(
      [...resolvedGroups.entries()].map(([name, files]) => [name, publicTestSelectionHash([...files].sort())]),
    ),
  };
}

async function main() {
  if (process.argv.includes('--json')) {
    const result = await resolveForkCompatTests();
    process.stdout.write(
      JSON.stringify(
        {
          schemaVersion: 1,
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
  process.stdout.write(selectedFiles.join('\n'));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
