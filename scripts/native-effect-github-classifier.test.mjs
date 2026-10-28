import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  constrainedGhApiOperation,
  constrainedGhHelpOperation,
  constrainedGhPullRequestOperation,
} from './native-effect-github-classifier.mjs';
import { decideShellHookPayload } from './native-effect-shell-decision.mjs';

// Provenance: F306 AC-C7 -- canonical gh remote operations must classify with an
// honest effect and a remote coordinate. Unrecognized shapes keep today's
// conservative local-target path (runtime sanctuary when the wrapper path or a
// runtime cwd is the evidence), and every protection below must survive the
// graphql/pr-create/help recognition added here.

const source = { provider: 'github-classifier-test', tool: 'shell' };
const decision = (command, cwd) => decideShellHookPayload({ judged: command }, cwd, source);

const GRAPHQL_QUERY =
  "gh api graphql -f query='query { repository(owner:\"deepseek-ai\",name:\"deepseek-harness\") { id discussionCategories(first:20) { nodes { id name slug } } } }'";
const GRAPHQL_MUTATION =
  "gh api graphql -f query='mutation { createDiscussion(input:{repositoryId:\"R_1\",categoryId:\"DIC_1\",body:\"b\"}) { discussion { id } } }' -f body='discussion body'";

test('canonical graphql query classifies as an honest remote read', () => {
  assert.deepEqual(constrainedGhApiOperation(GRAPHQL_QUERY), {
    effect: 'read',
    target: 'github://api/graphql',
  });
});

test('canonical graphql mutation classifies as a remote mutation', () => {
  assert.deepEqual(constrainedGhApiOperation(GRAPHQL_MUTATION), {
    effect: 'remote_mutation',
    target: 'github://api/graphql',
  });
});

test('graphql documents that cannot be proven read-only stay mutations, never reads', () => {
  const shapes = [
    "gh api graphql -f query='mutation { createDiscussion(input:{}) { discussion { id } } }'",
    "gh api graphql -f query='{ repository(owner:\"a\",name:\"b\") { id } } mutation { x }'",
    "gh api graphql -f query='subscription { x }'",
  ];
  for (const shape of shapes) {
    assert.equal(constrainedGhApiOperation(shape)?.effect, 'remote_mutation', shape);
  }
});

test('graphql shape contract: file channels, methods, and missing queries stay unrecognized', () => {
  const shapes = [
    "gh api graphql -f query=@prepared-query.graphql",
    "gh api graphql -f query='{ x }' -f body=@discussion-body.md",
    "gh api graphql -f query='{ x }' --method DELETE",
    'gh api graphql',
    "gh api graphql -H 'X: y' -f query='{ x }'",
  ];
  for (const shape of shapes) {
    assert.equal(constrainedGhApiOperation(shape), null, shape);
  }
});

test('generated graphql text never classifies', () => {
  const shapes = [
    'gh api graphql -f query="$(cat /etc/hosts)"',
    'gh api graphql -f query=\'{ id } $(echo x)\'',
  ];
  for (const shape of shapes) {
    assert.equal(constrainedGhApiOperation(shape), null, shape);
  }
});

test('canonical pr create classifies as a remote mutation on the repository', () => {
  assert.deepEqual(constrainedGhPullRequestOperation('gh pr create --repo a/b --title "t" --base main --head f'), {
    effect: 'remote_mutation',
    target: 'github://a/b/pulls',
  });
  assert.deepEqual(constrainedGhPullRequestOperation('gh pr create --draft --title t'), {
    effect: 'remote_mutation',
    target: 'github://current/pulls',
  });
});

test('pr create shape contract: file channels, browser handoff, and unknown flags stay unrecognized', () => {
  const shapes = [
    'gh pr create --repo a/b --body-file discussion-body.md',
    'gh pr create --repo a/b --web',
    'gh pr create --repo a/b --title t --unknown-flag x',
    'gh pr create --repo a/b --title "$(cat /etc/passwd)"',
    'gh pr create --repo a/b --title @title.txt',
  ];
  for (const shape of shapes) {
    assert.equal(constrainedGhPullRequestOperation(shape), null, shape);
  }
});

