import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  constrainedGhApiOperation,
  constrainedGhHelpOperation,
  constrainedGhPullRequestOperation,
} from './native-effect-github-classifier.mjs';
import { decideShellHookPayload } from './native-effect-shell-decision.mjs';

const GH_WRAPPER = '/Users/yuhan/cat-cafe/cat-cafe-runtime/scripts/guarded-bin/gh';
const GH_WRAPPER_SHA256 = '5ec246d687ffc330d274f356b40ab6738d7e02e073e645b2c364c2f1b7ad6bb8';
const pinnedWrapperPresent = () => {
  try {
    return (
      existsSync(GH_WRAPPER) &&
      createHash('sha256').update(readFileSync(GH_WRAPPER)).digest('hex') === GH_WRAPPER_SHA256
    );
  } catch {
    return false;
  }
};

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

test('graphql shape contract: typed file channels, methods, and missing queries stay unrecognized', () => {
  const shapes = [
    "gh api graphql -f query='{ x }' --method DELETE",
    'gh api graphql',
    "gh api graphql -H 'X: y' -f query='{ x }'",
  ];
  for (const shape of shapes) {
    assert.equal(constrainedGhApiOperation(shape), null, shape);
  }
  // gh's -f/--raw-field has no @file magic: a leading @ stays literal data and
  // classifies by its (unprovable, therefore mutation) document.
  assert.equal(constrainedGhApiOperation('gh api graphql -f query=@prepared-query.graphql')?.effect, 'remote_mutation');
});

