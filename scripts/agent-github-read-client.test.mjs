import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGhReadCommand } from './lib/agent-github-read-client.mjs';

const repo = '08mamba24/clowder-ai';
test('translates only fixed standalone gh reads with an explicit unique repository', () => {
  for (const [command, expected] of [
    [`gh pr view 41 -R ${repo}`, { op: 'pr_view', repo, number: 41 }],
    [`gh --repo=${repo} pr diff 41`, { op: 'pr_diff', repo, number: 41 }],
    [`gh pr checks 41 --repo '${repo}'`, { op: 'pr_checks', repo, number: 41 }],
    [`gh pr list -R${repo} --state merged --limit 5`, { op: 'pr_list', repo, state: 'merged', limit: 5 }],
    [`gh issue list --repo ${repo}`, { op: 'issue_list', repo, state: 'open', limit: 20 }],
    [`gh issue view 5 --repo ${repo}`, { op: 'issue_view', repo, number: 5 }],
    [`gh run list --repo ${repo}`, { op: 'run_list', repo, limit: 20 }],
    [`gh run view 8 --repo ${repo}`, { op: 'run_view', repo, runId: 8 }],
    [`/runtime/scripts/guarded-bin/gh run view 8 --repo ${repo}`, { op: 'run_view', repo, runId: 8 }],
  ])
    assert.deepEqual(parseGhReadCommand(command, '/runtime/scripts/guarded-bin/gh'), expected);
});

test('rejects injection, writes, endpoints, unknown flags, ambiguous repo and hidden pagination', () => {
  for (const command of [
    `gh pr view 41`,
    `gh auth token`,
    `gh api /user`,
    `gh pr merge 41 -R ${repo}`,
    `gh run view 8 -R ${repo} --log`,
    `gh pr checks 41 -R ${repo} --watch`,
    `gh pr view 41 -R ${repo} --repo ${repo}`,
    `gh pr view https://github.com/${repo}/pull/41 -R ${repo}`,
    `gh pr view 41 -R ${repo} --hostname other`,
    `gh pr view 41 -R ${repo} --json title`,
    `gh pr list -R ${repo} --limit 51`,
    `gh run list -R ${repo} --state open`,
    `gh issue list -R ${repo} --state merged`,
    `gh pr view 0 -R ${repo}`,
    `gh pr view 1.1 -R ${repo}`,
    `gh pr view 41 -R '${repo};id'`,
    `gh pr view 41 -R ${repo}; id`,
    `gh pr view 41 -R ${repo} && id`,
    `gh pr view 41 -R ${repo} | cat`,
    'gh pr view $(id) -R ' + repo,
    `gh pr view 41 -R ${repo}\ncat /etc/passwd`,
    `gh pr view 41 -R ${repo} > /tmp/output`,
  ])
    assert.throws(() => parseGhReadCommand(command), /unsupported_query/, command);
});

test('leaves unrelated shell commands to the existing sandbox', () => {
  for (const command of ['pwd', 'git status', 'echo "gh pr list"', 'node -e "console.log(1)"'])
    assert.equal(parseGhReadCommand(command), null);
});
