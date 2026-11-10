import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LAUNCHER = process.env.PROD_WEB_TEST_LAUNCHER ?? join(REPO_ROOT, 'scripts', 'start-dev.sh');
const PACKAGES = ['shared', 'api', 'mcp-server', 'web'];

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'prod-web-freshness-')));
  writeFileSync(join(root, '.gitignore'), '**/dist/\n**/.next/\n*.tsbuildinfo\n*.log\n');
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(root, 'tsconfig.base.json'), '{}\n');
  for (const pkg of PACKAGES) {
    mkdirSync(join(root, 'packages', pkg, 'src'), { recursive: true });
    writeFileSync(join(root, 'packages', pkg, 'src', 'index.ts'), 'export const version = 1;\n');
  }
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial source');
  return root;
}

function stampAll(root, revision, { buildId = true, entries = true } = {}) {
  for (const pkg of PACKAGES) {
    const dir = join(root, 'packages', pkg, pkg === 'web' ? '.next' : 'dist');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.build-commit'), `${revision}\n`);
    if (entries && pkg !== 'web') writeFileSync(join(root, 'packages', pkg, 'dist', 'index.js'), 'built\n');
  }
  if (buildId) writeFileSync(join(root, 'packages', 'web', '.next', 'BUILD_ID'), 'fixture-build\n');
}

function runGate(root, { env = {} } = {}) {
  return spawnSync(
    'bash',
    [
      '-c',
      `
source "$LAUNCHER" --source-only >/dev/null 2>&1
trap - EXIT INT TERM
PROJECT_DIR="$FIXTURE_ROOT"
QUICK_MODE=true
PROD_WEB=true
enforce_prod_web_quick_freshness
printf 'QUICK_MODE=%s\\n' "$QUICK_MODE"
`,
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LAUNCHER,
        FIXTURE_ROOT: root,
        ...env,
      },
      timeout: 30_000,
    },
  );
}

test('quick reuse survives when all four stamps and BUILD_ID match the target', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const head = git(root, 'rev-parse', 'HEAD');
  stampAll(root, head);
  const result = runGate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /QUICK_MODE=true/);
});

test('a whole-set stale stamp set (HEAD moved) cancels quick', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = git(root, 'rev-parse', 'HEAD');
  stampAll(root, old);
  git(
    root,
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'docs-only move',
  );
  const result = runGate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /QUICK_MODE=false/);
  assert.match(result.stdout, /quick web reuse refused/);
});

test('stamps matching the target without a web BUILD_ID cancel quick', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const head = git(root, 'rev-parse', 'HEAD');
  stampAll(root, head, { buildId: false });
  const result = runGate(root);
  assert.match(result.stdout, /QUICK_MODE=false/);
});

test('a newer web stamp with a stale api stamp cancels quick', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = git(root, 'rev-parse', 'HEAD');
  stampAll(root, old);
  git(
    root,
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'move head',
  );
  const head = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'packages', 'web', '.next', '.build-commit'), `${head}\n`);
  const result = runGate(root);
  assert.match(result.stdout, /QUICK_MODE=false/);
});

test('an ambient CAT_CAFE_WEB_BUILD_REVISION never rescues stale stamps', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = git(root, 'rev-parse', 'HEAD');
  stampAll(root, old);
  git(
    root,
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'move head',
  );
  const result = runGate(root, { env: { CAT_CAFE_WEB_BUILD_REVISION: old } });
  assert.match(result.stdout, /QUICK_MODE=false/);
});

test('a dirty build input makes the target unprovable and cancels quick', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const head = git(root, 'rev-parse', 'HEAD');
  stampAll(root, head);
  writeFileSync(join(root, 'packages', 'api', 'src', 'index.ts'), 'export const version = 2;\n');
  const result = runGate(root);
  assert.match(result.stdout, /QUICK_MODE=false/);
  assert.match(result.stdout, /unprovable|refused/);
});

test('dev mode (PROD_WEB=false) keeps quick regardless of stamps', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = git(root, 'rev-parse', 'HEAD');
  stampAll(root, old);
  git(
    root,
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'move head',
  );
  const result = spawnSync(
    'bash',
    [
      '-c',
      `
source "$LAUNCHER" --source-only >/dev/null 2>&1
trap - EXIT INT TERM
PROJECT_DIR="$FIXTURE_ROOT"
QUICK_MODE=true
PROD_WEB=false
enforce_prod_web_quick_freshness
printf 'QUICK_MODE=%s\\n' "$QUICK_MODE"
`,
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LAUNCHER, FIXTURE_ROOT: root },
      timeout: 30_000,
    },
  );
  assert.match(result.stdout, /QUICK_MODE=true/);
});

function moveHead(root) {
  git(
    root,
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'move head',
  );
}

function staleFixture() {
  const root = fixture();
  const old = git(root, 'rev-parse', 'HEAD');
  stampAll(root, old);
  moveHead(root);
  return root;
}

