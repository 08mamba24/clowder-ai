/**
 * CLI contract for scripts/migration-dry-run.mjs (R5 P2-4).
 *
 * The script is a restart gate, so its EXIT CODE is the contract — printing
 * "BLOCK" while exiting 0 is worse than having no gate, because any
 * `if node migration-dry-run.mjs; then restart; fi` would sail straight past a
 * real conflict. These tests pin the code, not the prose.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'migration-dry-run.mjs');
const EXIT_OK = 0;
const EXIT_WOULD_BLOCK = 1;
const EXIT_UNTRUSTWORTHY = 2;
const EXIT_WOULD_MIGRATE = 3;

const tempRoots = [];
function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  mkdirSync(join(root, '.cat-cafe'), { recursive: true });
  return root;
}

function writeStore(root, file, value) {
  writeFileSync(join(root, '.cat-cafe', file), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The home this suite owns, created lazily and reused by every child.
 *
 * P1-12: HOME is the gate's THIRD input — the CLI snapshots homedir() and copies
 * four .cat-cafe files out of it — so leaving it inherited meant a bare
 * `node --test` on this file read and copied the operator's real home, and its
 * contents were then folded into the verdict these assertions pin. It was only
 * ever safe by accident, because scripts/with-test-home.sh happened to point
 * HOME somewhere else first. A test's own isolation cannot be delegated to the
 * caller remembering the wrapper.
 */
let suiteHome;
function ownedHome() {
  if (!suiteHome) suiteHome = makeRoot('dryrun-suite-home-');
  return suiteHome;
}

