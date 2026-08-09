#!/usr/bin/env node
/**
 * Read-only rehearsal of the runtime→workspace account-store migration (OQ1).
 *
 * Why a rehearsal and not a predictor: since R3 the equivalence check compares
 * every field (clientId/envVars/...), so "will the first real start be a no-op
 * or a fail-closed conflict?" can only be answered by the migration's OWN
 * semantics. Re-implementing them here would drift from production and give a
 * confidently wrong answer. So this script COPIES every input into a private
 * temp sandbox and runs the real dist code against the copies.
 *
 * There are THREE inputs, not two: ensureMigrated() reads the operator's HOME
 * (credentials.json and the legacy provider-profiles pair) before it ever looks
 * at the runtime→workspace pair, and can merge what it finds into the workspace
 * store. Earlier versions of this gate copied workspace and runtime but left
 * HOME pointing at the live directory, so the verdict depended on data the
 * sandbox had never captured. HOME is now materialised alongside the other two,
 * and the real HOME files are covered by the section C integrity proof.
 *
 * This is a RESTART GATE, so its EXIT CODE is the contract (R5 P2-4, R6 P2-5..8):
 *   exit 0 — accounts.json / credentials.json would not change at all; safe to
 *            restart unattended. NOT "no file is written": a first successful
 *            start still records its completion marker (see below).
 *   exit 1 — the migration would BLOCK (conflict). Do not restart.
 *   exit 2 — the GATE itself is untrustworthy: bad roots/inputs, negative
 *            control failed to block, or a real file changed. Do not restart.
 *   exit 3 — the migration would SUCCEED but WRITE account/credential store
 *            entries. Expected on a genuine first migration, but it is a data
 *            movement touching credentials, so it needs a human, not an `if`.
 *
 * The completion marker (.cat-cafe/runtime-migration.json) is deliberately NOT
 * part of that scale (R6 P2-8). It is housekeeping — sha256 fingerprints of the
 * source files, so the next process can tell "already migrated" from "source
 * changed" — and it is created on the very first successful start even when
 * zero account data moves. Grading it as a data write would make the expected
 * first restart report exit 3 and train the operator to wave code 3 through,
 * which is exactly the signal that must stay meaningful. So the marker never
 * changes the exit code, and every rehearsal states its action explicitly
 * instead of leaving the operator to infer it.
 *
 * A conflict printed with exit 0 — or a merge reported as a no-op — would be
 * worse than having no gate at all, so findings accumulate and no later section
 * may lower an earlier verdict.
 *
 * Section A (full rehearsal) is the ONLY section that decides what the next real
 * start does. Section B rehearses one ref at a time for diagnosis, which means
 * rewriting the source — that changes its fingerprint and can invalidate a valid
 * completion marker, so B's conflicts are DIAGNOSTIC ONLY and never raise the
 * exit code (R6 P2-7). Section D deliberately feeds known-bad sources: those
 * probes must block, and a probe that does not proves the instrument is blind,
 * which is a property of the gate itself and therefore does raise it.
 *
 * Guarantees:
 *   - The real stores — workspace, runtime AND home — are only ever read. A
 *     before/after stat fingerprint of every real file is printed as proof, and
 *     a mismatch forces exit 2.
 *   - The sandbox is mkdtemp (0700) and removed in a finally block.
 *   - No credential VALUES are printed. Conflict text is whatever production
 *     would print at startup (field names; credential conflicts are value-free).
 *
 * Usage:
 *   node scripts/migration-dry-run.mjs --workspace <persistent root> --runtime <checkout root>
 *   (each defaults to CAT_CAFE_WORKSPACE_ROOT / CAT_CAFE_RUNTIME_ROOT)
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_SUBDIR = '.cat-cafe';
const ACCOUNTS = 'accounts.json';
const CREDENTIALS = 'credentials.json';
const MARKER = 'runtime-migration.json';
const STORE_FILES = [ACCOUNTS, CREDENTIALS, MARKER];

/**
 * The operator's real home, captured at load — before any rehearsal repoints
 * HOME at its sandbox copy.
 */
const REAL_HOME = homedir();

