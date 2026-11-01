// Home provider integration: entries come from nativeHookPrograms(), so a public
// export drives the real shared CLI while a home/source checkout carrying the
// sync manifest also lists the private wrapper — a missing wrapper fails loudly
// and is never waived.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeHookPrograms, nativeHookTestEnv } from './helpers/native-hook-programs.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-home-provider-')));
const main = join(root, 'cat-cafe');
const runtime = join(root, 'cat-cafe-runtime');
const ordinary = join(root, 'ordinary');
const guardedBin = join(runtime, 'scripts', 'guarded-bin');
mkdirSync(main);
mkdirSync(ordinary);
mkdirSync(guardedBin, { recursive: true });
const input = join(ordinary, 'input');
writeFileSync(input, 'a\na\nb\n');
after(() => rmSync(root, { recursive: true, force: true }));

const payload = (command, cwd, tool_name) => ({
  tool_name,
  cwd,
  tool_input: { command, cmd: command },
});

function judge(command, cwd) {
  return nativeHookPrograms().map(([program, script, tool_name]) => {
    const result = spawnSync(program, [script], {
      env: nativeHookTestEnv(),
      input: JSON.stringify(payload(command, cwd, tool_name)),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  });
}

function expectAllow(command, cwd) {
  for (const stdout of judge(command, cwd)) assert.equal(stdout.trim(), '', command);
}

function expectDeny(command, cwd, reasonCode) {
  for (const stdout of judge(command, cwd)) {
    assert.ok(stdout.trim(), 'a denied hook must emit its refusal');
    const refusal = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(refusal.permissionDecision, 'deny', command);
    if (reasonCode) assert.ok(refusal.permissionDecisionReason.includes(reasonCode), refusal.permissionDecisionReason);
  }
}

test('real provider hook entries accept the comparison chain and reject a protected output', () => {
  const source = join(runtime, 'read-source');
  const destination = join(ordinary, 'read-target');
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(join(source, 'file.txt'), 'same\n');
  writeFileSync(join(destination, 'file.txt'), 'same\n');
  const command = `diff -qr ${source} ${destination} && find ${source} -type f && du -sk ${source} ${destination}`;
  expectAllow(command, main);
  expectDeny(`diff -qr ${source} ${destination} > ${runtime}/output`, main);
  const compared = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(compared.status, 0, compared.stderr);
  assert.ok(compared.stdout.includes(join(source, 'file.txt')));
  const counted = `diff -qr ${source} ${destination} && find ${source} -type f | wc -l && du -sk ${source} ${destination}`;
  expectAllow(counted, runtime);
  const countResult = spawnSync('/bin/sh', ['-c', counted], { encoding: 'utf8' });
  assert.equal(countResult.status, 0, countResult.stderr);
  assert.match(countResult.stdout, /^\s*1\s*$/m);
});

test('real hook entries refuse output syntax before an effect', () => {
  for (const command of [
    'git diff HEAD~1',
    'git cat-file -p HEAD~1',
    'find . -name *.ts',
    'find ~/projects -maxdepth 1',
  ]) {
    expectAllow(command, runtime);
  }
  for (const form of [
    (out) => `uniq ${input} ${out}`,
    (out) => `git -C ${ordinary} log --pretty --output=${out}`,
    (out) => `git -C ${ordinary} log --format --output=${out}`,
    ...['log', 'show'].flatMap((subcommand) =>
      ['-L', '--decorate-refs'].map((flag) => (out) => `git -C ${ordinary} ${subcommand} ${flag} -- --output=${out}`),
    ),
    (out) => `find ${ordinary} -fprintf ${out} '%p\n'`,
  ]) {
    expectDeny(form(join(runtime, 'sentinel')), runtime);
  }
});

test('real gh entry preserves inherited lookup and refuses inline selectors', () => {
  const gh = join(guardedBin, 'gh');
  const delegate = join(ordinary, 'gh');
  const evilBin = join(ordinary, 'evilbin');
  mkdirSync(evilBin);
  writeFileSync(join(evilBin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(gh, readFileSync(new URL('../../../scripts/guarded-bin/gh', import.meta.url)), { mode: 0o700 });
  writeFileSync(delegate, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const savedPath = process.env.PATH;
  const savedDelegate = process.env.CAT_CAFE_REAL_GH_PATH;
  process.env.PATH = `${guardedBin}:${dirname(process.execPath)}:${ordinary}:/usr/bin:/bin`;
  process.env.CAT_CAFE_REAL_GH_PATH = delegate;
  // Inline PATH/delegate selectors make the executed lookup unprovable; under the
  // runtime cwd the #4807 conservative line denies the unrecognised effect
  // (protected_target_unparsed) instead of deferring it.
  const inline = [
    `PATH=${evilBin}:${process.env.PATH} ${gh} pr view 5346`,
    `CAT_CAFE_REAL_GH_PATH=${delegate} ${gh} pr view 5346`,
    `env PATH=${evilBin}:${process.env.PATH} ${gh} pr view 5346`,
    `env CAT_CAFE_REAL_GH_PATH=${delegate} ${gh} pr view 5346`,
    `env PATH=${evilBin}:${process.env.PATH} CAT_CAFE_REAL_GH_PATH=${delegate} ${gh} pr view 5346`,
  ];
  try {
    expectAllow(`${gh} pr view 5346`, runtime);
    for (const command of inline) expectDeny(command, runtime, 'protected_target_unparsed');
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedDelegate === undefined) delete process.env.CAT_CAFE_REAL_GH_PATH;
    else process.env.CAT_CAFE_REAL_GH_PATH = savedDelegate;
  }
});

test('a home checkout with the sync manifest runs the shared CLI and never waives the missing wrapper', (t) => {
  const homeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'f306-home-wrapper-')));
  t.after(() => rmSync(homeRoot, { recursive: true, force: true }));
  writeFileSync(join(homeRoot, 'sync-manifest.yaml'), 'managed_files: []\n');
  // A synced home checkout carries real copies, not symlinks: the shared CLI's
  // main-module check compares import.meta.url against argv[1], so a symlinked
  // script path would silently skip the CLI instead of judging the payload.
  cpSync(fileURLToPath(new URL('../../../scripts', import.meta.url)), join(homeRoot, 'scripts'), { recursive: true });
  const entries = nativeHookPrograms(homeRoot);
  assert.equal(entries.length, 2);
  assert.equal(entries[1][2], 'Bash');
  const [program, script, tool_name] = entries[0];
  const blocked = spawnSync(program, [script], {
    env: nativeHookTestEnv(),
    input: JSON.stringify(payload(`diff -qr ${ordinary} ${ordinary} > ${runtime}/output`, main, tool_name)),
    encoding: 'utf8',
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const missing = spawnSync(entries[1][0], [entries[1][1]], { env: nativeHookTestEnv(), encoding: 'utf8' });
  assert.equal(missing.status, 127);
});
