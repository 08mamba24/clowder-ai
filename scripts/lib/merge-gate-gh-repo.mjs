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
//
// CLI mode: `node scripts/lib/merge-gate-gh-repo.mjs` prints `owner/repo` for
// runbook shell snippets (`MERGE_GATE_REPO="$(node scripts/lib/merge-gate-gh-repo.mjs)"`),
// exit 1 + merge_gate_repo_unresolved on stderr when unresolved.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// owner/repo with optional `.git` suffix and optional trailing slash.
const OWNER_REPO_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

// Structured URL shapes ONLY, host exactly github.com (case-insensitive).
// A substring search for `github.com` would accept hostile remotes such as
// `https://evil.example/path/github.com/owner/repo.git` or
// `git@evil.example:github.com/owner/repo.git` and silently redirect
// merge-gate reads AND writes at an attacker-chosen repository.
const URL_SHAPES = [
  /^https?:\/\/github\.com(?::\d+)?\/(.+)$/i,
  /^ssh:\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/(.+)$/i,
  /^git@github\.com:(.+)$/i,
];

// Accepts https, ssh://, and scp-style GitHub remote URLs, with or without a
// `.git` suffix, and returns `owner/repo` — or null for anything whose host is
// not exactly github.com or whose path is not exactly owner/repo.
export function parseGitHubRepository(remoteUrl) {
  const url = String(remoteUrl ?? '').trim();
  const repoPath = URL_SHAPES.map((shape) => url.match(shape)?.[1]).find(Boolean);
  if (!repoPath) return null;
  const match = repoPath.match(OWNER_REPO_PATTERN);
  return match ? `${match[1]}/${match[2]}` : null;
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(resolveMergeGateRepository());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
