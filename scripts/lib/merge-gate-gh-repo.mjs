// Resolves the GitHub repository that merge-gate evidence gh calls must target.
//
// Why this exists: bare `gh pr ...` derives the repository from git remotes and
// prefers the `upstream` remote over `origin`. A clone tracking both
// zts212653/clowder-ai (upstream) and 08mamba24/clowder-ai (origin) therefore
// resolves every unpinned call against the WRONG repository — reads return
// some other repo's PR truth, and `gh pr edit --add-label hotfix` writes to
// some other repo's PR. Merge-gate evidence is about this clone's own PRs,
// which live on `origin`, so callers must pass `--repo <resolveMergeGateRepository()>`
// and REFUSE the gh call when resolution fails (fail closed).

import { execFileSync } from 'node:child_process';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Accepts https and ssh GitHub remote URLs, with or without a `.git` suffix,
// and returns `owner/repo` — or null for anything that is not exactly that
// shape (non-GitHub hosts, nested paths, empty input).
export function parseGitHubRepository(remoteUrl) {
  const match = String(remoteUrl ?? '')
    .trim()
    .match(/github\.com[/:](.+?)(?:\.git)?$/i);
  const repository = match?.[1]?.replace(/\/+$/, '');
  if (!repository || !REPOSITORY_PATTERN.test(repository)) return null;
  return repository;
}

export function resolveMergeGateRepository() {
  let remoteUrl;
  try {
    remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`merge_gate_repo_unresolved: cannot read git remote origin (${String(error.message).trim()})`);
  }
  const repository = parseGitHubRepository(remoteUrl);
  if (!repository) {
    throw new Error(`merge_gate_repo_unresolved: origin is not a GitHub repository: ${remoteUrl.trim()}`);
  }
  return repository;
}
