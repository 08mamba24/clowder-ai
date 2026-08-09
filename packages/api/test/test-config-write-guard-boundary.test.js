/**
 * P1-5: the test persistence boundary must be fail-CLOSED by default.
 *
 * A cat's shell is launched by the running API process, which exports
 * CAT_CAFE_RUNTIME_ROOT / CAT_CAFE_WORKSPACE_ROOT pointing at the live stores.
 * The runtime→workspace migration fires on the presence of those two variables
 * alone — it has nothing to do with a test's own project dir — so a bare
 * `node --test` used to copy accounts into the outer workspace and write a
 * completion marker, while still exiting 0. scripts/with-test-home.sh strips
 * those roots, but it is an OPTIONAL entrypoint, so safety depended on the
 * caller remembering it. That is not a boundary, it is a convention.
 *
 * These tests spawn a child the unsafe way ON PURPOSE — bare `node --test`,
 * no wrapper, CAT_CAFE_TEST_SANDBOX explicitly unset — against fake temp roots.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_ACCOUNTS_DIST = join(__dirname, '..', 'dist', 'config', 'catalog-accounts.js');

const tempRoots = [];
function makeTemp(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * Fake outer stores + an inner test file that does nothing but read the catalog
 * — which is enough, because reading triggers the migration.
 */
