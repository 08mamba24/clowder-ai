import { createModuleLogger } from '../../infrastructure/logger.js';
import { readDurableGateRecord } from '../managed-job/durable-managed-gate-job-store.js';
import { cancelDurableManagedGateJob, validateDurableManagedGateJob } from './durable-managed-gate-job.js';
import { resolveManagedCommandJob } from './managed-command-job-reference.js';
import type {
  ManagedCommandWakeRecoveryDeps,
  ManagedCommandWakeRecoveryResult,
} from './managed-command-wake-lifecycle.js';
import {
  isHoldBallWakeTask,
  parseRetiredManagedCommandWakeTask,
  readHoldLifecycleProjection,
} from './managed-command-wake-task-projection.js';

const log = createModuleLogger('ball-custody/consumed-managed-command-cancellation');

/** Settle cancellation after an earlier failure wake was already consumed. Never replay that wake. */
export async function recoverConsumedManagedCommandCancellation(
  deps: ManagedCommandWakeRecoveryDeps,
  taskId: string,
  now: () => number,
): Promise<ManagedCommandWakeRecoveryResult> {
  const task = deps.dynamicTaskStore.getById(taskId);
  const parsed = parseRetiredManagedCommandWakeTask(task);
  if (
    !task ||
    !isHoldBallWakeTask(task) ||
    !readHoldLifecycleProjection(task) ||
    !parsed ||
    parsed.lifecycle.createdBy !== task.createdBy ||
    parsed.lifecycle.status !== 'cancel_requested' ||
    parsed.command.state !== 'consumed'
  )
    return 'missing';
  const job = resolveManagedCommandJob(task);
  if (
    !job ||
    !validateDurableManagedGateJob(job, task.id) ||
    job.wakeTarget.userId !== parsed.userId ||
    job.wakeTarget.threadId !== parsed.threadId ||
    job.wakeTarget.catId !== parsed.catId
  )
    return 'pending';
  const record = readDurableGateRecord(job);
  if (record?.state !== 'terminal' || record.cleanupProven !== true) {
    cancelDurableManagedGateJob(job, {
      cancelledBy:
        typeof parsed.lifecycle.cancelledBy === 'string' ? parsed.lifecycle.cancelledBy : 'persisted_hold_cancellation',
      reason: 'explicit_hold_cancel',
      now: now(),
    });
    return 'pending';
  }

  // Publish before the lifecycle CAS: crashes and competing sweeps recover the
  // same durable message, while the old completion message/dispatch stay intact.
  const idempotencyKey = `hold-ball-cancellation-terminal:${task.id}:${job.jobId}`;
  try {
    const existing = await deps.messageStore.getByIdempotencyKey(parsed.userId, parsed.threadId, idempotencyKey);
    const stored =
      existing ??
      (await deps.messageStore.append({
        from: { kind: 'system', service: 'managed-command-terminal-recovery' },
        userId: parsed.userId,
        threadId: parsed.threadId,
        timestamp: now(),
        content: '持球已取消：托管命令已结束，进程清理已确认。',
        mentions: [],
        idempotencyKey,
        source: {
          connector: 'hold-ball',
          label: '持球结果',
          icon: '🏓',
          meta: {
            managedHold: true,
            phase: 'terminal',
            outcome: 'cancelled_by_user',
            taskId: task.id,
            jobId: job.jobId,
            threadId: parsed.threadId,
            catId: parsed.catId,
            wakeWhen: true,
            terminalReceipt: true,
            managedJobReceipt: 'terminal',
            cancelable: false,
          },
        },
      }));
    if (!existing) {
      try {
        deps.socketManager.broadcastToRoom(`thread:${parsed.threadId}`, 'connector_message', {
          threadId: parsed.threadId,
          message: {
            id: stored.id,
            from: stored.from,
            type: 'connector',
            content: stored.content,
            source: stored.source,
            timestamp: stored.timestamp,
          },
        });
      } catch {
        // History is durable even if the live projection cannot be delivered.
      }
    }
    return deps.dynamicTaskStore.updateParamsIfCurrent(task.id, task.params, {
      ...task.params,
      holdLifecycle: {
        ...parsed.lifecycle,
        status: 'cancelled_by_user',
        cancellationCompletedAt: now(),
        cancellationReceiptMessageId: stored.id,
      },
    })
      ? 'recovered'
      : 'pending';
  } catch (err) {
    log.warn({ taskId, err }, 'Consumed command cancellation receipt will retry without replaying the wake');
    return 'pending';
  }
}