test('real substitution never classifies; quoted $() is literal data', () => {
  assert.equal(constrainedGhApiOperation('gh api graphql -f query="$(cat /etc/hosts)"'), null);
  assert.equal(constrainedGhApiOperation("gh api graphql -f query='{ id } $(echo x)'")?.effect, 'read');
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

test('a # inside a GraphQL string never hides a mutation (no regex comment deletion)', () => {
  const multiOperation =
    "gh api graphql -f operationName=Publish -f query='query Unused { repository(owner:\"#\",name:\"unused\") { id } } mutation Publish { createDiscussion(input:{repositoryId:\"R_1\"}) { discussion { id } } }'";
  assert.equal(constrainedGhApiOperation(multiOperation)?.effect, 'remote_mutation');
  const mutationInBody =
    "gh api graphql -f query='query { search(query:\"mutation tips\",type:DISCUSSION) { nodes { __typename } } }'";
  assert.equal(constrainedGhApiOperation(mutationInBody)?.effect, 'remote_mutation');
});

test('static GraphQL variables and Markdown backticks in quoted literals classify', () => {
  const withVariables =
    "gh api graphql -f query='query($owner:String!) { repository(owner:$owner) { id } }' -f owner=deepseek-ai";
  assert.deepEqual(constrainedGhApiOperation(withVariables), { effect: 'read', target: 'github://api/graphql' });
  const publishShape =
    "gh api graphql -f query='mutation Publish($repository: ID!, $category: ID!) { createDiscussion(input:{repositoryId:$repository,categoryId:$category}) { discussion { id } } }' -f repository=R_1 -f category=DIC_1 -f body='see `ctx.subagents.runMaintenance` in the docs'";
  assert.deepEqual(constrainedGhApiOperation(publishShape), {
    effect: 'remote_mutation',
    target: 'github://api/graphql',
  });
  const rawFieldLongForm = "gh api graphql --raw-field query='{ viewer { login } }'";
  assert.deepEqual(constrainedGhApiOperation(rawFieldLongForm), { effect: 'read', target: 'github://api/graphql' });
});

test('typed -F/--field keeps its @file channel closed; raw -f does not gain one', () => {
  assert.equal(constrainedGhApiOperation('gh api graphql -F query=@prepared.graphql'), null);
  assert.equal(constrainedGhApiOperation("gh api graphql --field body=@discussion.md -f query='{ x }'"), null);
});

test('pr create accepts literal $ and Markdown inside quoted titles and bodies', () => {
  assert.equal(
    constrainedGhPullRequestOperation("gh pr create --repo a/b --title 'costs $5' --body 'see `ctx` docs'")?.effect,
    'remote_mutation',
  );
});

test('the pinned wrapper entry: verified absolute-path query and mutation both classify', { skip: !pinnedWrapperPresent() }, (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'gh-wrapper-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const query = `${GH_WRAPPER} api graphql -f query='{ viewer { login } }'`;
  const mutation = `${GH_WRAPPER} api graphql -f query='mutation { createDiscussion(input:{repositoryId:"R_1"}) { discussion { id } } }'`;
  const readDecision = decideShellHookPayload({ judged: query }, cwd, source);
  assert.equal(readDecision.decision, 'allow');
  assert.equal(readDecision.effect, 'read');
  assert.deepEqual(readDecision.target, { kind: 'remote_repository', value: 'github://api/graphql' });
  const mutationDecision = decideShellHookPayload({ judged: mutation }, cwd, source);
  assert.equal(mutationDecision.decision, 'allow');
  assert.equal(mutationDecision.effect, 'remote_mutation');
  assert.deepEqual(mutationDecision.target, { kind: 'remote_repository', value: 'github://api/graphql' });
});

test('unquoted brace and glob expansion never rewrites the classified PR argv', () => {
  const runtime = '/Users/yuhan/cat-cafe/cat-cafe-runtime';
  assert.equal(constrainedGhPullRequestOperation(`gh pr create --body {safe,--body-file=${runtime}/body.md}`), null);
  assert.equal(constrainedGhPullRequestOperation(`gh pr create --template ${runtime}/*`), null);
  assert.equal(constrainedGhPullRequestOperation(`gh pr create --body ${runtime}/*`), null);
  // Quoted braces/globs are literal data and stay legal.
  assert.equal(
    constrainedGhPullRequestOperation("gh pr create --repo a/b --body '{safe,not-a-flag}' --title 'v1.*'")?.effect,
    'remote_mutation',
  );
});

test('pr create --body-file: the standard file-backed body path classifies by the target model', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'gh-bodyfile-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const ordinary = join(cwd, 'PR_BODY.md');
  writeFileSync(ordinary, '# change\n\nmulti-line body\n');
  const protectedText = join(cwd, 'cat-cafe-runtime', 'private.md');
  const ordinarySymlink = join(cwd, 'link.md');
  symlinkSync(ordinary, ordinarySymlink);
  const runtimeSymlink = join(cwd, 'runtime-link.md');
  symlinkSync('/Users/yuhan/cat-cafe/cat-cafe-runtime/scripts', runtimeSymlink);

  assert.deepEqual(
    constrainedGhPullRequestOperation(
      `gh pr create --repo 08mamba24/clowder-ai --base main --head fix/x --title repair --body-file ${ordinary}`,
    ),
    { effect: 'remote_mutation', target: 'github://08mamba24/clowder-ai/pulls' },
  );
  assert.equal(
    constrainedGhPullRequestOperation(
      `gh pr create --repo a/b --title t --body-file /Users/yuhan/cat-cafe/cat-cafe-runtime/x.md`,
    ),
    null,
  );
  assert.equal(constrainedGhPullRequestOperation(`gh pr create --repo a/b --title t --body-file ${protectedText}`), null);
  assert.equal(constrainedGhPullRequestOperation(`gh pr create --repo a/b --title t --body-file ${runtimeSymlink}/gh`), null);
  assert.equal(
    constrainedGhPullRequestOperation(`gh pr create --repo a/b --title t --body-file ${runtimeSymlink}/guarded-bin/gh`),
    null,
  );
  assert.equal(constrainedGhPullRequestOperation('gh pr create --repo a/b --title t --body-file -'), null);
  assert.equal(constrainedGhPullRequestOperation('gh pr create --repo a/b --title t --body-file PR_BODY.md'), null);
  assert.equal(
    constrainedGhPullRequestOperation(`gh pr create --repo a/b --title t --body-file ${ordinarySymlink}`)?.effect,
    'remote_mutation',
  );
});

test('decision level: the pinned wrapper publishes via an ordinary body file and still refuses protected inputs', { skip: !pinnedWrapperPresent() }, (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'gh-bodyfile-decision-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const ordinary = join(cwd, 'PR_BODY.md');
  writeFileSync(ordinary, '# change\n');
  const protectedFile = join(cwd, 'cat-cafe-runtime', 'private.md');
  const shape = (file) =>
    `${GH_WRAPPER} pr create --repo 08mamba24/clowder-ai --base main --head fix/x --title repair --body-file '${file}'`;
  const allowed = decideShellHookPayload({ judged: shape(ordinary) }, cwd, source);
  assert.equal(allowed.decision, 'allow');
  assert.equal(allowed.effect, 'remote_mutation');
  assert.deepEqual(allowed.target, { kind: 'remote_repository', value: 'github://08mamba24/clowder-ai/pulls' });
  const refused = decideShellHookPayload({ judged: shape(protectedFile) }, cwd, source);
  assert.equal(refused.decision, 'deny');
  assert.equal(refused.reasonCode, 'protected_target_unparsed');
});

test('body-file alias, dangling symlink, and stream inputs share the file-input proof boundary', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'gh-bodyfile-r5-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const ordinary = join(cwd, 'PR_BODY.md');
  writeFileSync(ordinary, '# body\n');
  const protectedText = join(cwd, 'cat-cafe-runtime', 'private-fixture.md');
  const dangling = join(cwd, 'dangling.md');
  symlinkSync(join(cwd, 'cat-cafe-runtime', 'not-created.md'), dangling);

  // One semantic role: -F and --body-file normalize together, so aliasing can
  // neither bypass the file validation nor dodge the duplicate detection.
  assert.equal(constrainedGhPullRequestOperation(`gh pr create --repo a/b --title t -F ${protectedText}`), null);
  assert.equal(constrainedGhPullRequestOperation('gh pr create --repo a/b --title t -F -'), null);
  assert.equal(
    constrainedGhPullRequestOperation(`gh pr create --repo a/b --title t --body-file ${ordinary} -F ${protectedText}`),
    null,
  );
  assert.equal(
    constrainedGhPullRequestOperation(`gh pr create --repo a/b --title t -F ${ordinary}`)?.effect,
    'remote_mutation',
  );
  // An unresolvable input (dangling symlink) proves nothing.
  assert.equal(constrainedGhPullRequestOperation(`gh pr create --repo a/b --title t --body-file ${dangling}`), null);
  // Devices, descriptors, and streams are not ordinary body files — by file
  // type, not by name.
  assert.equal(constrainedGhPullRequestOperation('gh pr create --repo a/b --title t --body-file /dev/stdin'), null);
  assert.equal(constrainedGhPullRequestOperation('gh pr create --repo a/b --title t --body-file /dev/null'), null);
});

