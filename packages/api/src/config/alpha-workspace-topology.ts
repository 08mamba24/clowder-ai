import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export interface AlphaWorkspaceTopologyProbe {
  readonly deploymentId: string | undefined;
  readonly workspaceRoot: string | undefined;
  /** Injectable for tests; must return '' for any failing git invocation. */
  readonly runGit?: (args: readonly string[], cwd: string) => string;
}

export interface AlphaWorkspaceTopologyWarning {
  readonly workspaceRoot: string;
  readonly message: string;
}

const REPO_LOCATING_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG'] as const;

function withoutRepoLocatingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of REPO_LOCATING_ENV) delete next[key];
  return next;
}

function defaultRunGit(args: readonly string[], cwd: string): string {
  try {
    // The probe subprocess scrubs inherited repository-locating variables so
    // checkout identity is read from the physical path only; the calling
    // environment and git configuration stay untouched.
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      env: withoutRepoLocatingEnv(process.env),
    }).trim();
  } catch {
    return '';
  }
}

function warningFor(workspaceRoot: string, detail: string): AlphaWorkspaceTopologyWarning {
  return {
    workspaceRoot,
    message:
      `[alpha-workspace] CAT_CAFE_WORKSPACE_ROOT=${workspaceRoot} is not the primary checkout on branch main ` +
      `(${detail}); ` +
      'the account store resolves under the workspace root, so bound accounts will not be found. ' +
      'Start the managed Alpha from the primary checkout via alpha-worktree.sh.',
  };
}

/**
 * Alpha deployments must run with CAT_CAFE_WORKSPACE_ROOT on the repository's
 * primary checkout (branch main): the account store resolves its primary root
 * against the workspace root, so any other root silently hides every bound
 * account and surfaces much later as queue-level "bound account not found".
 * Returns null when there is nothing to report.
 */
export function alphaWorkspaceTopologyWarning(
  probe: AlphaWorkspaceTopologyProbe,
): AlphaWorkspaceTopologyWarning | null {
  const { deploymentId, workspaceRoot } = probe;
  if (deploymentId !== 'alpha' || !workspaceRoot?.trim()) return null;
  const runGit = probe.runGit ?? defaultRunGit;
  const root = workspaceRoot.trim();
  let physicalRoot = '';
  try {
    physicalRoot = realpathSync(root);
  } catch {
    physicalRoot = '';
  }
  if (!physicalRoot) {
    return warningFor(root, 'workspace root unresolvable');
  }
  const toplevel = runGit(['rev-parse', '--show-toplevel'], physicalRoot);
  if (!toplevel) {
    return warningFor(root, 'git workspace unresolvable');
  }
  // Being inside the main repository is not enough: the workspace root must
  // BE the checkout root, otherwise the account store binds onto a
  // subdirectory of the real checkout.
  if (toplevel !== physicalRoot) {
    return warningFor(root, `workspace root is not the checkout root (toplevel=${toplevel})`);
  }
  const gitDir = runGit(['rev-parse', '--absolute-git-dir'], toplevel);
  const commonDir = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], toplevel);
  const branch = runGit(['branch', '--show-current'], toplevel);
  if (gitDir && gitDir === commonDir && branch === 'main') return null;
  return warningFor(
    root,
    `gitDir=${gitDir || 'unresolvable'}, commonDir=${commonDir || 'unresolvable'}, branch=${branch || 'none'}`,
  );
}
