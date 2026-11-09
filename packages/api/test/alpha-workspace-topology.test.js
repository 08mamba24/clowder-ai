import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { alphaWorkspaceTopologyWarning } from '../dist/config/alpha-workspace-topology.js';

function makeRepo(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'alpha-topology-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'primary');
  const git = (args, cwd = root) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-b', 'main', root]);
  git(['config', 'user.name', 'Topology Fixture']);
  git(['config', 'user.email', 'topology@example.invalid']);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: root });
  return { directory, root, git };
}

test('alpha deployment on the primary main checkout stays silent', (t) => {
  const { root } = makeRepo(t);
  assert.equal(alphaWorkspaceTopologyWarning({ deploymentId: 'alpha', workspaceRoot: root }), null);
});

test('alpha deployment with a linked-worktree workspace root warns', (t) => {
  const { directory, root, git } = makeRepo(t);
  const linked = join(directory, 'linked');
  git(['worktree', 'add', '-b', 'feature', linked, 'main']);
  const warning = alphaWorkspaceTopologyWarning({ deploymentId: 'alpha', workspaceRoot: linked });
  assert.notEqual(warning, null);
  assert.match(warning.message, /primary checkout/);
  assert.match(warning.message, /account store/);
});

test('non-alpha deployments never warn regardless of the workspace root', (t) => {
  const { directory, root, git } = makeRepo(t);
  const linked = join(directory, 'linked2');
  git(['worktree', 'add', '-b', 'feature2', linked, 'main']);
  assert.equal(alphaWorkspaceTopologyWarning({ deploymentId: 'runtime', workspaceRoot: linked }), null);
  assert.equal(alphaWorkspaceTopologyWarning({ deploymentId: undefined, workspaceRoot: linked }), null);
});

test('missing workspace root or unusable git stays null or warns without crashing', (t) => {
  assert.equal(alphaWorkspaceTopologyWarning({ deploymentId: 'alpha', workspaceRoot: undefined }), null);
  assert.equal(alphaWorkspaceTopologyWarning({ deploymentId: 'alpha', workspaceRoot: '  ' }), null);
  const broken = alphaWorkspaceTopologyWarning({
    deploymentId: 'alpha',
    workspaceRoot: '/definitely/not/a/repo',
  });
  assert.notEqual(broken, null);
  assert.match(broken.message, /primary checkout/);
});