function runGate(workspace, runtime) {
  const res = spawnSync(process.execPath, [SCRIPT, '--workspace', workspace, '--runtime', runtime], {
    encoding: 'utf-8',
    // The gate reads these when the flags are absent; clear them so a developer's
    // live environment can never leak into the test's verdict.
    env: {
      ...process.env,
      CAT_CAFE_WORKSPACE_ROOT: '',
      CAT_CAFE_RUNTIME_ROOT: '',
      CAT_CAFE_GLOBAL_CONFIG_ROOT: '',
      // P1-12: the gate's third input, owned by this suite. USERPROFILE too —
      // os.homedir() reads it on Windows, so clearing only HOME would put the
      // same hole back on the other first-class platform.
      HOME: ownedHome(),
      USERPROFILE: ownedHome(),
    },
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const ACCOUNT = { authType: 'api_key', clientId: 'anthropic', displayName: 'shared-account' };

/**
 * Produce a REAL completion marker by running the real migration once.
 * Hand-writing one would mean re-deriving production's canonical fingerprint
 * inside the test, which drifts the moment production changes.
 */
async function seedRealMarker(workspace, runtime) {
  const saved = {
    ws: process.env.CAT_CAFE_WORKSPACE_ROOT,
    rt: process.env.CAT_CAFE_RUNTIME_ROOT,
    global: process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
  };
  const mod = await import('../dist/config/catalog-accounts.js');
  try {
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspace;
    process.env.CAT_CAFE_RUNTIME_ROOT = runtime;
    delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    // P1-12: this runs the REAL migration in-process, and ensureMigrated() opens
    // $HOME before it touches either root. Same suite-owned home as the children.
    process.env.HOME = ownedHome();
    process.env.USERPROFILE = ownedHome();
    mod.resetMigrationState();
    mod.readCatalogAccounts(workspace);
  } finally {
    if (saved.ws === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    else process.env.CAT_CAFE_WORKSPACE_ROOT = saved.ws;
    if (saved.rt === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
    else process.env.CAT_CAFE_RUNTIME_ROOT = saved.rt;
    if (saved.global !== undefined) process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = saved.global;
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.userProfile;
    mod.resetMigrationState();
  }
  assert.ok(
    existsSync(join(workspace, '.cat-cafe', 'runtime-migration.json')),
    'the real migration must have left a completion marker',
  );
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('migration-dry-run CLI gate', () => {
  it('exits 0 when the rehearsal is a no-op and the negative control is sensitive', () => {
    const workspace = makeRoot('dryrun-noop-ws-');
    const runtime = makeRoot('dryrun-noop-rt-');
    writeStore(workspace, 'accounts.json', { shared: ACCOUNT });
    writeStore(runtime, 'accounts.json', { shared: ACCOUNT });
    writeStore(workspace, 'credentials.json', { shared: { apiKey: 'sk-same' } });
    writeStore(runtime, 'credentials.json', { shared: { apiKey: 'sk-same' } });

    const { status, out } = runGate(workspace, runtime);
    assert.equal(status, EXIT_OK, `expected a clean gate, got:\n${out}`);
    // Deliberately NOT /no-op/: since R6 P2-8 the claim is scoped to store
    // content, because a first successful start still writes the marker.
    assert.match(out, /no store change/);
    assert.match(out, /changes NOTHING in accounts\.json \/ credentials\.json/);
  });

  it('exits 1 when the migration would BLOCK — never 0 with a BLOCK printed', () => {
    const workspace = makeRoot('dryrun-conflict-ws-');
    const runtime = makeRoot('dryrun-conflict-rt-');
    writeStore(workspace, 'accounts.json', { shared: { ...ACCOUNT, displayName: 'workspace-name' } });
    writeStore(runtime, 'accounts.json', { shared: { ...ACCOUNT, displayName: 'runtime-name' } });

    const { status, out } = runGate(workspace, runtime);
    assert.match(out, /BLOCK/, 'the conflict must be reported');
    assert.equal(status, EXIT_WOULD_BLOCK, `a printed BLOCK must not exit 0. Output:\n${out}`);
  });

  it('exits 2 when a root does not exist instead of reporting a phantom no-op', () => {
    const workspace = makeRoot('dryrun-badroot-ws-');
    const { status, out } = runGate(workspace, join(tmpdir(), 'dryrun-does-not-exist-abcdef'));
    assert.equal(status, EXIT_UNTRUSTWORTHY, `missing root must be untrustworthy, got:\n${out}`);
    assert.match(out, /runtime root is not an existing directory/);
  });

  it('exits 2 when both roots are missing (the case that used to print OK ... no-op)', () => {
    const { status, out } = runGate(
      join(tmpdir(), 'dryrun-missing-ws-abcdef'),
      join(tmpdir(), 'dryrun-missing-rt-abcdef'),
    );
    assert.equal(status, EXIT_UNTRUSTWORTHY, `both roots missing must be untrustworthy, got:\n${out}`);
    // Must track the CURRENT clean-verdict wording. This assertion used to read
    // /no-op/, which P2-8 renamed out of the output entirely — leaving a check
    // that could never fail and therefore proved nothing.
    assert.doesNotMatch(
      out,
      /no store change|✅ exit 0/,
      'a nonexistent pair must never be described as a clean verdict',
    );
  });

  it('exits 2 when the runtime store is absent — a gate must not read silence as safe', () => {
    const workspace = makeRoot('dryrun-empty-ws-');
    const runtime = makeRoot('dryrun-empty-rt-');
    writeStore(workspace, 'accounts.json', { shared: ACCOUNT });

    const { status, out } = runGate(workspace, runtime);
    assert.equal(status, EXIT_UNTRUSTWORTHY, `absent runtime store must be untrustworthy, got:\n${out}`);
    assert.match(out, /no runtime account store/);
  });

  it('exits 2 when an input file is malformed', () => {
    const workspace = makeRoot('dryrun-malformed-ws-');
    const runtime = makeRoot('dryrun-malformed-rt-');
    writeStore(workspace, 'accounts.json', { shared: ACCOUNT });
    writeFileSync(join(runtime, '.cat-cafe', 'accounts.json'), '{ not json', { mode: 0o600 });

    const { status, out } = runGate(workspace, runtime);
    assert.equal(status, EXIT_UNTRUSTWORTHY, `malformed input must be untrustworthy, got:\n${out}`);
    assert.match(out, /is not a JSON object/);
  });

  // ── R6 P2-5: root validation must precede the same-root short-circuit ──
  it('exits 2 when both roots are the SAME nonexistent path (must not short-circuit to 0)', () => {
    const missing = join(tmpdir(), 'dryrun-same-missing-abcdef');
    const { status, out } = runGate(missing, missing);
    assert.equal(status, EXIT_UNTRUSTWORTHY, `same nonexistent root must not be a clean short-circuit:\n${out}`);
    assert.doesNotMatch(out, /short-circuits/, 'a nonexistent root pair must never claim a legitimate short-circuit');
  });

  it('exits 2 when both roots are the same path but it is a file, not a directory', () => {
    const holder = makeRoot('dryrun-same-file-');
    const asFile = join(holder, 'not-a-dir');
    writeFileSync(asFile, 'x');
    const { status, out } = runGate(asFile, asFile);
    assert.equal(status, EXIT_UNTRUSTWORTHY, `a file passed as a root must be rejected:\n${out}`);
    assert.match(out, /not-a-directory/);
  });

  it('exits 0 for a genuine same-root short-circuit (validated directory)', () => {
    const root = makeRoot('dryrun-same-valid-');
    writeStore(root, 'accounts.json', { shared: ACCOUNT });
    const { status, out } = runGate(root, root);
    assert.equal(status, EXIT_OK, `a valid same-root pair genuinely has nothing to migrate:\n${out}`);
    assert.match(out, /short-circuits/);
  });

  // ── R6 P2-6: exit 0 means "no change"; a real merge is not a no-op ──
  it('exits 3 when the rehearsal would merge new entries, and never calls it a no-op', () => {
    const workspace = makeRoot('dryrun-merge-ws-');
    const runtime = makeRoot('dryrun-merge-rt-');
    // Shared ref is equivalent (so the negative control still has a probe target),
    // but the runtime carries one extra account that would really be written.
    writeStore(workspace, 'accounts.json', { shared: ACCOUNT });
    writeStore(runtime, 'accounts.json', { shared: ACCOUNT, 'runtime-only': { ...ACCOUNT, displayName: 'extra' } });

    const { status, out } = runGate(workspace, runtime);
    assert.equal(status, EXIT_WOULD_MIGRATE, `a data-writing migration must not exit 0. Output:\n${out}`);
    assert.match(out, /would WRITE 1 entry/);
    assert.match(out, /runtime-only/);
    assert.doesNotMatch(out, /✅ exit 0/, 'a merge must never be summarised as a clean no-op');
  });

  it('exits 3 when only a credential would be merged', () => {
    const workspace = makeRoot('dryrun-mergecred-ws-');
    const runtime = makeRoot('dryrun-mergecred-rt-');
    writeStore(workspace, 'accounts.json', { shared: ACCOUNT });
    writeStore(runtime, 'accounts.json', { shared: ACCOUNT });
    writeStore(workspace, 'credentials.json', { shared: { apiKey: 'sk-same' } });
    writeStore(runtime, 'credentials.json', { shared: { apiKey: 'sk-same' }, extra: { apiKey: 'sk-extra' } });

    const { status, out } = runGate(workspace, runtime);
    assert.equal(status, EXIT_WOULD_MIGRATE, `a credential merge must not exit 0. Output:\n${out}`);
    assert.match(out, /credentials=\[extra\]/);
  });

  // ── R6 P2-7: per-ref diagnosis rewrites the source, so its conflicts describe
  // a hypothetical. Only the full rehearsal decides what the next start does. ──
  it('stays at exit 0 when a valid marker makes the next start a skip, even though per-ref diagnosis conflicts', async () => {
    const workspace = makeRoot('dryrun-marker-ws-');
    const runtime = makeRoot('dryrun-marker-rt-');
    writeStore(runtime, 'accounts.json', { shared: ACCOUNT });
    writeStore(runtime, 'credentials.json', { shared: { apiKey: 'sk-same' } });

    await seedRealMarker(workspace, runtime);

    // The user then legitimately edits the migrated target. The source is
    // untouched, so the real next start matches the marker and skips.
    writeStore(workspace, 'accounts.json', { shared: { ...ACCOUNT, displayName: 'user-edited-after-migration' } });

    const { status, out } = runGate(workspace, runtime);
    assert.match(out, /DIAGNOSTIC ONLY/, 'section B must be labelled diagnostic');
    assert.match(out, /BLOCK {2}account "shared" alone/, 'the per-ref case does conflict — that is the point');
    assert.equal(status, EXIT_OK, `per-ref diagnosis must not raise the exit code. Output:\n${out}`);
  });

  // ── R6 P2-8: exit 0 means "no account/credential change", NOT "no file is
  // written". The completion marker is written on the first successful start
  // even when zero account data moves, so the gate must say so out loud. ──
  it('exits 0 but states the marker would be CREATED — never claims nothing is written', () => {
    const workspace = makeRoot('dryrun-markercreate-ws-');
    const runtime = makeRoot('dryrun-markercreate-rt-');
    // This is the real store's shape today: fully equivalent, marker not yet written.
    writeStore(workspace, 'accounts.json', { shared: ACCOUNT });
    writeStore(runtime, 'accounts.json', { shared: ACCOUNT });
    writeStore(workspace, 'credentials.json', { shared: { apiKey: 'sk-same' } });
    writeStore(runtime, 'credentials.json', { shared: { apiKey: 'sk-same' } });
    assert.equal(existsSync(join(workspace, '.cat-cafe', 'runtime-migration.json')), false);

    const { status, out } = runGate(workspace, runtime);
    assert.equal(status, EXIT_OK, `an equivalent pair must still be exit 0, got:\n${out}`);
    assert.match(out, /marker=created/, 'section A must report the marker action, not just "written"');
    assert.match(out, /would CREATE .*runtime-migration\.json/, 'the verdict must name the file it would write');
    assert.doesNotMatch(
      out,
      /nothing would be written|no file is written/i,
      'exit 0 must never claim a zero-write start while the marker is created',
    );
  });

  it('exits 0 and reports the marker UNCHANGED when a valid marker makes the start a skip', async () => {
    const workspace = makeRoot('dryrun-markerskip-ws-');
    const runtime = makeRoot('dryrun-markerskip-rt-');
    writeStore(runtime, 'accounts.json', { shared: ACCOUNT });
    writeStore(runtime, 'credentials.json', { shared: { apiKey: 'sk-same' } });
    await seedRealMarker(workspace, runtime);

    const { status, out } = runGate(workspace, runtime);
    assert.equal(status, EXIT_OK, `an already-migrated pair must be exit 0, got:\n${out}`);
    assert.match(out, /marker=unchanged/, 'a skipped migration must not be reported as writing the marker');
    assert.doesNotMatch(out, /would CREATE/, 'an existing marker must never be described as newly created');
  });

  it('exits 2 when there is no shared ref, because the negative control cannot run', () => {
    const workspace = makeRoot('dryrun-noshared-ws-');
    const runtime = makeRoot('dryrun-noshared-rt-');
    writeStore(workspace, 'accounts.json', { 'workspace-only': ACCOUNT });
    writeStore(runtime, 'accounts.json', { 'runtime-only': ACCOUNT });

    const { status, out } = runGate(workspace, runtime);
    assert.equal(status, EXIT_UNTRUSTWORTHY, `unproven sensitivity must not exit 0, got:\n${out}`);
    assert.match(out, /negative control could not run/);
  });
});

/**
 * P1-12: this suite must own HOME, not inherit it.
 *
 * The scenario below is the exact clean-gate case from the first test, run with
 * a hostile home in the OUTER process — which is all a bare `node --test` on
 * this file ever was. Both tests fail if either half of the isolation is
 * removed: the child override in runGate(), or the in-process override around
 * seedRealMarker().
 *
 * Only mkdtemp roots, and the probe is asserted by REF name — never by value.
 */
const OUTER_HOME_PROBE_REF = 'installer-anthropic';

/**
 * `await fn()`, not `return fn()`: seedRealMarker() is async, so a synchronous
 * finally restores the real home at its first await — before the migration it
 * is supposed to be watching has run at all. Caught by mutation M6, which the
 * first version of this helper could not kill.
 */
async function withOuterHome(hostileHome, fn) {
  const saved = { home: process.env.HOME, userProfile: process.env.USERPROFILE };
  try {
    process.env.HOME = hostileHome;
    process.env.USERPROFILE = hostileHome;
    return await fn();
  } finally {
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.userProfile;
  }
}

/** A home carrying one fake builtin credential — enough to move the verdict. */
function hostileHomeRoot() {
  const hostile = makeRoot('dryrun-hostile-outer-home-');
  writeStore(hostile, 'credentials.json', { [OUTER_HOME_PROBE_REF]: { apiKey: 'sk-p112-outer-home-probe' } });
  return hostile;
}

describe('migration-dry-run harness home isolation (P1-12)', () => {
  it('an inherited HOME cannot become an input to the gate, or change its verdict', async () => {
    const workspace = makeRoot('dryrun-p112-ws-');
    const runtime = makeRoot('dryrun-p112-rt-');
    writeStore(workspace, 'accounts.json', { shared: ACCOUNT });
    writeStore(runtime, 'accounts.json', { shared: ACCOUNT });
    const hostile = hostileHomeRoot();

    const { status, out } = await withOuterHome(hostile, () => runGate(workspace, runtime));

    assert.equal(status, EXIT_OK, `the verdict must not depend on the caller's home, got:\n${out}`);
    assert.doesNotMatch(
      out,
      new RegExp(OUTER_HOME_PROBE_REF),
      'a credential ref from the outer home must never appear as gate input',
    );
    assert.ok(!out.includes(hostile), 'the gate must not have snapshotted the outer home at all');
    assert.ok(out.includes(ownedHome()), 'the gate must report the suite-owned home as its third input');
  });

  it('the in-process marker seed migrates from the suite home, not the inherited one', async () => {
    const workspace = makeRoot('dryrun-p112-seed-ws-');
    const runtime = makeRoot('dryrun-p112-seed-rt-');
    writeStore(runtime, 'accounts.json', { shared: ACCOUNT });
    const hostile = hostileHomeRoot();

    // seedRealMarker() runs the REAL migration in this process; its own assert
    // proves the marker was written, so the migration genuinely ran.
    await withOuterHome(hostile, () => seedRealMarker(workspace, runtime));

    const credPath = join(workspace, '.cat-cafe', 'credentials.json');
    const migrated = existsSync(credPath) ? readFileSync(credPath, 'utf-8') : '';
    assert.ok(
      !migrated.includes(OUTER_HOME_PROBE_REF),
      'the outer home must not be a migration source for the suite fixture',
    );
  });
});

describe('migration-dry-run decision layer', () => {
  it('never lets a later clean section lower an earlier verdict, and ranks severity not code number', async () => {
    const mod = await import('../scripts/migration-dry-run.mjs');
    assert.equal(mod.decideExitCode([]), mod.EXIT_OK);
    assert.equal(mod.decideExitCode([{ kind: 'conflict', message: 'x' }]), mod.EXIT_WOULD_BLOCK);
    assert.equal(mod.decideExitCode([{ kind: 'input', message: 'x' }]), mod.EXIT_UNTRUSTWORTHY);
    assert.equal(mod.decideExitCode([{ kind: 'migrate', message: 'x' }]), mod.EXIT_WOULD_MIGRATE);
    // A conflict outranks a merge even though 1 < 3 numerically.
    assert.equal(
      mod.decideExitCode([
        { kind: 'migrate', message: 'x' },
        { kind: 'conflict', message: 'y' },
      ]),
      mod.EXIT_WOULD_BLOCK,
    );
    // Untrustworthy outranks everything, including the higher-numbered code 3.
    assert.equal(
      mod.decideExitCode([
        { kind: 'migrate', message: 'x' },
        { kind: 'conflict', message: 'y' },
        { kind: 'integrity', message: 'z' },
      ]),
      mod.EXIT_UNTRUSTWORTHY,
    );
    // An unknown finding kind must fail closed, never be treated as harmless.
    assert.equal(mod.decideExitCode([{ kind: 'something-new', message: 'x' }]), mod.EXIT_UNTRUSTWORTHY);
  });

  it('flags a negative control that failed to block', async () => {
    const { evaluateNegativeControl, decideExitCode, EXIT_UNTRUSTWORTHY } = await import(
      '../scripts/migration-dry-run.mjs'
    );
    assert.deepEqual(evaluateNegativeControl([{ label: 'probe', blocked: true }]), []);
    const findings = evaluateNegativeControl([
      { label: 'changed displayName', blocked: false },
      { label: 'extra envVars key', blocked: true },
    ]);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /not sensitive/);
    assert.equal(decideExitCode(findings), EXIT_UNTRUSTWORTHY);
  });

  it('rejects roots that are files rather than directories', async () => {
    const { validateRoots } = await import('../scripts/migration-dry-run.mjs');
    const findings = validateRoots({
      workspaceRoot: '/tmp/ws',
      runtimeRoot: '/tmp/rt',
      statDir: (p) => (p === '/tmp/ws' ? 'dir' : 'not-a-directory'),
    });
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /runtime root is not an existing directory/);
  });

  it('separates a newly created marker from one that was already there', async () => {
    const { classifyMarkerAction } = await import('../scripts/migration-dry-run.mjs');
    const present = (content) => ({ present: true, content });
    const absent = { present: false, content: null };
    // The bug this pins: the sandbox copy makes "present after the run" true in
    // both the created and the pre-existing case (R6 P2-8).
    assert.equal(classifyMarkerAction(absent, present('{"v":1}')), 'created');
    assert.equal(classifyMarkerAction(present('{"v":1}'), present('{"v":1}')), 'unchanged');
    assert.equal(classifyMarkerAction(present('{"v":1,"a":1}'), present('{"v":1,"a":2}')), 'replaced');
    assert.equal(classifyMarkerAction(absent, absent), 'not-written');
  });

  it('rejects a runtime store that is entirely absent', async () => {
    const { validateStores } = await import('../scripts/migration-dry-run.mjs');
    const findings = validateStores({
      workspaceRoot: '/tmp/ws',
      runtimeRoot: '/tmp/rt',
      readStore: () => ({ state: 'absent', value: null }),
    });
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /no runtime account store/);
  });
});