function buildFixture() {
  const runtimeRoot = makeTemp('p15-outer-runtime-');
  const workspaceRoot = makeTemp('p15-outer-workspace-');
  const fakeHome = makeTemp('p15-fake-home-');
  const innerDir = makeTemp('p15-inner-test-');

  mkdirSync(join(runtimeRoot, '.cat-cafe'), { recursive: true });
  mkdirSync(join(workspaceRoot, '.cat-cafe'), { recursive: true });
  writeFileSync(
    join(runtimeRoot, '.cat-cafe', 'accounts.json'),
    `${JSON.stringify({ outer: { authType: 'api_key', clientId: 'anthropic', displayName: 'outer' } }, null, 2)}\n`,
  );
  writeFileSync(
    join(runtimeRoot, '.cat-cafe', 'credentials.json'),
    `${JSON.stringify({ outer: { apiKey: 'sk-outer-should-never-move' } }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const innerTest = join(innerDir, 'inner.test.mjs');
  writeFileSync(
    innerTest,
    [
      "import { test } from 'node:test';",
      `import { readCatalogAccounts } from ${JSON.stringify(CATALOG_ACCOUNTS_DIST)};`,
      "test('reading the catalog must not reach the inherited outer store', () => {",
      `  readCatalogAccounts(${JSON.stringify(join(innerDir, 'project'))});`,
      '});',
      '',
    ].join('\n'),
  );

  return { runtimeRoot, workspaceRoot, fakeHome, innerTest };
}

function runBareChild({ runtimeRoot, workspaceRoot, fakeHome, innerTest }, extraEnv = {}) {
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  // These must be DELETED, not set to ''. This file itself runs under node:test,
  // and node treats an inherited NODE_TEST_CONTEXT — even empty — as "already
  // inside a run", silently skipping the child's file and exiting 0. That would
  // make both assertions below pass or fail for the wrong reason.
  for (const key of [
    'NODE_TEST_CONTEXT',
    // Explicitly NOT the sanctioned entrypoint: no wrapper, no opt-in flag.
    'CAT_CAFE_TEST_SANDBOX',
    'CAT_CAFE_TEST_REAL_HOME',
    'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT',
  ]) {
    delete env[key];
  }
  env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
  env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
  Object.assign(env, extraEnv);

  const res = spawnSync(process.execPath, ['--test', innerTest], { encoding: 'utf-8', env });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

function outerArtifacts(workspaceRoot) {
  return {
    accounts: existsSync(join(workspaceRoot, '.cat-cafe', 'accounts.json')),
    credentials: existsSync(join(workspaceRoot, '.cat-cafe', 'credentials.json')),
    marker: existsSync(join(workspaceRoot, '.cat-cafe', 'runtime-migration.json')),
  };
}

describe('test persistence boundary (P1-5)', () => {
  it('a bare `node --test` inheriting store roots fails before writing anything outside its fixture', () => {
    const fixture = buildFixture();
    const { status, out } = runBareChild(fixture);

    const written = outerArtifacts(fixture.workspaceRoot);
    assert.deepEqual(
      written,
      { accounts: false, credentials: false, marker: false },
      `no outer store file may be created. Child output:\n${out}`,
    );
    assert.notEqual(status, 0, `the child must FAIL, not silently exit 0. Output:\n${out}`);
    assert.match(out, /\[test sandbox\] Refusing/, 'the failure must name the boundary that refused');
    assert.match(out, /inherited from the launching process/);
  });

  /**
   * Positive control. Without it, the test above could pass simply because the
   * fixture never reaches the migration at all — proving nothing about the
   * guard. With the documented escape hatch the SAME fixture must really write
   * the outer store, which is what makes the refusal above meaningful.
   */
  it('the same fixture really does write the outer store when the guard is opted out', () => {
    const fixture = buildFixture();
    const { out } = runBareChild(fixture, { CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT: '1' });

    const written = outerArtifacts(fixture.workspaceRoot);
    assert.deepEqual(
      written,
      { accounts: true, credentials: true, marker: true },
      `the escape hatch must reproduce the original fail-open write. Child output:\n${out}`,
    );
  });

  /**
   * Criterion 3: the boundary must not have been bought by disabling migration
   * globally. A plain (non-test) node process — what production actually is —
   * must still perform the runtime→workspace migration against the same roots
   * that the test process above was refused.
   */
  it('a production (non-test) process still migrates against the same roots', () => {
    const fixture = buildFixture();
    const env = { ...process.env, HOME: fixture.fakeHome, USERPROFILE: fixture.fakeHome };
    for (const key of [
      'NODE_TEST_CONTEXT',
      'CAT_CAFE_TEST_SANDBOX',
      'CAT_CAFE_TEST_REAL_HOME',
      'CAT_CAFE_GLOBAL_CONFIG_ROOT',
      'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT',
    ]) {
      delete env[key];
    }
    env.CAT_CAFE_RUNTIME_ROOT = fixture.runtimeRoot;
    env.CAT_CAFE_WORKSPACE_ROOT = fixture.workspaceRoot;

    const res = spawnSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(CATALOG_ACCOUNTS_DIST)}).then((m) => m.readCatalogAccounts(${JSON.stringify(
          join(dirname(fixture.innerTest), 'project'),
        )}));`,
      ],
      { encoding: 'utf-8', env },
    );

    assert.equal(res.status, 0, `production migration must still succeed: ${res.stdout}${res.stderr}`);
    assert.deepEqual(
      outerArtifacts(fixture.workspaceRoot),
      { accounts: true, credentials: true, marker: true },
      'production behaviour must be unchanged — the guard is a TEST boundary, not a migration kill switch',
    );
  });

  /**
   * P1-7. CAT_CAFE_TEST_REAL_HOME used to REPLACE the passwd home in the
   * protected set, so any child could un-protect the operator's real home by
   * pointing it at a fake path — it is a hint about the caller's origin, not
   * the escape hatch (that is CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT).
   *
   * Decision-only, by construction: assertSafeTestConfigRoot throws before its
   * caller opens anything, so proving this costs no write to the real home.
   */
  it('the passwd home stays protected when CAT_CAFE_TEST_REAL_HOME names a fake one (P1-7)', async () => {
    const { assertSafeTestConfigRoot } = await import('../dist/config/test-config-write-guard.js');
    const passwdHome = userInfo().homedir;
    const fakeRealHome = makeTemp('p17-fake-real-home-');
    const saved = process.env.CAT_CAFE_TEST_REAL_HOME;
    try {
      process.env.CAT_CAFE_TEST_REAL_HOME = fakeRealHome;
      assert.throws(
        () => assertSafeTestConfigRoot(passwdHome, 'p17.probe'),
        /\[test sandbox\] Refusing/,
        'the passwd home must stay in the protected set no matter what the env claims',
      );
      // ...and the hint is additive, not ignored: its own path stays refused too.
      assert.throws(() => assertSafeTestConfigRoot(fakeRealHome, 'p17.probe'), /\[test sandbox\] Refusing/);
      // Control: an unrelated temp root is still allowed, so the two throws
      // above are not just "the guard refuses everything".
      assert.doesNotThrow(() => assertSafeTestConfigRoot(makeTemp('p17-neutral-'), 'p17.probe'));
    } finally {
      if (saved === undefined) delete process.env.CAT_CAFE_TEST_REAL_HOME;
      else process.env.CAT_CAFE_TEST_REAL_HOME = saved;
    }
  });

  it('the guard is active on NODE_TEST_CONTEXT alone, without the wrapper opt-in flag', async () => {
    const { assertSafeTestConfigRoot } = await import('../dist/config/test-config-write-guard.js');
    // This process runs under node:test, so the guard must be live even though
    // the assertion below never sets CAT_CAFE_TEST_SANDBOX itself.
    assert.ok(process.env.NODE_TEST_CONTEXT, 'precondition: running under the node test runner');
    const saved = process.env.CAT_CAFE_TEST_REAL_HOME;
    try {
      process.env.CAT_CAFE_TEST_REAL_HOME = '/p15-guard-probe-home';
      assert.throws(
        () => assertSafeTestConfigRoot('/p15-guard-probe-home', 'p15.probe'),
        /\[test sandbox\] Refusing/,
        'HOME must stay refused regardless of how the test process was launched',
      );
    } finally {
      if (saved === undefined) delete process.env.CAT_CAFE_TEST_REAL_HOME;
      else process.env.CAT_CAFE_TEST_REAL_HOME = saved;
    }
  });
});