test('gh help classifies as a local read of the CLI surface', () => {
  assert.deepEqual(constrainedGhHelpOperation('gh help'), { effect: 'read', target: 'github://cli/help' });
  assert.deepEqual(constrainedGhHelpOperation('gh help api'), { effect: 'read', target: 'github://cli/help' });
  assert.equal(constrainedGhHelpOperation('gh help api --flag'), null);
  assert.equal(constrainedGhHelpOperation('gh help ../../etc'), null);
});

test('recognized REST and PR shapes keep their classification', () => {
  assert.deepEqual(constrainedGhApiOperation('gh api user --jq .login'), {
    effect: 'read',
    target: 'github://api/user',
  });
  assert.equal(constrainedGhApiOperation('gh api user -f key=value'), null);
  assert.deepEqual(constrainedGhPullRequestOperation('gh pr view 12 --repo a/b'), {
    effect: 'read',
    target: 'github://a/b/pull/12',
  });
  assert.deepEqual(constrainedGhPullRequestOperation('gh pr merge 5 --repo a/b --squash'), {
    effect: 'remote_mutation',
    target: 'github://a/b/pull/5',
  });
});

test('decision level: canonical gh remote operations get remote coordinates', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'gh-classifier-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const cases = [
    [GRAPHQL_QUERY, { decision: 'allow', reasonCode: 'read_only', effect: 'read', value: 'github://api/graphql' }],
    [GRAPHQL_MUTATION, { decision: 'allow', reasonCode: 'remote_repository_policy_deferred', effect: 'remote_mutation', value: 'github://api/graphql' }],
    ['gh pr create --repo a/b --title "t" --base main --head f', { decision: 'allow', reasonCode: 'remote_repository_policy_deferred', effect: 'remote_mutation', value: 'github://a/b/pulls' }],
    ['gh help api', { decision: 'allow', reasonCode: 'read_only', effect: 'read', value: 'github://cli/help' }],
  ];
  for (const [command, expected] of cases) {
    const result = decision(command, cwd);
    assert.equal(result.decision, expected.decision, command);
    assert.equal(result.reasonCode, expected.reasonCode, command);
    assert.equal(result.effect, expected.effect, command);
    assert.deepEqual(result.target, { kind: 'remote_repository', value: expected.value }, command);
  }
});

test('decision level: protections survive the new recognition', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'gh-classifier-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runtime = '/Users/yuhan/cat-cafe/cat-cafe-runtime/scripts/guarded-bin/gh api graphql -f query=q';

  const sanctuaryDelete = decision('rm -rf /Users/yuhan/cat-cafe/cat-cafe-runtime/scripts/x', cwd);
  assert.equal(sanctuaryDelete.decision, 'deny');
  assert.equal(sanctuaryDelete.reasonCode, 'runtime_sanctuary_mutation');

  const sanctuaryWrite = decision('echo hi > /Users/yuhan/cat-cafe/cat-cafe-runtime/x', cwd);
  assert.equal(sanctuaryWrite.decision, 'deny');
  assert.equal(sanctuaryWrite.reasonCode, 'runtime_sanctuary_mutation');

  // The wrapper's absolute path is a runtime coordinate: plain `gh` (PATH-selected
  // pinned wrapper) is the canonical entry this classifier recognizes.
  const wrapperPath = decision(runtime, cwd);
  assert.equal(wrapperPath.decision, 'deny');
  assert.equal(wrapperPath.reasonCode, 'protected_target_unparsed');

  // Substitution-generated graphql text never earns a remote read/mutation proof.
  const substituted = decision('gh api graphql -f query="$(cat /etc/hosts)"', cwd);
  assert.notEqual(substituted.effect, 'read');
  assert.notEqual(substituted.target?.kind, 'remote_repository');

  // Redirection keeps the operation out of remote classification entirely.
  const redirected = decision("gh api graphql -f query='{ x }' > /tmp/gh-out.txt", cwd);
  assert.notEqual(redirected.target?.kind, 'remote_repository');

  // Unrecognized pr-create flags keep today's conservative local path.
  const webCreate = decision('gh pr create --web --repo a/b', cwd);
  assert.notEqual(webCreate.target?.kind, 'remote_repository');

  const unknownProgram = decision('some-unknown-script.sh --flag', cwd);
  assert.equal(unknownProgram.decision, 'allow');
  assert.equal(unknownProgram.effect, 'unknown');
});
