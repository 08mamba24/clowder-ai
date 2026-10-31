import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..');

export const installScript = resolve(repoRoot, 'scripts', 'install.sh');

export {
  assert,
  basename,
  existsSync,
  join,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  spawnSync,
  symlinkSync,
  tmpdir,
  writeFileSync,
};

/** Installer snippets name their owned write targets; an omitted declaration grants no writes. */
export function runSourceOnlySnippet(snippet, { sandboxRoot } = {}) {
  const snippetHome = realpathSync(mkdtempSync(join(tmpdir(), 'install-snippet-home-')));
  const env = { ...process.env, HOME: snippetHome, USERPROFILE: snippetHome, CAT_CAFE_TEST_SANDBOX: '1' };
  for (const name of [
    'CAT_CAFE_TEST_SANDBOX_ROOT',
    'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT',
    'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    'CAT_CAFE_CONFIG_ROOT',
    'CAT_CAFE_RUNTIME_ROOT',
    'CAT_CAFE_WORKSPACE_ROOT',
  ])
    delete env[name];
  if (sandboxRoot) env.CAT_CAFE_TEST_SANDBOX_ROOT = sandboxRoot;

  try {
    const result = spawnSync(
      'bash',
      // Source-only skips project discovery; helpers still need the real installer source root.
      ['-c', `set -e\nsource "${installScript}" --source-only >/dev/null 2>&1\nPROJECT_DIR="${repoRoot}"\n${snippet}`],
      { cwd: repoRoot, encoding: 'utf8', env },
    );

    assert.equal(
      result.status,
      0,
      [`exit=${result.status}`, `stdout:\n${result.stdout}`, `stderr:\n${result.stderr}`].join('\n'),
    );

    return result.stdout.trim();
  } finally {
    rmSync(snippetHome, { recursive: true, force: true });
  }
}

export function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    [`git ${args.join(' ')}`, `exit=${result.status}`, `stdout:\n${result.stdout}`, `stderr:\n${result.stderr}`].join(
      '\n',
    ),
  );
  return result;
}

export function initGitRepo(repoRoot, readmeContent = 'seed\n') {
  writeFileSync(join(repoRoot, 'README.md'), readmeContent, 'utf8');
  runGit(['init', '-b', 'main'], repoRoot);
  runGit(['config', 'user.email', 'test@example.com'], repoRoot);
  runGit(['config', 'user.name', 'Test User'], repoRoot);
  runGit(['add', 'README.md'], repoRoot);
  runGit(['commit', '-m', 'init'], repoRoot);
}

export function addWorktree(repoRoot, worktreeRoot, branchName) {
  return runGit(['worktree', 'add', worktreeRoot, '-b', branchName], repoRoot);
}
