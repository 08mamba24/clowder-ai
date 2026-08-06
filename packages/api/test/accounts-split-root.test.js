/**
 * Regression: PR #1149 (fae08774) migrated the account *write* side to the
 * persistent workspace root, but readers still resolved accounts from the
 * disposable runtime checkout → split-brain. This test pins the store-root
 * redirect (resolveGlobalRoot runtime→workspace) + the stale-runtime migration.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
const { readCredential, writeCredential } = await import('../dist/config/credentials.js');
const { resolveByAccountRef } = await import('../dist/config/account-resolver.js');
const { redirectRuntimePathLexical, resolvePersistentProjectPath } = await import(
  '../dist/utils/persistent-project-path.js'
);

const ENV_KEYS = [
  'CAT_CAFE_RUNTIME_ROOT',
  'CAT_CAFE_WORKSPACE_ROOT',
  'CAT_CAFE_GLOBAL_CONFIG_ROOT',
  'HOME',
  'CAT_CAFE_TEST_SANDBOX',
];
const savedEnv = {};

describe('accounts split-root regression (runtime checkout vs persistent workspace)', () => {
  let runtimeRoot;
  let workspaceRoot;

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    runtimeRoot = await mkdtemp(join(tmpdir(), 'split-root-runtime-'));
    workspaceRoot = await mkdtemp(join(tmpdir(), 'split-root-workspace-'));
    await mkdir(join(runtimeRoot, '.cat-cafe'), { recursive: true });
    await mkdir(join(workspaceRoot, '.cat-cafe'), { recursive: true });
    resetMigrationState();
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resetMigrationState();
    await rm(runtimeRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function setSplitEnv() {
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
  }

  async function writeRuntimeAccounts(accounts) {
    await writeFile(join(runtimeRoot, '.cat-cafe', 'accounts.json'), JSON.stringify(accounts, null, 2), 'utf-8');
  }

  it('redirectRuntimePathLexical maps runtime-root paths to the workspace (synchronous, no IO)', () => {
    setSplitEnv();
    assert.equal(redirectRuntimePathLexical(runtimeRoot), resolve(workspaceRoot));
    assert.equal(
      redirectRuntimePathLexical(join(runtimeRoot, 'packages', 'api')),
      resolve(workspaceRoot, 'packages', 'api'),
    );
    // Outside runtime root → unchanged
    assert.equal(redirectRuntimePathLexical('/tmp/unrelated-project'), '/tmp/unrelated-project');
  });

  it('redirectRuntimePathLexical is a no-op when only one env root is set', () => {
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    assert.equal(redirectRuntimePathLexical(runtimeRoot), runtimeRoot);
  });

  it('resolvePersistentProjectPath (async) agrees with the lexical redirect for runtime root', async () => {
    setSplitEnv();
    const { realpathSync } = await import('node:fs');
    assert.equal(await resolvePersistentProjectPath(runtimeRoot), realpathSync(workspaceRoot));
  });

  it('readers resolve accounts from the workspace store when invoked from the runtime checkout', async () => {
    setSplitEnv();
    // Account written to the workspace store (what POST /api/accounts now does)
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify(
        {
          'my-claude-20x': {
            authType: 'api_key',
            clientId: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            displayName: 'my-claude-20x',
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    // Runtime store must NOT contain it (the split that broke PATCH /api/cats/:id)
    await writeRuntimeAccounts({ 'stale-runtime-only': { authType: 'api_key', clientId: 'openai' } });

    // Reader passes the runtime root (cats.ts:240 / invoke-single-cat.ts:1494 behavior)
    const accounts = readCatalogAccounts(runtimeRoot);
    assert.ok('my-claude-20x' in accounts, 'workspace account must resolve from runtime-root reader');
  });

  it('resolveByAccountRef finds a workspace-only account from a runtime-root reader', async () => {
    setSplitEnv();
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify(
        {
          'my-claude-20x': {
            authType: 'api_key',
            clientId: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            displayName: 'my-claude-20x',
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const profile = resolveByAccountRef(runtimeRoot, 'my-claude-20x');
    assert.ok(profile, 'bound custom account must resolve even though reader passes runtime root');
    assert.equal(profile.id, 'my-claude-20x');
    assert.equal(profile.authType, 'api_key');
  });

  it('migrates stale runtime accounts/credentials into the workspace store (idempotent)', async () => {
    setSplitEnv();
    // Stale runtime store (pre-#1149 data seeded into the disposable checkout)
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'max20x/2' },
    });
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ 'max20x-2': { apiKey: 'sk-old' } }),
      'utf-8',
    );
    // Workspace already has a newer account
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ 'my-claude-20x': { authType: 'api_key', clientId: 'anthropic', displayName: 'my-claude-20x' } }),
      'utf-8',
    );

    // First read triggers the migration
    const accounts = readCatalogAccounts(runtimeRoot);
    assert.ok('max20x-2' in accounts, 'stale runtime account must be migrated into workspace');
    assert.ok('my-claude-20x' in accounts, 'existing workspace account must be preserved');
    assert.equal(accounts['max20x-2'].displayName, 'max20x/2');

    // Credentials migrated too
    const cred = readCredential('max20x-2', runtimeRoot);
    assert.equal(cred?.apiKey, 'sk-old');

    // Idempotent: second read does not duplicate or clobber
    const again = readCatalogAccounts(runtimeRoot);
    assert.equal(Object.keys(again).length, 2, 'migration must not duplicate keys');

    // Workspace file is the merged truth
    const { readFileSync, existsSync } = await import('node:fs');
    const wsPath = join(workspaceRoot, '.cat-cafe', 'accounts.json');
    assert.ok(existsSync(wsPath));
    const wsAccounts = JSON.parse(readFileSync(wsPath, 'utf-8'));
    assert.deepEqual(Object.keys(wsAccounts).sort(), ['max20x-2', 'my-claude-20x'].sort());
  });

  it('conflicting same-id metadata fails closed instead of silently workspace-wins (INV-5)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'stale-name' },
    });
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ 'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'fresh-name' } }),
      'utf-8',
    );

    assert.throws(
      () => readCatalogAccounts(runtimeRoot),
      /Account conflict|migration conflict for "max20x-2"/,
      'metadata conflict must fail closed, never silently overwrite either side',
    );
    // Both sources remain untouched — no partial migration, no retirement.
    const { readFileSync } = await import('node:fs');
    const wsAccounts = JSON.parse(readFileSync(join(workspaceRoot, '.cat-cafe', 'accounts.json'), 'utf-8'));
    assert.equal(wsAccounts['max20x-2'].displayName, 'fresh-name', 'workspace data must be untouched');
  });

  it('conflicting same-id credentials fail closed without printing secret values (INV-5/INV-6)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'api_key', clientId: 'anthropic', displayName: 'max20x/2' },
    });
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ 'max20x-2': { apiKey: 'sk-runtime-secret' } }),
      'utf-8',
    );
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ 'max20x-2': { authType: 'api_key', clientId: 'anthropic', displayName: 'max20x/2' } }),
      'utf-8',
    );
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ 'max20x-2': { apiKey: 'sk-workspace-secret' } }),
      'utf-8',
    );

    let thrown = null;
    try {
      readCatalogAccounts(runtimeRoot);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, 'credential conflict must throw');
    assert.match(thrown.message, /credential migration conflict for "max20x-2"/);
    assert.ok(
      !thrown.message.includes('sk-runtime-secret') && !thrown.message.includes('sk-workspace-secret'),
      'credential values must never appear in the error (INV-6)',
    );
  });

  it('credential-only runtime source is still migrated (P1-4)', async () => {
    setSplitEnv();
    // No runtime accounts.json at all — only a stale credentials.json.
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ 'max20x-2': { apiKey: 'sk-old' } }),
      'utf-8',
    );
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ 'max20x-2': { authType: 'api_key', clientId: 'anthropic', displayName: 'max20x/2' } }),
      'utf-8',
    );

    const accounts = readCatalogAccounts(runtimeRoot);
    assert.ok('max20x-2' in accounts, 'workspace account must resolve');
    const cred = readCredential('max20x-2', runtimeRoot);
    assert.equal(cred?.apiKey, 'sk-old', 'runtime credential must be migrated even without runtime accounts.json');
  });

  it('crash retry: workspace has accounts but not creds → retry completes without loss (INV-8)', async () => {
    setSplitEnv();
    // Runtime source: accounts + credentials.
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'max20x/2' },
    });
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ 'max20x-2': { apiKey: 'sk-old' } }),
      'utf-8',
    );

    // Simulate a prior crash window: target accounts write succeeded, but the
    // credentials write never landed (or the process died before it).
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ 'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'max20x/2' } }),
      'utf-8',
    );

    // Re-running the migration must complete the credentials without
    // duplicating accounts or clobbering them.
    const accounts = readCatalogAccounts(runtimeRoot);
    assert.equal(Object.keys(accounts).length, 1, 'no duplicate accounts after crash retry');
    assert.equal(accounts['max20x-2'].displayName, 'max20x/2');
    assert.equal(readCredential('max20x-2', runtimeRoot)?.apiKey, 'sk-old', 'missing credentials completed on retry');
  });

  it('malformed runtime credentials fail migration before any workspace write (P1-3)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'max20x/2' },
    });
    await writeFile(join(runtimeRoot, '.cat-cafe', 'credentials.json'), '{ not-json', 'utf-8');

    assert.throws(() => readCatalogAccounts(runtimeRoot), SyntaxError, 'malformed source must throw');
    // Workspace store must not contain a partial merge.
    const { existsSync, readFileSync } = await import('node:fs');
    const wsPath = join(workspaceRoot, '.cat-cafe', 'accounts.json');
    if (existsSync(wsPath)) {
      const wsAccounts = JSON.parse(readFileSync(wsPath, 'utf-8'));
      assert.ok(!('max20x-2' in wsAccounts), 'no partial account write before credentials parsed');
    }
  });

  it('no redirect and no migration when CAT_CAFE_GLOBAL_CONFIG_ROOT is set (explicit override wins)', async () => {
    setSplitEnv();
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = workspaceRoot;
    await writeRuntimeAccounts({ stale: { authType: 'api_key', clientId: 'openai' } });

    const accounts = readCatalogAccounts(runtimeRoot);
    assert.equal('stale' in accounts, false, 'GLOBAL_CONFIG_ROOT target store must not import runtime data');
    assert.equal(
      redirectRuntimePathLexical(runtimeRoot),
      resolve(workspaceRoot),
      'lexical redirect is root-only, env override is store-level',
    );
  });

  it('credentials written via runtime-root reader land in the workspace store', async () => {
    setSplitEnv();
    writeCredential('my-claude-20x', { apiKey: 'sk-new' }, runtimeRoot);

    const { existsSync, readFileSync } = await import('node:fs');
    const wsCredPath = join(workspaceRoot, '.cat-cafe', 'credentials.json');
    assert.ok(existsSync(wsCredPath), 'credential must be written into the workspace store');
    const wsCreds = JSON.parse(readFileSync(wsCredPath, 'utf-8'));
    assert.equal(wsCreds['my-claude-20x'].apiKey, 'sk-new');
  });
});
