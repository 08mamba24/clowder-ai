import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { ManagedCommandWakeRecoverySweep } from '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import {
  rawDurableGateRecord,
  recordDurableManagedGateProcess,
  recordManagedJobAttempt,
  writeDurableGateRecord,
} from '../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { registerHoldBallCancelRoutes } from '../dist/routes/callback-hold-ball-cancel-routes.js';

async function fixture(t, { state = 'consumed', exitCode = 0, live = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'consumed-cancellation-'));
  const previous = { data: process.env.CAT_CAFE_DATA_DIR, locale: process.env.LC_ALL };
  process.env.CAT_CAFE_DATA_DIR = root;
  process.env.LC_ALL = 'zh_CN.UTF-8';
  const db = new Database(':memory:');
  t.after(() => {
    db.close();
    if (previous.data === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previous.data;
    if (previous.locale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previous.locale;
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(db);
  const store = new DynamicTaskStore(db);
  const service = new ManagedJobService(root);
  const principal = { userId: 'fixture-user', threadId: 'fixture-thread', catId: 'fixture-cat' };
  const taskId = 'hold-ball-consumed-fixture';
  const effectPath = join(root, 'original-command-must-not-run');
  const command = `touch '${effectPath}'`;
  const job = await service.submit(principal, {
    command,
    cwd: root,
    originTaskId: taskId,
    originInvocationId: 'fixture-invocation',
    idempotencyKey: taskId,
    executionSlaMs: 60000,
    wakeTarget: principal,
  });
  service.admit(principal, job.jobId, 'fixture-admission');
  if (!live) {
    const pid = spawnSync('/usr/bin/true').pid;
    assert.ok(Number.isSafeInteger(pid));
    assert.equal(
      recordDurableManagedGateProcess(job, {
        pid,
        ppid: 1,
        pgid: pid,
        startedAt: '二 11月/10 16:05:03 2026 /opt/homebrew/Cellar/node@24/24.18.0/bin/node',
      }),
      true,
    );
  }
  recordManagedJobAttempt(job, randomUUID());
  const pendingResult = {
    exitCode,
    timedOut: false,
    cancelled: false,
    durationMs: 123,
    signal: null,
    terminationReason: 'command_exit',
  };
  if (!live) assert.equal(writeDurableGateRecord(job, { ...rawDurableGateRecord(job), pendingResult }), true);
  const now = Date.now();
  const originalCommand = {
    state,
    command,
    cwd: root,
    startedAt: now - 10000,
    jobId: job.jobId,
    admissionFactAppended: true,
    ...(state === 'consumed'
      ? {
          lostAt: now - 9000,
          lostReason: 'runner_failed',
          lostDetail: 'managed_job_terminal_pending',
          carrierTerminalReason: 'failed',
          messageId: 'original-consumed-wake',
          consumedAt: now - 8990,
        }
      : {}),
  };
  store.insert({
    id: taskId,
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: now - 1000 },
    display: { label: 'fixture', category: 'system' },
    deliveryThreadId: principal.threadId,
    enabled: false,
    createdBy: `hold-ball:${principal.catId}`,
    createdAt: new Date(now - 10000).toISOString(),
    params: {
      message: 'fixture fallback',
      targetCatId: principal.catId,
      triggerUserId: principal.userId,
      holdLifecycle: {
        mode: 'wake_when',
        status: 'cancel_requested',
        createdBy: `hold-ball:${principal.catId}`,
        cancellationRequestedAt: now,
        cancelledBy: 'operator:fixture-user',
        managedCommand: originalCommand,
      },
    },
  });
  if (!live) service.cancel(principal, job.jobId);
  const messages = [];
  const deps = {
    dynamicTaskStore: store,
    messageStore: {
      getById: () => null,
      getByIdempotencyKey: (_u, _t, key) => messages.find((m) => m.idempotencyKey === key) ?? null,
      append: async (m) => {
        const stored = { ...m, id: `message-${messages.length}` };
        messages.push(stored);
        return stored;
      },
    },
    socketManager: { broadcastToRoom() {} },
    taskRunner: { unregister() {} },
    invocationRecordStore: { getByIdempotencyKey: () => null },
    admitWake: async () => assert.fail('cancellation recovery must never wake a model'),
    isCommandRunnerActive: () => false,
  };
  const sweep = new ManagedCommandWakeRecoverySweep(deps);
  return { store, service, job, principal, taskId, effectPath, pendingResult, originalCommand, messages, deps, sweep };
}

for (const state of ['command_running', 'consumed']) {
  for (const exitCode of [0, 1]) {
    test(`canonical recovery closes ${state} cancellation after historical exit ${exitCode}`, async (t) => {
      const f = await fixture(t, { state, exitCode });
      assert.deepEqual(
        f.store.listManagedCommandCandidates().map((t) => t.id),
        [f.taskId],
      );
      await f.sweep.runOnce();
      await f.sweep.runOnce();
      const record = rawDurableGateRecord(f.job);
      assert.equal(record.state, 'terminal');
      assert.equal(record.terminalStatus, 'cancelled');
      assert.equal(record.cleanupProven, true);
      assert.deepEqual(record.pendingResult, f.pendingResult);
      assert.equal(existsSync(f.effectPath), false);
      const lifecycle = f.store.getById(f.taskId).params.holdLifecycle;
      assert.equal(lifecycle.status, 'cancelled_by_user');
      assert.deepEqual(f.store.listManagedCommandCandidates(), []);
      if (state === 'consumed') {
        assert.deepEqual(lifecycle.managedCommand, f.originalCommand, 'old wake/result/consumption stay frozen');
        assert.equal(f.messages.length, 1);
        assert.equal(lifecycle.cancellationReceiptMessageId, f.messages[0].id);
        assert.equal(f.messages[0].source.meta.phase, 'terminal');
        assert.equal(f.messages[0].source.meta.cancelable, false);
        assert.equal(f.messages[0].source.meta.jobId, f.job.jobId);
        assert.deepEqual(f.messages[0].mentions, []);
      }
      const app = Fastify();
      t.after(() => app.close());
      registerHoldBallCancelRoutes(app, {
        ...f.deps,
        ownerUserId: f.principal.userId,
        threadStore: {
          get: () => ({ id: f.principal.threadId, createdBy: f.principal.userId }),
          list: () => [{ id: f.principal.threadId }],
        },
      });
      const response = await app.inject({
        method: 'GET',
        url: `/api/callbacks/hold-ball/${f.taskId}/status`,
        headers: { 'x-cat-cafe-user': f.principal.userId },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().status, 'cancelled_by_user');
      assert.equal(response.json().cancelable, false);
    });
  }
}

for (const failure of ['append_before_commit', 'append_after_commit', 'lifecycle_cas', 'socket']) {
  test(`consumed cancellation retries ${failure} without duplicate receipt or wake`, async (t) => {
    const f = await fixture(t);
    const append = f.deps.messageStore.append;
    const cas = f.store.updateParamsIfCurrent.bind(f.store);
    let injected = false;
    f.deps.messageStore.append = async (m) => {
      if (failure.startsWith('append') && !injected) {
        injected = true;
        if (failure === 'append_after_commit') await append(m);
        throw new Error('fixture append failure');
      }
      return append(m);
    };
    f.store.updateParamsIfCurrent = (...args) => {
      if (failure === 'lifecycle_cas' && !injected) {
        injected = true;
        return false;
      }
      return cas(...args);
    };
    f.deps.socketManager.broadcastToRoom = () => {
      if (failure === 'socket') {
        injected = true;
        throw new Error('fixture socket failure');
      }
    };
    await f.sweep.runOnce();
    if (failure !== 'socket') assert.equal(f.store.getById(f.taskId).params.holdLifecycle.status, 'cancel_requested');
    await f.sweep.runOnce();
    await f.sweep.runOnce();
    assert.equal(injected, true);
    assert.equal(f.store.getById(f.taskId).params.holdLifecycle.status, 'cancelled_by_user');
    assert.deepEqual(f.store.getById(f.taskId).params.holdLifecycle.managedCommand, f.originalCommand);
    assert.equal(f.messages.length, 1);
    assert.equal(existsSync(f.effectPath), false);
  });
}

for (const mismatch of ['user', 'thread', 'cat', 'task', 'unproven_cleanup']) {
  test(`consumed cancellation does not settle ${mismatch}`, async (t) => {
    const f = await fixture(t, { live: mismatch === 'unproven_cleanup' });
    const task = f.store.getById(f.taskId);
    if (mismatch === 'user') task.params.triggerUserId = 'other-user';
    if (mismatch === 'thread') task.deliveryThreadId = 'other-thread';
    if (mismatch === 'cat') task.createdBy = 'hold-ball:other-cat';
    if (mismatch === 'task') {
      const other = await f.service.submit(f.principal, {
        command: 'true',
        cwd: f.job.definition.cwd,
        originTaskId: 'hold-ball-other',
        originInvocationId: 'fixture-other',
        idempotencyKey: 'other-job',
        executionSlaMs: 60000,
        wakeTarget: f.principal,
      });
      task.params.holdLifecycle.managedCommand.jobId = other.jobId;
    }
    // Store canonical columns as well as JSON, so real lookup fences see the mutation.
    f.store.remove(task.id);
    f.store.insert(task);
    await f.sweep.runOnce();
    assert.equal(f.store.getById(f.taskId).params.holdLifecycle.status, 'cancel_requested');
    assert.equal(f.messages.length, 0);
    assert.equal(existsSync(f.effectPath), false);
  });
}
