import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { repoCommentPollTaskSpec } from '../../dist/infrastructure/connectors/github-repo-event/RepoCommentPollTaskSpec.js';
import { createRepoScanTaskSpec } from '../../dist/infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js';
import { createConflictCheckTaskSpec } from '../../dist/infrastructure/email/ConflictCheckTaskSpec.js';
import { executeTaskPipeline } from '../../dist/infrastructure/scheduler/execute-pipeline.js';

const log = { info() {}, warn() {}, error() {} };

async function runTick(spec) {
  spec.admission.timeoutMs = 1400;
  const records = [];
  await executeTaskPipeline({
    task: spec,
    ledger: { record: (row) => records.push(row) },
    logger: log,
    running: new Map(),
    tickCounts: new Map(),
    lastRunAt: new Map(),
  });
  assert.equal(
    records.some((row) => row.outcome === 'RUN_FAILED'),
    false,
  );
}

function oneSlowRead() {
  let slow = true;
  return async (signal) => {
    if (!slow) return;
    slow = false;
    await delay(5000, undefined, { signal });
    assert.fail('slow object must be cancelled before the whole admission deadline');
  };
}

test('a slow conflict read preserves earlier facts and remains reachable on retry', async () => {
  const store = new TaskStore();
  for (const number of [1, 2])
    store.create({
      kind: 'pr_tracking',
      threadId: `thread-${number}`,
      subjectKey: `pr:owner/repo#${number}`,
      title: 'tracked',
      ownerCatId: 'codex61-sol',
      why: 'admission regression',
      createdBy: 'codex61-sol',
      userId: 'u',
    });
  const before = structuredClone(store.listByKind('pr_tracking'));
  const slow = oneSlowRead();
  const routed = [];
  const spec = createConflictCheckTaskSpec({
    taskStore: store,
    log,
    checkMergeable: async (_repo, number, signal) => {
      if (number === 2) await slow(signal);
      return { mergeState: 'MERGEABLE', headSha: 'a'.repeat(40) };
    },
    conflictRouter: {
      route: async (signal) => {
        routed.push(signal.prNumber);
        return { kind: 'skipped' };
      },
    },
  });
  await runTick(spec);
  assert.deepEqual(routed, [1], 'the ready fact must survive a later stalled object');
  await runTick(spec);
  assert(routed.includes(2), 'the interrupted object must be retried');
  assert.deepEqual(store.listByKind('pr_tracking'), before);
});

for (const kind of ['repo-scan', 'repo-comment-poll'])
  test(`${kind} finishes partial admission without advancing the interrupted repository`, async () => {
    const slow = oneSlowRead();
    const notified = new Set();
    const delivered = [];
    const cursors = new Map([
      ['owner/first', '2026-10-01T00:00:00Z'],
      ['owner/second', '2026-10-01T00:00:00Z'],
    ]);
    const advanced = '2026-10-17T05:00:00Z';
    const opts = {
      log,
      repoAllowlist: [...cursors.keys()],
      inboxCatId: 'codex61-sol',
      defaultUserId: 'u',
      bindingStore: { getByExternal: async () => ({ threadId: 'inbox', userId: 'u' }) },
      deliveryDeps: {},
      deliverFn: async (_deps, input) => {
        delivered.push(input.source.meta.repoFullName);
        return { admitted: true, messageId: `m${delivered.length}` };
      },
      reconciliationDedup: {
        isNotified: async (repo) => notified.has(repo),
        markNotified: async (repo) => notified.add(repo),
        isBaselineEstablished: async () => true,
        markBaselineEstablished: async () => assert.fail('existing baselines must be preserved'),
      },
      fetchOpenPRs: async (repo, signal) => {
        if (repo === 'owner/second') await slow(signal);
        return [
          {
            number: 1,
            title: 'missed PR',
            html_url: 'https://github.com/owner/repo/pull/1',
            user: 'contributor',
            author_association: 'CONTRIBUTOR',
            draft: false,
          },
        ];
      },
      fetchOpenIssues: async () => [],
      eventLog: { append: async () => ({ appended: true }) },
      readCursor: async (repo) => cursors.get(repo),
      writeCursor: async (repo, cursor) => cursors.set(repo, cursor),
      fetchRepoComments: async (repo, _since, signal) => {
        if (repo === 'owner/second') await slow(signal);
        return [
          {
            issueNumber: 1,
            commentId: 1,
            author: 'contributor',
            authorAssociation: 'CONTRIBUTOR',
            body: 'new comment',
            updatedAt: advanced,
            isPullRequest: false,
          },
        ];
      },
    };
    const spec = kind === 'repo-scan' ? createRepoScanTaskSpec(opts) : repoCommentPollTaskSpec(opts);
    await runTick(spec);
    if (kind === 'repo-scan') {
      assert.deepEqual(delivered, ['owner/first']);
      assert.deepEqual([...notified], ['owner/first']);
    } else {
      assert.equal(cursors.get('owner/first'), advanced);
      assert.equal(cursors.get('owner/second'), '2026-10-01T00:00:00Z');
    }
    await runTick(spec);
    if (kind === 'repo-scan') assert.deepEqual(delivered, ['owner/first', 'owner/second']);
    else assert.equal(cursors.get('owner/second'), advanced);
  });