test('only the full verified-runtime predicate earns the exemption (real owner)', (t) => {
  const root = staleFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runGate(root, {
    env: {
      CAT_CAFE_RUNTIME_ARTIFACTS_VERIFIED: '1',
      CAT_CAFE_DEPLOYMENT_ID: 'runtime',
      CAT_CAFE_RUNTIME_ROOT: root,
    },
  });
  assert.match(result.stdout, /QUICK_MODE=true/, result.stderr);
});

test('a bare verified flag without runtime deployment does not earn the exemption', (t) => {
  const root = staleFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runGate(root, { env: { CAT_CAFE_RUNTIME_ARTIFACTS_VERIFIED: '1' } });
  assert.match(result.stdout, /QUICK_MODE=false/);
});

test('an alpha deployment with the verified flag does not earn the exemption', (t) => {
  const root = staleFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runGate(root, {
    env: {
      CAT_CAFE_RUNTIME_ARTIFACTS_VERIFIED: '1',
      CAT_CAFE_DEPLOYMENT_ID: 'alpha',
      CAT_CAFE_RUNTIME_ROOT: root,
    },
  });
  assert.match(result.stdout, /QUICK_MODE=false/);
});

test('a verified runtime flag with a foreign runtime root does not earn the exemption', (t) => {
  const root = staleFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const foreign = mkdtempSync(join(tmpdir(), 'foreign-root-'));
  t.after(() => rmSync(foreign, { recursive: true, force: true }));
  const result = runGate(root, {
    env: {
      CAT_CAFE_RUNTIME_ARTIFACTS_VERIFIED: '1',
      CAT_CAFE_DEPLOYMENT_ID: 'runtime',
      CAT_CAFE_RUNTIME_ROOT: foreign,
    },
  });
  assert.match(result.stdout, /QUICK_MODE=false/);
});

test('a missing shared dist entry forces the full build despite fresh stamps', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const head = git(root, 'rev-parse', 'HEAD');
  stampAll(root, head);
  rmSync(join(root, 'packages', 'shared', 'dist', 'index.js'));
  const result = runGate(root);
  assert.match(result.stdout, /QUICK_MODE=false/);
});

test('a missing api dist entry forces the full build despite fresh stamps', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const head = git(root, 'rev-parse', 'HEAD');
  stampAll(root, head);
  rmSync(join(root, 'packages', 'api', 'dist', 'index.js'));
  const result = runGate(root);
  assert.match(result.stdout, /QUICK_MODE=false/);
});

test('a missing mcp-server dist entry forces the full build despite fresh stamps', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const head = git(root, 'rev-parse', 'HEAD');
  stampAll(root, head);
  rmSync(join(root, 'packages', 'mcp-server', 'dist', 'index.js'));
  const result = runGate(root);
  assert.match(result.stdout, /QUICK_MODE=false/);
});

test('build-identity target reads a clean repo and stays silent on dirty inputs or non-repos', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const head = git(root, 'rev-parse', 'HEAD');
  stampAll(root, head);
  const identity = join(REPO_ROOT, 'scripts', 'lib', 'build-identity.cjs');
  const read = (cwd) => execFileSync('node', [identity, 'target', cwd], { encoding: 'utf8' }).trim();
  assert.equal(read(root), head);
  // The side-effect-free read must not invalidate existing stamps.
  const stampPath = join(root, 'packages', 'shared', 'dist', '.build-commit');
  assert.equal(readFileSync(stampPath, 'utf-8').trim(), head);
  writeFileSync(join(root, 'packages', 'api', 'src', 'index.ts'), 'export const version = 2;\n');
  assert.equal(read(root), '');
  const nowhere = join(root, 'nowhere');
  assert.equal(read(nowhere), '');
  assert.equal(readFileSync(stampPath, 'utf-8').trim(), head);
});