/**
 * HOME is the migration's THIRD input, and this gate used to forget it.
 *
 * ensureMigrated() runs migrateHomedirCredentials() and
 * migrateHomedirLegacyProviderProfiles() before it ever looks at the
 * runtime→workspace pair, so the next real start reads these files out of the
 * operator's home and can merge them into the workspace store. The rehearsal
 * copied workspace and runtime into a sandbox but left HOME pointing at the live
 * one: its verdict depended on data it had not captured, and a rehearsal that
 * imports from a directory it did not snapshot cannot claim to be read-only
 * about it. So HOME is now materialised into the sandbox like the other two, and
 * its real files are included in the section C integrity proof.
 */
const HOME_SOURCE_FILES = [ACCOUNTS, CREDENTIALS, 'provider-profiles.json', 'provider-profiles.secrets.local.json'];

export const EXIT_OK = 0;
export const EXIT_WOULD_BLOCK = 1;
export const EXIT_UNTRUSTWORTHY = 2;
export const EXIT_WOULD_MIGRATE = 3;

/**
 * Severity, worst last. Not the numeric code — "untrustworthy" outranks
 * "would block" even though 2 < 3.
 */
const SEVERITY = [EXIT_OK, EXIT_WOULD_MIGRATE, EXIT_WOULD_BLOCK, EXIT_UNTRUSTWORTHY];
const KIND_TO_CODE = {
  migrate: EXIT_WOULD_MIGRATE,
  conflict: EXIT_WOULD_BLOCK,
};

/**
 * Pure decision layer, exported so the gate's own arithmetic is unit-testable
 * without having to break production first.
 */
export function decideExitCode(findings) {
  let worst = EXIT_OK;
  for (const f of findings) {
    const code = KIND_TO_CODE[f.kind] ?? EXIT_UNTRUSTWORTHY;
    if (SEVERITY.indexOf(code) > SEVERITY.indexOf(worst)) worst = code;
  }
  return worst;
}

/**
 * What the rehearsal did to the completion marker. `existsSync` after the run
 * cannot answer this: the real workspace marker is copied into the sandbox
 * first, so "present" conflates "we just created it" with "it was already
 * there" (R6 P2-8). Content comparison separates them.
 */
export function classifyMarkerAction(before, after) {
  if (!after.present) return 'not-written';
  if (!before.present) return 'created';
  return before.content === after.content ? 'unchanged' : 'replaced';
}

/** Operator-facing description of each marker action — never inferred, always printed. */
export const MARKER_ACTION_NOTE = {
  created: `would CREATE ${CONFIG_SUBDIR}/${MARKER} (0600) — completion evidence only: sha256 fingerprints of the source files, no account or credential content. Exit 0 covers store CONTENT; this housekeeping file is the one write it still permits.`,
  replaced: `would REPLACE ${CONFIG_SUBDIR}/${MARKER} (0600) with refreshed source fingerprints — housekeeping, not account data.`,
  unchanged: `leaves ${CONFIG_SUBDIR}/${MARKER} unchanged (the source already matches the recorded fingerprints).`,
  'not-written': `writes no ${CONFIG_SUBDIR}/${MARKER} (the migration did not reach the completion step).`,
};

/**
 * The negative control is what makes an all-OK report evidence rather than an
 * untested harness: if a source we KNOW is non-equivalent fails to block, the
 * rehearsal proves nothing and the gate must not report success.
 */
export function evaluateNegativeControl(probes) {
  return probes
    .filter((p) => !p.blocked)
    .map((p) => ({
      kind: 'negative-control',
      message: `negative control "${p.label}" did not BLOCK — the rehearsal is not sensitive, ignore its OK verdicts`,
    }));
}

/**
 * Roots must be real directories before ANY verdict — including the same-root
 * short-circuit, which used to fire first and report two nonexistent paths as a
 * clean exit 0 (R6 P2-5).
 */
export function validateRoots({ workspaceRoot, runtimeRoot, statDir }) {
  const findings = [];
  for (const [label, root] of [
    ['workspace', workspaceRoot],
    ['runtime', runtimeRoot],
  ]) {
    const kind = statDir(root);
    if (kind !== 'dir') {
      findings.push({ kind: 'input', message: `${label} root is not an existing directory: ${root} (${kind})` });
    }
  }
  return findings;
}

