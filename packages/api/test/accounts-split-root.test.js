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
  // R12 ruling 3: os.homedir() prefers USERPROFILE on Windows, so pointing only
  // HOME at a fixture would put the fall-back-to-the-real-home hole straight
  // back on the other first-class platform.
  'USERPROFILE',
  'CAT_CAFE_TEST_SANDBOX',
];
const savedEnv = {};

describe('accounts split-root regression (runtime checkout vs persistent workspace)', () => {
  let runtimeRoot;
  let workspaceRoot;
  let fakeHome;

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    runtimeRoot = await mkdtemp(join(tmpdir(), 'split-root-runtime-'));
    workspaceRoot = await mkdtemp(join(tmpdir(), 'split-root-workspace-'));
    // HOME must be POINTED somewhere, not deleted. os.homedir() falls back to
    // the passwd entry when $HOME is unset, so "isolating" it by deletion did
    // the opposite: ensureMigrated() runs the homedir migrations first, and
    // every test below was reading — and would have imported from — the
    // operator's real ~/.cat-cafe. Every other suite in this repo already
    // points HOME at a fixture; this one was the exception (P1-9).
    fakeHome = await mkdtemp(join(tmpdir(), 'split-root-home-'));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
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
    await rm(fakeHome, { recursive: true, force: true });
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

  /**
   * P1-14: a persisted field that the normaliser cannot use must still be a
   * DIFFERENCE, not an absence.
   *
   * The upstream integration made canonicalizeAccount() route modelAliases
   * through normalizeModelAliases(). That is right for legal padding/key-order
   * differences, but the normaliser DROPS what it cannot use — non-string
   * values, keys or values that are empty after trimming — and
   * Object.fromEntries() silently collapses keys that collide once trimmed. Feed
   * only its output into the canonical view and a stored `{ local: 123 }`
   * compares equal to no aliases at all, so this migration stops refusing and
   * binds the stale runtime credential to the workspace account.
   *
   * Strict JSON parsing does not catch it: the migration asserts the parsed
   * object into AccountConfig without running the route schema, so invalid
   * content genuinely reaches the comparison.
   */
  /**
   * R17 P2: zero-write has to be asserted over the WHOLE workspace store, not
   * over a couple of fields that happened to be absent. Two named field checks
   * pass just as happily when the migration rewrote the account, dropped a
   * temp file, or wrote a marker under a name nobody thought to check. Snapshot
   * every byte under .cat-cafe before the call and compare after: any write,
   * to any file, by any path, fails — and names the file it happened to.
   */
  async function snapshotWorkspaceStore() {
    const { existsSync, readdirSync, readFileSync } = await import('node:fs');
    const dir = join(workspaceRoot, '.cat-cafe');
    const snapshot = {};
    if (!existsSync(dir)) return snapshot;
    for (const name of readdirSync(dir).sort()) {
      snapshot[name] = readFileSync(join(dir, name), 'utf-8');
    }
    return snapshot;
  }

  async function assertWorkspaceUntouched(before, message) {
    const after = await snapshotWorkspaceStore();
    for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      // undefined on either side = the file appeared or disappeared.
      assert.equal(after[name], before[name], `${message}: workspace store file "${name}" must be byte-identical`);
    }
    // Named separately from the byte comparison because these two ARE the
    // security property: a copied credential, and a marker that would skip the
    // preflight for every later start.
    assert.equal(after['credentials.json'], undefined, `${message}: no credential may be written`);
    assert.equal(after['runtime-migration.json'], undefined, `${message}: no completion marker may be written`);
  }

  it('a non-string alias value is a conflict, not an absent field (P1-14)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      shared: { authType: 'api_key', clientId: 'anthropic', modelAliases: { local: 123 } },
    });
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ shared: { apiKey: 'sk-invalid-alias-source' } }),
      'utf-8',
    );
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ shared: { authType: 'api_key', clientId: 'anthropic' } }),
      'utf-8',
    );
    const before = await snapshotWorkspaceStore();

    let thrown = null;
    try {
      readCatalogAccounts(runtimeRoot);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, 'an unusable persisted alias map must fail closed');
    assert.match(thrown.message, /migration conflict for "shared"/);
    assert.match(thrown.message, /modelAliases invalid/, 'an unusable map is reported as invalid, not as a value diff');
    assert.ok(!thrown.message.includes('123'), 'the invalid raw value must not be printed');
    await assertWorkspaceUntouched(before, 'non-string alias value');
  });

  it('alias keys that collide once trimmed are a conflict, not a collapsed map (P1-14)', async () => {
    setSplitEnv();
    // normalizeModelAliases() trims both keys to 'a', and Object.fromEntries()
    // keeps only the last — collapsing a two-entry source into the workspace's
    // one-entry map.
    await writeRuntimeAccounts({
      shared: { authType: 'api_key', clientId: 'anthropic', modelAliases: { a: 'x', ' a ': 'y' } },
    });
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ shared: { apiKey: 'sk-collapsed-alias-source' } }),
      'utf-8',
    );
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ shared: { authType: 'api_key', clientId: 'anthropic', modelAliases: { a: 'y' } } }),
      'utf-8',
    );
    const before = await snapshotWorkspaceStore();

    let thrown = null;
    try {
      readCatalogAccounts(runtimeRoot);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, 'a trim-collision must fail closed');
    assert.match(thrown.message, /migration conflict for "shared"/);
    assert.match(thrown.message, /modelAliases/);
    await assertWorkspaceUntouched(before, 'trim-collision alias keys');
  });

  /**
   * The same silent-drop, spelled with whitespace instead of a wrong type: the
   * normaliser filters entries whose key or value is empty once trimmed, so
   * without the guard a two-entry source collapses onto a one-entry target.
   * Two tests because the guard has two halves.
   */
  it('an alias value that is empty once trimmed is a conflict (P1-14)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      shared: { authType: 'api_key', clientId: 'anthropic', modelAliases: { 'a/x': 'up-x', 'b/y': '   ' } },
    });
    // R17 P2: these two carried no credential and asserted only `throws`, so
    // they could not tell "refused" from "refused after copying the secret".
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ shared: { apiKey: 'sk-blank-alias-value-source' } }),
      'utf-8',
    );
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        shared: { authType: 'api_key', clientId: 'anthropic', modelAliases: { 'a/x': 'up-x' } },
      }),
      'utf-8',
    );
    const before = await snapshotWorkspaceStore();

    assert.throws(
      () => readCatalogAccounts(runtimeRoot),
      /modelAliases invalid/,
      'an entry the normaliser would drop must not become an absence',
    );
    await assertWorkspaceUntouched(before, 'blank alias value');
  });

  it('an alias key that is empty once trimmed is a conflict (P1-14)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      shared: { authType: 'api_key', clientId: 'anthropic', modelAliases: { 'a/x': 'up-x', '   ': 'up-y' } },
    });
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ shared: { apiKey: 'sk-blank-alias-key-source' } }),
      'utf-8',
    );
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        shared: { authType: 'api_key', clientId: 'anthropic', modelAliases: { 'a/x': 'up-x' } },
      }),
      'utf-8',
    );
    const before = await snapshotWorkspaceStore();

    assert.throws(
      () => readCatalogAccounts(runtimeRoot),
      /modelAliases invalid/,
      'an entry the normaliser would drop must not become an absence',
    );
    await assertWorkspaceUntouched(before, 'blank alias key');
  });

  /**
   * P1-15: `undefined` is an absent field; `null` is persisted content.
   *
   * The route's modelAliasesSchema is optional, not nullable, so no normal write
   * path produces a stored null — which makes it the same JSON-legal /
   * AccountConfig-illegal class as { local: 123 }, reaching the comparison
   * unvalidated. Treating it as absent let this exact migration copy the stale
   * runtime credential and leave a completion marker that skips the preflight
   * for good.
   */
  it('a persisted null alias field is unusable content, not an absent field (P1-15)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      shared: { authType: 'api_key', clientId: 'anthropic', modelAliases: null },
    });
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ shared: { apiKey: 'sk-null-alias-source' } }),
      'utf-8',
    );
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ shared: { authType: 'api_key', clientId: 'anthropic' } }),
      'utf-8',
    );
    const before = await snapshotWorkspaceStore();

    let thrown = null;
    try {
      readCatalogAccounts(runtimeRoot);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, 'a persisted null alias field must fail closed');
    assert.match(thrown.message, /migration conflict for "shared"/);
    assert.match(thrown.message, /modelAliases invalid/, 'a null map is reported as invalid, not as a value diff');
    await assertWorkspaceUntouched(before, 'null alias field');
  });

  it('a legal padding/key-order alias difference still migrates (P1-14 control)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      shared: { authType: 'api_key', clientId: 'anthropic', modelAliases: { 'b/y': ' up-y ', 'a/x': ' up-x ' } },
    });
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        shared: { authType: 'api_key', clientId: 'anthropic', modelAliases: { 'a/x': 'up-x', 'b/y': 'up-y' } },
      }),
      'utf-8',
    );

    assert.doesNotThrow(
      () => readCatalogAccounts(runtimeRoot),
      'padding and key order must stay equivalent — that is what the normaliser is for',
    );
  });

  it('an empty alias map still means "no aliases", not unusable content (P1-14 control)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      shared: { authType: 'api_key', clientId: 'anthropic', modelAliases: {} },
    });
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ shared: { authType: 'api_key', clientId: 'anthropic' } }),
      'utf-8',
    );

    assert.doesNotThrow(
      () => readCatalogAccounts(runtimeRoot),
      'an empty map carries no information the normaliser could lose',
    );
  });

  /**
   * R17 P1-16: the same bug as P1-14/P1-15, in every OTHER field that reaches
   * the equivalence view through a write-side normaliser. modelAliases was
   * fixed one field at a time; these are the four neighbours that were still
   * folding unusable persisted content into a legal value or into absence, and
   * therefore still copying a stale runtime credential into the workspace.
   *
   * One case per guard, so each row names the single line whose removal it
   * kills. Every row carries a credential and asserts the whole workspace store
   * is byte-identical afterwards — a refusal that copied the secret first is
   * not a refusal.
   */
  const UNUSABLE_SHAPES = [
    {
      title: 'models holding a map instead of a list',
      field: 'models',
      secret: 'sk-models-object-source',
      runtime: { models: { 'gpt-leak': 'x' } },
      workspace: {},
      mustNotPrint: 'gpt-leak',
    },
    {
      title: 'a persisted null models field',
      field: 'models',
      secret: 'sk-models-null-source',
      runtime: { models: null },
      workspace: {},
    },
    {
      title: 'a model entry that is blank once trimmed',
      field: 'models',
      secret: 'sk-models-blank-entry-source',
      runtime: { models: ['a/x', '   '] },
      workspace: { models: ['a/x'] },
    },
    {
      title: 'a non-string model entry',
      field: 'models',
      secret: 'sk-models-coerced-entry-source',
      runtime: { models: ['a/x', 4711] },
      workspace: { models: ['a/x', '4711'] },
      mustNotPrint: '4711',
    },
    {
      title: 'a persisted null baseUrl',
      field: 'baseUrl',
      secret: 'sk-baseurl-null-source',
      runtime: { baseUrl: null },
      workspace: {},
    },
    {
      title: 'a baseUrl that is blank once trimmed',
      field: 'baseUrl',
      secret: 'sk-baseurl-blank-source',
      runtime: { baseUrl: '   ' },
      workspace: {},
    },
    {
      title: 'a persisted null displayName',
      field: 'displayName',
      secret: 'sk-displayname-null-source',
      runtime: { displayName: null },
      workspace: {},
    },
    {
      title: 'a displayName that is blank once trimmed',
      field: 'displayName',
      secret: 'sk-displayname-blank-source',
      runtime: { displayName: '   ' },
      workspace: {},
    },
    {
      title: 'a persisted null envVars field',
      field: 'envVars',
      secret: 'sk-envvars-null-source',
      runtime: { envVars: null },
      workspace: {},
    },
    {
      // { ...['ENVLEAK'] } is { '0': 'ENVLEAK' } — a list and that literal map
      // are different persisted content that the spread made indistinguishable.
      title: 'an envVars list colliding with the map its spread produces',
      field: 'envVars',
      secret: 'sk-envvars-array-source',
      runtime: { envVars: ['ENVLEAK'] },
      workspace: { envVars: { 0: 'ENVLEAK' } },
      mustNotPrint: 'ENVLEAK',
    },
  ];

  for (const scenario of UNUSABLE_SHAPES) {
    it(`${scenario.title} is unusable content, not an equivalent account (P1-16)`, async () => {
      setSplitEnv();
      await writeRuntimeAccounts({
        shared: { authType: 'api_key', clientId: 'anthropic', ...scenario.runtime },
      });
      await writeFile(
        join(runtimeRoot, '.cat-cafe', 'credentials.json'),
        JSON.stringify({ shared: { apiKey: scenario.secret } }),
        'utf-8',
      );
      await writeFile(
        join(workspaceRoot, '.cat-cafe', 'accounts.json'),
        JSON.stringify({ shared: { authType: 'api_key', clientId: 'anthropic', ...scenario.workspace } }),
        'utf-8',
      );
      const before = await snapshotWorkspaceStore();

      let thrown = null;
      try {
        readCatalogAccounts(runtimeRoot);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof Error, `${scenario.title}: unusable persisted content must fail closed`);
      assert.match(thrown.message, /migration conflict for "shared"/);
      assert.match(
        thrown.message,
        new RegExp(`${scenario.field} invalid \\(values not shown\\)`),
        `${scenario.title}: reported as invalid, not as a value diff`,
      );
      if (scenario.mustNotPrint) {
        assert.ok(
          !thrown.message.includes(scenario.mustNotPrint),
          `${scenario.title}: the unusable raw value must not be printed`,
        );
      }
      await assertWorkspaceUntouched(before, scenario.title);
    });
  }

  /**
   * The other half of the ruling: normalisation that a reader genuinely cannot
   * observe must STAY equivalent. Fail-closed everywhere would trade a security
   * bug for an availability bug — an operator whose store differs only by
   * padding would be blocked out of their own migration.
   */
  const EQUIVALENT_SHAPES = [
    {
      title: 'a trailing slash on baseUrl',
      runtime: { baseUrl: 'https://x.test/' },
      workspace: { baseUrl: 'https://x.test' },
    },
    {
      title: 'padding around baseUrl',
      runtime: { baseUrl: '  https://x.test  ' },
      workspace: { baseUrl: 'https://x.test' },
    },
    { title: 'padding around displayName', runtime: { displayName: ' shared ' }, workspace: { displayName: 'shared' } },
    {
      title: 'padding and trailing slashes in models',
      runtime: { models: [' a/x/ ', 'b'] },
      workspace: { models: ['a/x', 'b'] },
    },
    // De-duplication keeps the first occurrence, so it can never move models[0].
    { title: 'a repeated model entry', runtime: { models: ['a', 'b', 'a'] }, workspace: { models: ['a', 'b'] } },
    { title: 'an empty models list', runtime: { models: [] }, workspace: {} },
    { title: 'an empty envVars map', runtime: { envVars: {} }, workspace: {} },
  ];

  for (const scenario of EQUIVALENT_SHAPES) {
    it(`${scenario.title} is still an equivalent account (P1-16 control)`, async () => {
      setSplitEnv();
      await writeRuntimeAccounts({
        shared: { authType: 'api_key', clientId: 'anthropic', ...scenario.runtime },
      });
      await writeFile(
        join(workspaceRoot, '.cat-cafe', 'accounts.json'),
        JSON.stringify({ shared: { authType: 'api_key', clientId: 'anthropic', ...scenario.workspace } }),
        'utf-8',
      );

      assert.doesNotThrow(
        () => readCatalogAccounts(runtimeRoot),
        `${scenario.title}: a difference no reader can observe must not block the migration`,
      );
    });
  }

  /**
   * The one normalisation that had to GO. normalizeModels() sorted, so ['b','a']
   * and ['a','b'] compared equal — but invoke-single-cat.ts reads models[0] as
   * the fallback model override and reports models[0] as the model in use, so
   * those two accounts name different default models. Sorting was not
   * normalisation, it was a rewrite of observable semantics.
   */
  it('a reordered models list is a conflict — models[0] is observable (P1-16)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      shared: { authType: 'api_key', clientId: 'anthropic', models: ['b/second', 'a/first'] },
    });
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ shared: { apiKey: 'sk-models-reordered-source' } }),
      'utf-8',
    );
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        shared: { authType: 'api_key', clientId: 'anthropic', models: ['a/first', 'b/second'] },
      }),
      'utf-8',
    );
    const before = await snapshotWorkspaceStore();

    assert.throws(
      () => readCatalogAccounts(runtimeRoot),
      /models \["a\/first","b\/second"\] vs \["b\/second","a\/first"\]/,
      'a different default model is a different account, and models are safe to print',
    );
    await assertWorkspaceUntouched(before, 'reordered models list');
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

  // ── P1: cross-process completion evidence ──
  // The in-process `migratedRuntimeStale` Set dies with the process. After a
  // successful migration the runtime source stays in place as backup, so the
  // next process must recognize "already migrated" WITHOUT re-preflighting —
  // otherwise a user's legitimate same-id target update becomes a "conflict".

  it('target update after migration does not conflict on next start (durable completion evidence)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'max20x/2' },
    });

    // First start: migration completes.
    let accounts = readCatalogAccounts(runtimeRoot);
    assert.ok('max20x-2' in accounts, 'first migration must merge the stale runtime account');

    // User legitimately renames the same-id account in the workspace.
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'user-renamed' },
      }),
      'utf-8',
    );

    // Simulated restart: in-process migration state is gone.
    resetMigrationState();
    // The durable source fingerprint must short-circuit re-preflight, so the
    // workspace update is NOT misread as a migration conflict.
    accounts = readCatalogAccounts(runtimeRoot);
    assert.equal(accounts['max20x-2'].displayName, 'user-renamed', 'user update must survive restart');
  });

  it('rollback-modified runtime source re-preflights and conflicts against updated target', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'max20x/2' },
    });
    readCatalogAccounts(runtimeRoot); // first migration completes

    // User updates the workspace target.
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'user-renamed' },
      }),
      'utf-8',
    );

    // Rollback replaces the runtime source with DIFFERENT content → fingerprint
    // changes → re-preflight runs and must fail closed against the updated target.
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'rollback-name' },
    });
    resetMigrationState();

    assert.throws(
      () => readCatalogAccounts(runtimeRoot),
      /migration conflict for "max20x-2"/,
      'changed source must re-run preflight and conflict, not silently skip',
    );
  });

  // ── P1: target-side preflight must be strict, never "backup then treat as empty" ──

  it('malformed workspace accounts fail closed, never treated as empty (target preflight)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'max20x/2' },
    });
    await writeFile(join(workspaceRoot, '.cat-cafe', 'accounts.json'), '{ not-json', 'utf-8');

    assert.throws(
      () => readCatalogAccounts(runtimeRoot),
      SyntaxError,
      'malformed target accounts must fail closed, not be overwritten',
    );
    const { readFileSync } = await import('node:fs');
    assert.equal(
      readFileSync(join(workspaceRoot, '.cat-cafe', 'accounts.json'), 'utf-8'),
      '{ not-json',
      'malformed target must remain untouched',
    );
  });

  it('malformed workspace credentials fail closed, never overwritten (target preflight)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'api_key', clientId: 'anthropic', displayName: 'max20x/2' },
    });
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ 'max20x-2': { apiKey: 'sk-old' } }),
      'utf-8',
    );
    // Same-id account metadata already present in workspace → accounts merge is
    // a no-op, but the credentials merge WOULD overwrite this malformed file.
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        'max20x-2': { authType: 'api_key', clientId: 'anthropic', displayName: 'max20x/2' },
      }),
      'utf-8',
    );
    await writeFile(join(workspaceRoot, '.cat-cafe', 'credentials.json'), '{ not-json', 'utf-8');

    assert.throws(
      () => readCatalogAccounts(runtimeRoot),
      SyntaxError,
      'malformed target credentials must fail closed, not be overwritten',
    );
    const { readFileSync } = await import('node:fs');
    assert.equal(
      readFileSync(join(workspaceRoot, '.cat-cafe', 'credentials.json'), 'utf-8'),
      '{ not-json',
      'malformed target credentials must remain untouched',
    );
  });

  it('migration marker is written 0600 — it carries a credential-derived verifier (R3 P1-1)', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX file modes only');
    setSplitEnv();
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'api_key', clientId: 'anthropic', displayName: 'max20x/2' },
    });
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ 'max20x-2': { apiKey: 'sk-secret' } }),
      'utf-8',
    );

    readCatalogAccounts(runtimeRoot);

    const { stat } = await import('node:fs/promises');
    const markerStat = await stat(join(workspaceRoot, '.cat-cafe', 'runtime-migration.json'));
    assert.equal(
      // eslint-disable-next-line no-bitwise
      (markerStat.mode & 0o777).toString(8),
      '600',
      'marker holds the sha256 of credentials.json — it must not be world-readable',
    );
  });

  it('conflicting same-id clientId fails closed instead of silently skipping (R3 P1-2)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'api_key', clientId: 'openai', displayName: 'max20x/2' },
    });
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        'max20x-2': { authType: 'api_key', clientId: 'anthropic', displayName: 'max20x/2' },
      }),
      'utf-8',
    );

    assert.throws(
      () => readCatalogAccounts(runtimeRoot),
      /migration conflict for "max20x-2".*clientId/s,
      'clientId divergence is a real conflict and must fail closed',
    );
  });

  it('conflicting same-id envVars fails closed without printing values (R3 P1-2)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      'max20x-2': {
        authType: 'api_key',
        clientId: 'anthropic',
        displayName: 'max20x/2',
        envVars: { MY_PROXY_TOKEN: 'runtime-secret-value' },
      },
    });
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        'max20x-2': {
          authType: 'api_key',
          clientId: 'anthropic',
          displayName: 'max20x/2',
          envVars: { MY_PROXY_TOKEN: 'workspace-secret-value' },
        },
      }),
      'utf-8',
    );

    let thrown;
    assert.throws(() => {
      try {
        readCatalogAccounts(runtimeRoot);
      } catch (err) {
        thrown = err;
        throw err;
      }
    }, /migration conflict for "max20x-2".*envVars/s);
    assert.ok(!String(thrown?.message).includes('runtime-secret-value'), 'must not print runtime envVar value');
    assert.ok(!String(thrown?.message).includes('workspace-secret-value'), 'must not print workspace envVar value');
    assert.match(String(thrown?.message), /MY_PROXY_TOKEN/, 'differing key NAME is safe and aids diagnosis');
  });

  it('format-only source rewrite is not misread as rollback (R3 P2-1)', async () => {
    setSplitEnv();
    // Pretty-printed source with one key order.
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ 'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'max20x/2' } }, null, 2),
      'utf-8',
    );
    readCatalogAccounts(runtimeRoot); // first migration completes, marker written

    // User legitimately updates the workspace target.
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'user-renamed' },
      }),
      'utf-8',
    );

    // Source rewritten compact with different key order — same semantics.
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ 'max20x-2': { displayName: 'max20x/2', clientId: 'anthropic', authType: 'oauth' } }),
      'utf-8',
    );

    resetMigrationState();
    const accounts = readCatalogAccounts(runtimeRoot);
    assert.equal(
      accounts['max20x-2'].displayName,
      'user-renamed',
      'formatting-only source change must not trigger a rollback conflict against the updated target',
    );
  });

  it('forged v1 marker with sentinel fingerprint cannot bypass strict source preflight (R4 P1-4)', async () => {
    setSplitEnv();
    // Malformed runtime source: strict preflight MUST throw.
    await writeFile(join(runtimeRoot, '.cat-cafe', 'accounts.json'), '{ not-json', 'utf-8');
    // Forged/corrupt marker claiming the malformed source was already migrated,
    // using the internal sentinel value as a fingerprint.
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'runtime-migration.json'),
      JSON.stringify({
        v: 1,
        migratedAt: '2026-08-07T00:00:00.000Z',
        sourceFingerprints: { 'accounts.json': 'unparseable', 'credentials.json': 'absent' },
      }),
      'utf-8',
    );

    assert.throws(
      () => readCatalogAccounts(runtimeRoot),
      SyntaxError,
      'a marker must never let a malformed source skip strict preflight',
    );
  });

  it('marker with out-of-domain fingerprint values is rejected (R4 P1-4)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'max20x/2' },
    });
    // Target CONFLICTS with the source: only a trusted marker could skip the
    // conflict. Fingerprints that are not a 64-hex digest / 'absent' must be
    // rejected as evidence → full preflight → fail closed.
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        'max20x-2': { authType: 'oauth', clientId: 'openai', displayName: 'max20x/2' },
      }),
      'utf-8',
    );
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'runtime-migration.json'),
      JSON.stringify({
        v: 1,
        migratedAt: '2026-08-07T00:00:00.000Z',
        sourceFingerprints: { 'accounts.json': 'not-a-digest', 'credentials.json': 'absent' },
      }),
      'utf-8',
    );

    assert.throws(
      () => readCatalogAccounts(runtimeRoot),
      /migration conflict for "max20x-2"/,
      'malformed fingerprint values must not be accepted as completion evidence',
    );
  });

  it('marker missing a required fingerprint key is rejected (R4 P1-4)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'max20x/2' },
    });
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        'max20x-2': { authType: 'oauth', clientId: 'openai', displayName: 'max20x/2' },
      }),
      'utf-8',
    );
    // credentials.json key absent entirely → incomplete evidence.
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'runtime-migration.json'),
      JSON.stringify({
        v: 1,
        migratedAt: '2026-08-07T00:00:00.000Z',
        sourceFingerprints: { 'accounts.json': 'absent' },
      }),
      'utf-8',
    );

    assert.throws(
      () => readCatalogAccounts(runtimeRoot),
      /migration conflict for "max20x-2"/,
      'incomplete marker must not be accepted as completion evidence',
    );
  });

  it('marker with unknown schema version is ignored, not trusted (R3 P2-1)', async () => {
    setSplitEnv();
    await writeRuntimeAccounts({
      'max20x-2': { authType: 'oauth', clientId: 'anthropic', displayName: 'max20x/2' },
    });
    // Workspace target already equivalent → first migration completes and
    // writes a valid v1 marker with fingerprints matching the source.
    readCatalogAccounts(runtimeRoot);

    // Target now CONFLICTS with the source. A valid marker would legitimately
    // skip preflight (target is the user's domain after migration) — but a
    // marker with an unknown version must NOT be trusted as completion
    // evidence, so preflight re-runs and fails closed.
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        'max20x-2': { authType: 'oauth', clientId: 'openai', displayName: 'max20x/2' },
      }),
      'utf-8',
    );
    const { readFileSync } = await import('node:fs');
    const markerPath = join(workspaceRoot, '.cat-cafe', 'runtime-migration.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    marker.v = 999;
    await writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf-8');

    resetMigrationState();
    assert.throws(
      () => readCatalogAccounts(runtimeRoot),
      /migration conflict for "max20x-2"/,
      'unknown marker version must fall back to full preflight, which fails closed here',
    );
  });
});
