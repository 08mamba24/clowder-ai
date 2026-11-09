import { execFileSync } from 'node:child_process';

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

function defaultRunGit(args: readonly string[], cwd: string): string {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch {
    return '';
  }
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
  const gitDir = runGit(['rev-parse', '--absolute-git-dir'], root);
  const commonDir = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  const branch = runGit(['branch', '--show-current'], root);
  if (gitDir && gitDir === commonDir && branch === 'main') return null;
  return {
    workspaceRoot: root,
    message:
      `[alpha-workspace] CAT_CAFE_WORKSPACE_ROOT=${root} is not the primary checkout on branch main ` +
      `(gitDir=${gitDir || 'unresolvable'}, commonDir=${commonDir || 'unresolvable'}, branch=${branch || 'none'}); ` +
      'the account store resolves under the workspace root, so bound accounts will not be found. ' +
      'Start the managed Alpha from the primary checkout via alpha-worktree.sh.',
  };
}
