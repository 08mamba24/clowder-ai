import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LAUNCHER = join(REPO_ROOT, 'scripts', 'start-dev.sh');
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

function stampAll(root, revision, { buildId = true } = {}) {
  for (const pkg of PACKAGES) {
    const dir = join(root, 'packages', pkg, pkg === 'web' ? '.next' : 'dist');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.build-commit'), `${revision}\n`);
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

test('the verified runtime artifacts path keeps its own precondition and stays exempt', (t) => {
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
  const result = runGate(root, { env: { CAT_CAFE_RUNTIME_ARTIFACTS_VERIFIED: '1' } });
  assert.match(result.stdout, /QUICK_MODE=true/);
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