test('decision level: the pinned wrapper refuses aliased, dangling, and stream body inputs', { skip: !pinnedWrapperPresent() }, (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'gh-bodyfile-r5-decision-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const protectedText = join(cwd, 'cat-cafe-runtime', 'private-fixture.md');
  const dangling = join(cwd, 'dangling.md');
  symlinkSync(join(cwd, 'cat-cafe-runtime', 'not-created.md'), dangling);
  for (const file of [protectedText, dangling, '/dev/stdin']) {
    const refused = decideShellHookPayload(
      { judged: `${GH_WRAPPER} pr create --repo 08mamba24/clowder-ai --base main --head fix/x --title repair --body-file '${file}'` },
      cwd,
      source,
    );
    assert.equal(refused.decision, 'deny', file);
    assert.notEqual(refused.target?.kind, 'remote_repository', file);
  }
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

  const sanctuaryDelete = decision('rm -rf /Users/yuhan/cat-cafe/cat-cafe-runtime/scripts/x', cwd);
  assert.equal(sanctuaryDelete.decision, 'deny');
  assert.equal(sanctuaryDelete.reasonCode, 'runtime_sanctuary_mutation');

  const sanctuaryWrite = decision('echo hi > /Users/yuhan/cat-cafe/cat-cafe-runtime/x', cwd);
  assert.equal(sanctuaryWrite.decision, 'deny');
  assert.equal(sanctuaryWrite.reasonCode, 'runtime_sanctuary_mutation');

  // An absolute path that is NOT the pinned wrapper stays a runtime coordinate:
  // executing the verified wrapper (proven by content) differs from running an
  // unproved executable that happens to live under the runtime tree.
  const unprovedPath = decision('/Users/yuhan/cat-cafe/cat-cafe-runtime/scripts/gh-unverified api graphql -f query=q', cwd);
  assert.equal(unprovedPath.decision, 'deny');
  assert.equal(unprovedPath.reasonCode, 'protected_target_unparsed');

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