/** Store files must be absent-or-valid; a malformed one is never a safe input. */
export function validateStores({ workspaceRoot, runtimeRoot, readStore }) {
  const findings = [];
  const runtimeAccounts = readStore(runtimeRoot, ACCOUNTS);
  const runtimeCreds = readStore(runtimeRoot, CREDENTIALS);
  if (runtimeAccounts.state === 'absent' && runtimeCreds.state === 'absent') {
    findings.push({
      kind: 'input',
      message: `no runtime account store under ${resolve(runtimeRoot, CONFIG_SUBDIR)} — wrong --runtime root? (a genuinely empty runtime checkout has nothing to rehearse, but a restart gate must not read that as "safe")`,
    });
  }
  for (const [root, file, read] of [
    [runtimeRoot, ACCOUNTS, runtimeAccounts],
    [runtimeRoot, CREDENTIALS, runtimeCreds],
    [workspaceRoot, ACCOUNTS, readStore(workspaceRoot, ACCOUNTS)],
    [workspaceRoot, CREDENTIALS, readStore(workspaceRoot, CREDENTIALS)],
    [workspaceRoot, MARKER, readStore(workspaceRoot, MARKER)],
  ]) {
    if (read.state === 'invalid') {
      findings.push({
        kind: 'input',
        message: `${resolve(root, CONFIG_SUBDIR, file)} is not a JSON object: ${read.reason}`,
      });
    }
  }
  return findings;
}

function statDirOnDisk(path) {
  if (!path) return 'empty';
  if (!existsSync(path)) return 'missing';
  return statSync(path).isDirectory() ? 'dir' : 'not-a-directory';
}

