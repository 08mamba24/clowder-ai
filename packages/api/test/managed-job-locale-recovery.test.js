import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  rawDurableGateRecord,
  recordDurableManagedGateProcess,
  recordManagedJobAttempt,
  writeDurableGateRecord,
} from '../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import { reconcileManagedJobDescriptor } from '../dist/domains/managed-job/managed-job-reconcile-descriptor.js';

for (const exitCode of [0, 1]) {
  for (const cancelled of [false, true]) {
    test(`Chinese-locale recovery settles exited code ${exitCode}, cancelled=${cancelled}, without rerunning`, async (t) => {
      if (process.platform !== 'darwin') return t.skip('BSD ps locale regression');
      const root = mkdtempSync(join(tmpdir(), 'managed-job-locale-'));
      const previousRoot = process.env.CAT_CAFE_DATA_DIR;
      const previousLocale = process.env.LC_ALL;
      process.env.CAT_CAFE_DATA_DIR = root;
      process.env.LC_ALL = 'zh_CN.UTF-8';
      t.after(() => {
        if (previousRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
        else process.env.CAT_CAFE_DATA_DIR = previousRoot;
        if (previousLocale === undefined) delete process.env.LC_ALL;
        else process.env.LC_ALL = previousLocale;
        rmSync(root, { recursive: true, force: true });
      });
      const service = new ManagedJobService(root);
      const principal = { userId: 'locale-user', threadId: 'locale-thread', catId: 'locale-cat' };
      const effectPath = join(root, 'command-must-not-run');
      const job = await service.submit(principal, {
        command: `touch '${effectPath}'`,
        cwd: root,
        originTaskId: 'locale-fixture-hold',
        originInvocationId: 'locale-fixture-invocation',
        idempotencyKey: 'locale-regression',
        executionSlaMs: 60000,
        wakeTarget: principal,
      });
      service.admit(principal, job.jobId, 'locale-visible-admission');
      const deadPid = spawnSync('/usr/bin/true').pid;
      assert.ok(Number.isSafeInteger(deadPid));
      assert.equal(
        recordDurableManagedGateProcess(job, {
          pid: deadPid,
          ppid: 1,
          pgid: deadPid,
          startedAt: '二 11月/10 16:05:03 2026 /opt/homebrew/bin/node',
        }),
        true,
      );
      const attempt = randomUUID();
      recordManagedJobAttempt(job, attempt);
      const original = {
        exitCode,
        timedOut: false,
        cancelled: false,
        durationMs: 123,
        tailOutput: 'original observed exit',
        terminationReason: 'command_exit',
      };
      assert.equal(writeDurableGateRecord(job, { ...rawDurableGateRecord(job), pendingResult: original }), true);
      if (cancelled) service.cancel(principal, job.jobId);
      await reconcileManagedJobDescriptor(job, Date.now(), job.supervisorEpoch);
      const settled = rawDurableGateRecord(job);
      assert.equal(settled.state, 'terminal');
      assert.equal(settled.cleanupProven, true);
      assert.equal(settled.terminalStatus, cancelled ? 'cancelled' : exitCode === 0 ? 'green' : 'failed');
      assert.equal(settled.attemptToken, attempt);
      assert.deepEqual(settled.pendingResult, original, 'the historical exit evidence remains intact');
      if (!cancelled) assert.equal(settled.result.exitCode, exitCode);
      assert.equal(existsSync(effectPath), false);
    });
  }
}