function runMainSequence(root, { env = {}, cwd, launcher } = {}) {
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(root, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\ntrue\n', { mode: 0o755 });
  return spawnSync(
    'bash',
    [
      '-c',
      `
source "$LAUNCHER" --source-only >/dev/null 2>&1
trap - EXIT INT TERM
PROJECT_DIR="$FIXTURE_ROOT"
cd "$PROJECT_DIR" || exit 9
QUICK_MODE=true
PROD_WEB=true
ORDER_LOG="$FIXTURE_ROOT/order.log"
export ORDER_LOG
: > "$ORDER_LOG"
guard_main_branch_start() { :; }
guard_runtime_redis_sanctuary() { :; }
kill_managed_ports() { echo "CALL:kill_ports" >> "$ORDER_LOG"; }
ensure_api_native_addons() { :; }
setup_storage() { :; }
register_redis_dev_lease() { :; }
configure_mcp_server_path() { :; }
maybe_start_f247_cloud_services() { :; }
record_runtime_web_readiness() { :; }
print_config_summary() { :; }
print_manual_download_source_summary() { :; }
wait_for_frontend_readiness() { return 0; }
wait_for_api_readiness() { return 0; }
api_launch_command() { echo "CALL:api_launch" >> "$ORDER_LOG"; printf 'true'; }
api_uses_no_watch() { return 0; }
background_eval_with_null_stdin() { echo "CALL:launch" >> "$ORDER_LOG"; }
wait_for_port_or_exit() { echo "CALL:wait_port" >> "$ORDER_LOG"; return 0; }
frontend_launch_command() { printf 'true'; }
run_logged_step() {
  local pkg="\${4##*/}"
  echo "CALL:build:$pkg" >> "$ORDER_LOG"
  if [ "$pkg" = web ]; then
    printf 'built\\n' > "$PROJECT_DIR/packages/web/.next/BUILD_ID"
    printf '%s\\n' "\${CAT_CAFE_WEB_BUILD_REVISION:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" > "$PROJECT_DIR/packages/web/.next/.build-commit"
  else
    printf 'built\\n' > "$PROJECT_DIR/packages/$pkg/dist/index.js"
  fi
}
main
printf 'MAIN_EXIT=%s\\n' "$?"
`,
    ],
    {
      encoding: 'utf8',
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LAUNCHER: launcher ?? LAUNCHER,
        FIXTURE_ROOT: root,
        API_PORT: '3997',
        WEB_PORT: '3996',
        STARTUP_DISPLAY_NAME: 'fixture',
        PROFILE: '',
        REDIS_URL: '',
        MESSAGE_TTL_SECONDS: '0',
        THREAD_TTL_SECONDS: '0',
        TASK_TTL_SECONDS: '0',
        SUMMARY_TTL_SECONDS: '0',
        ANTHROPIC_PROXY_ENABLED: '0',
        ...env,
      },
      timeout: 60_000,
    },
  );
}

test('a stale quick start runs the gate, then the full build transaction, then the API launch', (t) => {
  const root = staleFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runMainSequence(root);
  assert.equal(result.status, 0, result.stderr);
  const order = readFileSync(join(root, 'order.log'), 'utf-8');
  const refusal = result.stdout.indexOf('quick web reuse refused');
  const firstBuild = order.indexOf('CALL:build:');
  const apiLaunch = order.indexOf('CALL:api_launch');
  assert.notEqual(refusal, -1, 'gate must refuse stale stamps inside main');
  assert.notEqual(firstBuild, -1, 'main must run the build transaction after the gate');
  assert.notEqual(apiLaunch, -1, 'main must reach the API launch');
  assert.ok(apiLaunch > firstBuild, 'API launch must come after the build');
  for (const pkg of ['shared', 'api', 'mcp-server', 'web']) {
    assert.match(order, new RegExp(`CALL:build:[^\n]*${pkg}`), `build must cover ${pkg}`);
  }
});

test('a fresh quick start skips the build and still launches the API', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const head = git(root, 'rev-parse', 'HEAD');
  stampAll(root, head);
  const result = runMainSequence(root);
  assert.equal(result.status, 0, result.stderr);
  const order = readFileSync(join(root, 'order.log'), 'utf-8');
  assert.match(result.stdout, /quick reuse accepted/);
  assert.doesNotMatch(order, /CALL:build:/, 'fresh reuse must not rebuild');
  assert.match(order, /CALL:api_launch/);
});

const LAUNCHER_FILES = [
  'packages/shared/src/deployment-defaults.ts',
  'packages/shared/src/deployment-profiles.json',
  'scripts/start-dev.sh',
  'scripts/lib/node-runtime-guard.sh',
  'scripts/lib/redis-rdb-first.sh',
  'scripts/lib/build-identity.cjs',
  'scripts/download-source-overrides.sh',
  'scripts/read-deployment-default.mjs',
];

test('main-sequence cleanup stays inside the fixture, never the launcher checkout', (t) => {
  const root = fixture();
  const launcherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'prod-web-launcher-')));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(launcherRoot, { recursive: true, force: true });
  });
  for (const entry of LAUNCHER_FILES) {
    mkdirSync(dirname(join(launcherRoot, entry)), { recursive: true });
    copyFileSync(join(REPO_ROOT, entry), join(launcherRoot, entry));
  }
  const head = git(root, 'rev-parse', 'HEAD');
  stampAll(root, head);
  // Distinct sentinels: the fixture lock must be cleaned by sanitize_lockfiles;
  // the launcher-side lock must never be touched.
  mkdirSync(join(root, 'packages', 'web'), { recursive: true });
  writeFileSync(join(root, 'packages', 'web', 'package-lock.json'), 'fixture-lock\n');
  mkdirSync(join(launcherRoot, 'packages', 'web'), { recursive: true });
  writeFileSync(join(launcherRoot, 'packages', 'web', 'package-lock.json'), 'launcher-lock\n');
  const result = runMainSequence(root, {
    cwd: launcherRoot,
    launcher: join(launcherRoot, 'scripts', 'start-dev.sh'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    existsSync(join(root, 'packages', 'web', 'package-lock.json')),
    false,
    'the fixture lock file must be cleaned inside the fixture',
  );
  assert.equal(
    readFileSync(join(launcherRoot, 'packages', 'web', 'package-lock.json'), 'utf-8'),
    'launcher-lock\n',
    'the launcher checkout must remain untouched',
  );
});