/** {state: 'absent'|'ok'|'invalid'} — an absent file is legitimate, a malformed one never is. */
function readStoreOnDisk(root, file) {
  const path = resolve(root, CONFIG_SUBDIR, file);
  if (!existsSync(path)) return { state: 'absent', value: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    return { state: 'invalid', reason: String(error?.message), value: null };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { state: 'invalid', reason: 'top level is not an object', value: null };
  }
  return { state: 'ok', value: parsed };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workspace' || argv[i] === '--runtime') out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

/** Identity of a real file, for proving we never wrote to it. */
function statFingerprint(path) {
  if (!existsSync(path)) return 'absent';
  const s = statSync(path);
  return `size=${s.size} mtimeMs=${s.mtimeMs} mode=${(s.mode & 0o777).toString(8)}`;
}

function snapshotStores(roots, files = STORE_FILES) {
  const snap = {};
  for (const root of roots) {
    for (const file of files) {
      const p = resolve(root, CONFIG_SUBDIR, file);
      snap[p] = statFingerprint(p);
    }
  }
  return snap;
}

function refsOf(store) {
  return store.state === 'ok' ? Object.keys(store.value) : [];
}

function mergedCount(r) {
  return r.addedAccounts.length + r.addedCreds.length;
}

/** Exact bytes of the sandbox marker, so "created" and "already there" stay distinguishable. */
function readMarkerState(root) {
  const path = resolve(root, CONFIG_SUBDIR, MARKER);
  if (!existsSync(path)) return { present: false, content: null };
  return { present: true, content: readFileSync(path, 'utf-8'), mode: (statSync(path).mode & 0o777).toString(8) };
}

function verdictLine(r) {
  if (r.error) return `BLOCK  ${r.label}\n         ${r.error.message}`;
  const merged = mergedCount(r);
  const detail =
    merged === 0 ? 'no store change (everything already equivalent/present)' : `merges ${merged} entry(ies)`;
  const acc = r.addedAccounts.length ? ` accounts=[${r.addedAccounts.join(', ')}]` : '';
  const cred = r.addedCreds.length ? ` credentials=[${r.addedCreds.join(', ')}]` : '';
  return `OK     ${r.label} → ${detail}${acc}${cred}; marker=${r.markerAction}`;
}

/** Copy the real pair into one throwaway sandbox; `overrideRuntime` replaces source content. */
function materialiseSandbox({ caseRoot, workspaceReal, runtimeReal, overrideRuntime }) {
  const wsRoot = resolve(caseRoot, 'workspace');
  const rtRoot = resolve(caseRoot, 'runtime');
  mkdirSync(resolve(wsRoot, CONFIG_SUBDIR), { recursive: true });
  mkdirSync(resolve(rtRoot, CONFIG_SUBDIR), { recursive: true });
  for (const file of STORE_FILES) {
    const src = resolve(workspaceReal, CONFIG_SUBDIR, file);
    if (existsSync(src)) copyFileSync(src, resolve(wsRoot, CONFIG_SUBDIR, file));
  }
  for (const file of [ACCOUNTS, CREDENTIALS]) {
    if (overrideRuntime && file in overrideRuntime) {
      writeFileSync(resolve(rtRoot, CONFIG_SUBDIR, file), `${JSON.stringify(overrideRuntime[file], null, 2)}\n`, {
        mode: 0o600,
      });
      continue;
    }
    const src = resolve(runtimeReal, CONFIG_SUBDIR, file);
    if (existsSync(src)) copyFileSync(src, resolve(rtRoot, CONFIG_SUBDIR, file));
  }
  // The third input: whatever the homedir migrations would read on the next
  // real start. Copied at 0600 like the store files, into the same mkdtemp tree
  // that the finally block removes.
  const homeRoot = resolve(caseRoot, 'home');
  mkdirSync(resolve(homeRoot, CONFIG_SUBDIR), { recursive: true });
  for (const file of HOME_SOURCE_FILES) {
    const src = resolve(REAL_HOME, CONFIG_SUBDIR, file);
    if (existsSync(src)) copyFileSync(src, resolve(homeRoot, CONFIG_SUBDIR, file));
  }
  return { wsRoot, rtRoot, homeRoot };
}

function pointEnvAtSandbox(wsRoot, rtRoot, homeRoot) {
  process.env.CAT_CAFE_WORKSPACE_ROOT = wsRoot;
  process.env.CAT_CAFE_RUNTIME_ROOT = rtRoot;
  process.env.CAT_CAFE_TEST_SANDBOX = '1'; // refuse any write that resolves to repo root / HOME
  // HOME points at the sandbox copy, so the homedir migrations rehearse against
  // captured input instead of live data. CAT_CAFE_TEST_REAL_HOME keeps naming
  // the OPERATOR's home — which is what must stay off-limits. Setting it to
  // process.env.HOME, as this did before, protected whichever home the rehearsal
  // was about to read from: self-contradictory once reads are guarded (P1-9).
  process.env.HOME = homeRoot;
  process.env.USERPROFILE = homeRoot;
  process.env.CAT_CAFE_TEST_REAL_HOME = REAL_HOME;
  delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
}

/** Run the REAL migration against sandbox copies and describe what it did. */
async function rehearse({ label, caseRoot, workspaceReal, runtimeReal, overrideRuntime, mod }) {
  const { wsRoot, rtRoot, homeRoot } = materialiseSandbox({ caseRoot, workspaceReal, runtimeReal, overrideRuntime });
  pointEnvAtSandbox(wsRoot, rtRoot, homeRoot);

  mod.resetMigrationState();

  const accountsBefore = refsOf(readStoreOnDisk(wsRoot, ACCOUNTS));
  const credsBefore = refsOf(readStoreOnDisk(wsRoot, CREDENTIALS));
  const markerBefore = readMarkerState(wsRoot);

  let error = null;
  try {
    mod.readCatalogAccounts(wsRoot);
  } catch (e) {
    error = e;
  }

  const accountsAfter = refsOf(readStoreOnDisk(wsRoot, ACCOUNTS));
  const credsAfter = refsOf(readStoreOnDisk(wsRoot, CREDENTIALS));
  const markerAfter = readMarkerState(wsRoot);

  return {
    label,
    error,
    blocked: error !== null,
    addedAccounts: accountsAfter.filter((r) => !accountsBefore.includes(r)),
    addedCreds: credsAfter.filter((r) => !credsBefore.includes(r)),
    markerAction: classifyMarkerAction(markerBefore, markerAfter),
    markerMode: markerAfter.mode ?? null,
  };
}

function printInputs({ workspaceReal, runtimeReal, wsAccounts, wsCreds, wsMarker, rtAccounts, rtCreds }) {
  console.log('=== inputs (real stores, read-only) ===');
  console.log(`workspace : ${workspaceReal}`);
  console.log(`  accounts    ${refsOf(wsAccounts).length} ref(s): ${refsOf(wsAccounts).join(', ') || '-'}`);
  console.log(`  credentials ${refsOf(wsCreds).length} ref(s): ${refsOf(wsCreds).join(', ') || '-'}`);
  console.log(`  marker      ${wsMarker.state === 'ok' ? 'present' : 'ABSENT → full preflight on next start'}`);
  console.log(`runtime   : ${runtimeReal}`);
  console.log(`  accounts    ${refsOf(rtAccounts).length} ref(s): ${refsOf(rtAccounts).join(', ') || '-'}`);
  console.log(`  credentials ${refsOf(rtCreds).length} ref(s): ${refsOf(rtCreds).join(', ') || '-'}`);
  // The homedir migrations run BEFORE the runtime→workspace one, so anything
  // here can reach the workspace store on the next start. Named, never valued.
  console.log(`home      : ${REAL_HOME}`);
  for (const file of HOME_SOURCE_FILES) {
    const store = readStoreOnDisk(REAL_HOME, file);
    if (store.state === 'absent') continue;
    // accounts/credentials are flat ref maps; the provider-profiles pair is a
    // nested legacy shape, so only its presence is reported.
    const detail =
      store.state !== 'ok'
        ? `INVALID (${store.reason})`
        : file === ACCOUNTS || file === CREDENTIALS
          ? `${refsOf(store).length} ref(s): ${refsOf(store).join(', ') || '-'}`
          : 'present (legacy shape)';
    console.log(`  ${file.padEnd(38)} ${detail}`);
  }
}

/**
 * Section D: feed sources we KNOW are non-equivalent. Each must BLOCK, or the
 * instrument is blind and every OK above is meaningless.
 */
async function runNegativeControl({ runCase, sharedAccountRefs, sharedCredRefs, rtAccounts }) {
  console.log('\n=== D. negative control (instrument sensitivity — must BLOCK) ===');
  const probes = [];
  const findings = [];
  if (sharedAccountRefs.length > 0) {
    const ref = sharedAccountRefs[0];
    const base = rtAccounts.value[ref];
    // Distinctive probe value: a short one would match by chance inside the
    // random sandbox path and report a phantom leak.
    const PROBE_VALUE = '__dryrun_probe_value_do_not_print__';
    const r1 = await runCase(`account "${ref}" with a changed displayName`, {
      [ACCOUNTS]: { [ref]: { ...base, displayName: `${base.displayName ?? ''}__dryrun_probe` } },
      [CREDENTIALS]: {},
    });
    console.log(verdictLine(r1));
    probes.push({ label: r1.label, blocked: r1.blocked });

    const r2 = await runCase(`account "${ref}" with an extra envVars key`, {
      [ACCOUNTS]: { [ref]: { ...base, envVars: { ...(base.envVars ?? {}), DRYRUN_PROBE: PROBE_VALUE } } },
      [CREDENTIALS]: {},
    });
    console.log(verdictLine(r2));
    probes.push({ label: r2.label, blocked: r2.blocked });
    // Coarse smoke check on R3 P1-2 (envVars: key names only, never values).
    const leaked = r2.error?.message.includes(PROBE_VALUE) ?? false;
    console.log(
      leaked
        ? '         ❌ probe VALUE leaked into the conflict text'
        : '         ✅ envVars probe value absent from conflict text (key name only)',
    );
    if (leaked) findings.push({ kind: 'leak', message: 'envVars conflict text printed a credential-adjacent value' });
  }
  if (sharedCredRefs.length > 0) {
    const ref = sharedCredRefs[0];
    const r3 = await runCase(`credential "${ref}" with different content`, {
      [ACCOUNTS]: {},
      [CREDENTIALS]: { [ref]: { __dryrun_probe: true } },
    });
    console.log(verdictLine(r3));
    probes.push({ label: r3.label, blocked: r3.blocked });
  }
  findings.push(...evaluateNegativeControl(probes));
  return findings;
}

/**
 * Section B: one ref at a time, because the full run stops at its FIRST
 * conflict and the operator needs the complete list. Rewriting the source
 * changes its fingerprint, which can invalidate a VALID completion marker, so
 * these conflicts describe a hypothetical, not the next real start (R6 P2-7).
 */
async function runPerRefDiagnostics({ runCase, sharedAccountRefs, sharedCredRefs, rtAccounts, rtCreds }) {
  console.log('\n=== B. per-ref diagnosis (DIAGNOSTIC ONLY — does not affect the exit code) ===');
  console.log('     (each case rewrites the runtime source, so a valid marker no longer matches)');
  for (const ref of sharedAccountRefs) {
    const r = await runCase(`account "${ref}" alone`, {
      [ACCOUNTS]: { [ref]: rtAccounts.value[ref] },
      [CREDENTIALS]: {},
    });
    console.log(verdictLine(r));
  }
  for (const ref of sharedCredRefs) {
    const r = await runCase(`credential "${ref}" alone`, {
      [ACCOUNTS]: {},
      [CREDENTIALS]: { [ref]: rtCreds.value[ref] },
    });
    console.log(verdictLine(r));
  }
}

/** Section A is the only section that answers "what does the next real start do?". */
function classifyFullRehearsal(r) {
  console.log(verdictLine(r));
  console.log(`         marker: ${MARKER_ACTION_NOTE[r.markerAction]}`);
  if (r.blocked) return [{ kind: 'conflict', message: `${r.label}: ${r.error.message}` }];
  if (mergedCount(r) > 0) {
    const parts = [
      r.addedAccounts.length ? `accounts=[${r.addedAccounts.join(', ')}]` : '',
      r.addedCreds.length ? `credentials=[${r.addedCreds.join(', ')}]` : '',
    ].filter(Boolean);
    return [
      {
        kind: 'migrate',
        message: `the next start would WRITE ${mergedCount(r)} entry(ies) into the workspace store: ${parts.join(' ')} — back up the store and restart with a human watching`,
      },
    ];
  }
  return [];
}

function printVerdict(findings, code, markerAction) {
  console.log('\n=== verdict ===');
  // The marker action is stated on every path: it is the one write that exit 0
  // still permits, so the operator must never have to infer it (R6 P2-8).
  const markerLine = markerAction ? `   marker: the next start ${MARKER_ACTION_NOTE[markerAction]}` : null;
  if (findings.length === 0) {
    console.log(
      '✅ exit 0 — the next start changes NOTHING in accounts.json / credentials.json.',
      '\n   Inputs validated, negative control sensitive, real files untouched.',
    );
    if (markerLine) console.log(markerLine);
    console.log('   Still back up the workspace store and re-run this immediately before the restart.');
    return;
  }
  for (const f of findings) console.log(`❌ [${f.kind}] ${f.message}`);
  if (markerLine) console.log(markerLine);
  if (code === EXIT_WOULD_MIGRATE) {
    console.log(
      '\n⚠️  exit 3 — the migration would SUCCEED but writes account/credential entries. Confirm by hand before restarting.',
    );
  } else if (code === EXIT_WOULD_BLOCK) {
    console.log('\n❌ exit 1 — the migration would BLOCK on the next start. Resolve the conflict before restarting.');
  } else {
    console.log(
      '\n❌ exit 2 — this gate is not trustworthy for a restart decision. Fix the reported problem and re-run.',
    );
  }
}

function reportInputFindings(findings) {
  console.log('=== input validation ===');
  for (const f of findings) console.log(`❌ ${f.message}`);
  console.log('\nVERDICT: inputs unusable — no rehearsal run.');
  return decideExitCode(findings);
}

async function rehearseAll({ workspaceReal, runtimeReal, findings }) {
  // Load the migration module BEFORE any sandbox env is pointed at it. Its write
  // guard snapshots the ambient store roots at module load (P1-5); importing it
  // lazily inside a rehearsal would snapshot the SANDBOX roots and then refuse
  // the sandbox's own writes. Loading it here snapshots the operator's real
  // roots instead — which also means a bug that tried to write the live store
  // through this script would now be refused outright.
  const mod = await import('../dist/config/catalog-accounts.js');
  const sandboxBase = mkdtempSync(resolve(tmpdir(), 'cat-cafe-migration-dryrun-'));
  const before = {
    ...snapshotStores([workspaceReal, runtimeReal]),
    ...snapshotStores([REAL_HOME], HOME_SOURCE_FILES),
  };
  let caseIndex = 0;
  let markerAction = null;
  const runCase = (label, overrideRuntime) => {
    caseIndex += 1;
    return rehearse({
      label,
      caseRoot: resolve(sandboxBase, `case-${caseIndex}`),
      workspaceReal,
      runtimeReal,
      overrideRuntime,
      mod,
    });
  };

  try {
    const rtAccounts = readStoreOnDisk(runtimeReal, ACCOUNTS);
    const rtCreds = readStoreOnDisk(runtimeReal, CREDENTIALS);
    const wsAccounts = readStoreOnDisk(workspaceReal, ACCOUNTS);
    const wsCreds = readStoreOnDisk(workspaceReal, CREDENTIALS);
    const wsMarker = readStoreOnDisk(workspaceReal, MARKER);
    printInputs({ workspaceReal, runtimeReal, wsAccounts, wsCreds, wsMarker, rtAccounts, rtCreds });

    const sharedAccountRefs = refsOf(rtAccounts).filter((r) => refsOf(wsAccounts).includes(r));
    const sharedCredRefs = refsOf(rtCreds).filter((r) => refsOf(wsCreds).includes(r));
    console.log(`shared account ref(s): ${sharedAccountRefs.join(', ') || '-'}`);
    console.log(`shared credential ref(s): ${sharedCredRefs.join(', ') || '-'}`);

    console.log('\n=== A. full rehearsal (exactly what the next real start does) ===');
    const full = await runCase('full migration');
    markerAction = full.markerAction;
    findings.push(...classifyFullRehearsal(full));

    const shared = { runCase, sharedAccountRefs, sharedCredRefs, rtAccounts, rtCreds };
    if (sharedAccountRefs.length + sharedCredRefs.length > 0) {
      await runPerRefDiagnostics(shared);
      findings.push(...(await runNegativeControl(shared)));
    } else {
      findings.push({
        kind: 'negative-control',
        message:
          'no shared ref between the two stores — the negative control could not run, so the OK verdicts above are unproven',
      });
    }

    console.log('\n=== C. proof the real stores were not written ===');
    const after = {
      ...snapshotStores([workspaceReal, runtimeReal]),
      ...snapshotStores([REAL_HOME], HOME_SOURCE_FILES),
    };
    for (const [path, sig] of Object.entries(before)) {
      const same = after[path] === sig;
      if (!same) findings.push({ kind: 'integrity', message: `real file changed during the rehearsal: ${path}` });
      const label = `${basename(resolve(path, '..', '..'))}/${CONFIG_SUBDIR}/${basename(path)}`;
      console.log(`${same ? 'unchanged' : 'CHANGED  '} ${label}  ${sig}`);
    }
  } finally {
    rmSync(sandboxBase, { recursive: true, force: true });
  }
  return markerAction;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.workspace && !process.env.CAT_CAFE_WORKSPACE_ROOT) {
    console.error('missing --workspace (or CAT_CAFE_WORKSPACE_ROOT)');
    return EXIT_UNTRUSTWORTHY;
  }
  if (!args.runtime && !process.env.CAT_CAFE_RUNTIME_ROOT) {
    console.error('missing --runtime (or CAT_CAFE_RUNTIME_ROOT)');
    return EXIT_UNTRUSTWORTHY;
  }
  const workspaceReal = resolve(args.workspace || process.env.CAT_CAFE_WORKSPACE_ROOT);
  const runtimeReal = resolve(args.runtime || process.env.CAT_CAFE_RUNTIME_ROOT);

  // Roots first — including for the same-root short-circuit (R6 P2-5).
  const rootFindings = validateRoots({
    workspaceRoot: workspaceReal,
    runtimeRoot: runtimeReal,
    statDir: statDirOnDisk,
  });
  if (rootFindings.length > 0) return reportInputFindings(rootFindings);

  if (workspaceReal === runtimeReal) {
    // Production returns before the marker write in this branch, so this is the
    // one exit 0 that really does mean "not a single file is written".
    console.log(`workspace root === runtime root (${workspaceReal}) — migration short-circuits, nothing to rehearse.`);
    console.log('No store entry and no completion marker would be written.');
    return EXIT_OK;
  }

  const storeFindings = validateStores({
    workspaceRoot: workspaceReal,
    runtimeRoot: runtimeReal,
    readStore: readStoreOnDisk,
  });
  if (storeFindings.length > 0) return reportInputFindings(storeFindings);

  const findings = [];
  const markerAction = await rehearseAll({ workspaceReal, runtimeReal, findings });
  const code = decideExitCode(findings);
  printVerdict(findings, code, markerAction);
  return code;
}

// Importable for unit tests; only runs the rehearsal when executed directly.
const isDirectRun = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  process.exitCode = await main(process.argv.slice(2));
}
