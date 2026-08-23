// INV-9 / P1-1 static checks on scripts/runtime-worktree.sh.
//
// INV-9: seed_runtime_config_from_project must NOT copy accounts.json or
// credentials.json into the disposable runtime checkout — those stores belong
// to the durable workspace and are migrated at startup, not re-seeded stale.
// P1-1: the script must not export a CAT_CAFE_GLOBAL_CONFIG_ROOT default —
// doing so suppresses the runtime→workspace stale-store migration.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(SELF_DIR, 'runtime-worktree.sh');
const script = readFileSync(SCRIPT_PATH, 'utf-8');

function extractSeedFileLoop(source) {
  const match = source.match(/for file in ([^;]+); do/);
  return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

describe('runtime-worktree.sh seed restriction (INV-9)', () => {
  it('seed_runtime_config_from_project copies only cat-catalog.json', () => {
    const seedSection = script.match(/seed_runtime_config_from_project\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(seedSection.length > 0, 'seed function must exist');
    const files = extractSeedFileLoop(seedSection);
    assert.deepEqual(files, ['cat-catalog.json'], 'only cat-catalog.json may be seeded into runtime');
  });

  it('no accounts.json / credentials.json copy anywhere in the seed function', () => {
    const seedSection = script.match(/seed_runtime_config_from_project\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(!seedSection.includes('accounts.json'), 'accounts.json must not be seeded');
    assert.ok(!seedSection.includes('credentials.json'), 'credentials.json must not be seeded');
  });
});

describe('runtime-worktree.sh store-root default (P1-1)', () => {
  it('does not export CAT_CAFE_GLOBAL_CONFIG_ROOT with a default value', () => {
    assert.ok(
      !/export CAT_CAFE_GLOBAL_CONFIG_ROOT=/.test(script),
      'script must not default-export CAT_CAFE_GLOBAL_CONFIG_ROOT (suppresses stale-store migration)',
    );
  });

  it('exports CAT_CAFE_DEPLOYMENT_ID=runtime', () => {
    assert.ok(
      /export CAT_CAFE_DEPLOYMENT_ID=runtime/.test(script),
      'script must export CAT_CAFE_DEPLOYMENT_ID=runtime',
    );
  });

  it('keeps CAT_CAFE_RUNTIME_ROOT and CAT_CAFE_WORKSPACE_ROOT exports', () => {
    assert.ok(/export CAT_CAFE_RUNTIME_ROOT=/.test(script), 'RUNTIME_ROOT export required');
    assert.ok(/export CAT_CAFE_WORKSPACE_ROOT=/.test(script), 'WORKSPACE_ROOT export required');
  });
});
