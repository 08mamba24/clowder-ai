import type { CatId, ConnectorSource } from '@cat-cafe/shared';
import type { SocketManager } from '../../infrastructure/websocket/index.js';
import { emitQueueUpdated } from '../../utils/queue-enrichment.js';
import type { InvocationQueue, QueueEntry } from '../cats/services/agents/invocation/InvocationQueue.js';
import { createInitialQueuedMessageCustody } from '../cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { buildQueueEntry } from '../cats/services/agents/invocation/QueuedMessageCustodyStartupQueueEntry.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type {
  RuntimeConversationReturnGateway,
  RuntimeConversationReturnMessage,
} from './ports/RuntimeConversationReturnGateway.js';

const RUNTIME_INTERACTION_SOURCE: ConnectorSource = {
  connector: 'runtime-interaction',
  label: '对话决定',
  icon: 'cat-cafe',
};

type ReturnSocketManager = Pick<SocketManager, 'broadcastToRoom' | 'emitToUser'>;
type ConversationReturnInput = Parameters<RuntimeConversationReturnGateway['deliver']>[0];
type ReturnCoordinates = {
  threadId: string;
  userId: string;
  requesterCatId: CatId;
  idempotencyKey: string;
  admissionId: string;
  cardMessageId: string;
};

export class MessageQueueRuntimeConversationReturnGateway implements RuntimeConversationReturnGateway {
  private readonly inFlight = new Map<string, { signature: string; promise: Promise<{ messageId: string }> }>();

  constructor(
    private readonly deps: {
      messageStore: IMessageStore;
      queue: InvocationQueue;
      socketManager: ReturnSocketManager;
      tryAutoExecute: (threadId: string) => Promise<unknown>;
      now?: () => number;
    },
  ) {}

  async deliver(input: ConversationReturnInput): Promise<{ messageId: string }> {
    const request = input.record.request;
    if (request.kind !== 'conversation_decision' || !input.record.cardRef) {
      throw new Error('conversation return requires a canonical decision card');
    }
    const coordinates: ReturnCoordinates = {
      threadId: request.owner.threadId,
      userId: request.owner.userId,
      requesterCatId: request.owner.catId as CatId,
      idempotencyKey: `runtime-interaction:return:${input.interactionId}:${input.operationId}`,
      admissionId: `runtime-interaction:return-admission:${input.interactionId}:${input.operationId}`,
      cardMessageId: input.record.cardRef.messageId,
    };
    const signature = JSON.stringify([
      input.interactionId,
      input.operationId,
      input.author,
      input.content,
      coordinates.threadId,
      coordinates.userId,
      coordinates.requesterCatId,
      coordinates.cardMessageId,
    ]);
    const active = this.inFlight.get(coordinates.idempotencyKey);
    if (active) {
      if (active.signature !== signature) throw new Error('conversation return in-flight identity conflicts');
      return active.promise;
    }
    const promise = this.deliverOnce(input, coordinates);
    this.inFlight.set(coordinates.idempotencyKey, { signature, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(coordinates.idempotencyKey)?.promise === promise) {
        this.inFlight.delete(coordinates.idempotencyKey);
      }
    }
  }

  private async deliverOnce(
    input: ConversationReturnInput,
    coordinates: ReturnCoordinates,
  ): Promise<{ messageId: string }> {
    const existing = await this.deps.messageStore.getByIdempotencyKey(
      coordinates.userId,
      coordinates.threadId,
      coordinates.idempotencyKey,
    );
    if (existing) {
      this.assertExactReturn(existing, input);
      this.restoreDurableQueue(existing, coordinates);
      if (input.author === 'host') this.broadcastHostReturn(existing);
      await this.publishQueue(coordinates.threadId, coordinates.userId);
      return { messageId: existing.id };
    }
    const entry = this.enqueueReturn(input, coordinates);
    const stored = await this.persistReturn(input, coordinates, entry);
    if (this.bindStoredReturn(input, coordinates, entry, stored)) {
      const committed = this.deps.queue.commitQueueCustodyAdmission(
        coordinates.threadId,
        coordinates.userId,
        coordinates.admissionId,
        [entry.id],
      );
      if (!committed) {
        this.rollbackStagedReturn(coordinates, entry.id);
        throw new Error('conversation return Queue admission changed before durable publish');
      }
    } else {
      this.restoreDurableQueue(stored, coordinates);
    }
    if (input.author === 'host') this.broadcastHostReturn(stored);
    await this.publishQueue(coordinates.threadId, coordinates.userId);
    return { messageId: stored.id };
  }

  private enqueueReturn(input: ConversationReturnInput, coordinates: ReturnCoordinates): QueueEntry {
    const enqueue = this.deps.queue.enqueue({
      threadId: coordinates.threadId,
      userId: coordinates.userId,
      ownerAuthProvenance: input.author === 'owner' ? 'strict' : 'unknown',
      content: input.content,
      source: input.author === 'owner' ? 'user' : 'connector',
      sourceCategory: 'producer_return',
      targetCats: [coordinates.requesterCatId],
      intent: 'execute',
      autoExecute: true,
      priority: 'urgent',
      idempotencyKey: coordinates.idempotencyKey,
      queueCustodyAdmissionId: coordinates.admissionId,
      messageId: null,
    });
    if (enqueue.outcome !== 'enqueued' || !enqueue.entry) {
      throw new Error('conversation return queue is full');
    }
    const staged = this.deps.queue.stageQueueCustodyAdmission(
      coordinates.threadId,
      coordinates.userId,
      enqueue.entry.id,
      coordinates.admissionId,
    );
    if (!staged) throw new Error('conversation return Queue entry could not be fenced');
    return staged;
  }

  private async persistReturn(
    input: ConversationReturnInput,
    coordinates: ReturnCoordinates,
    entry: QueueEntry,
  ): Promise<StoredMessage> {
    try {
      return await this.deps.messageStore.append({
        userId: coordinates.userId,
        threadId: coordinates.threadId,
        catId: null,
        content: input.content,
        mentions: [coordinates.requesterCatId],
        timestamp: this.deps.now?.() ?? Date.now(),
        replyTo: coordinates.cardMessageId,
        idempotencyKey: coordinates.idempotencyKey,
        deliveryStatus: 'queued',
        queueCustody: createInitialQueuedMessageCustody(entry),
        ...(input.author === 'host' ? { origin: 'callback' as const, source: RUNTIME_INTERACTION_SOURCE } : {}),
        extra: {
          targetCats: [coordinates.requesterCatId],
          runtimeInteractionReturn: {
            interactionId: input.interactionId,
            operationId: input.operationId,
            author: input.author,
            requesterCatId: coordinates.requesterCatId,
            cardMessageId: coordinates.cardMessageId,
          },
        },
      });
    } catch (error) {
      try {
        const committed = await this.deps.messageStore.getByIdempotencyKey(
          coordinates.userId,
          coordinates.threadId,
          coordinates.idempotencyKey,
        );
        if (committed) {
          this.assertExactReturn(committed, input);
          if (committed.queueCustody?.entryId !== entry.id) {
            throw new Error('conversation return committed with divergent Queue custody');
          }
          this.deps.queue.backfillMessageId(coordinates.threadId, coordinates.userId, entry.id, committed.id);
          return committed;
        }
        throw error;
      } catch (recoveryError) {
        this.rollbackStagedReturn(coordinates, entry.id);
        throw recoveryError;
      }
    }
  }

  private bindStoredReturn(
    input: ConversationReturnInput,
    coordinates: ReturnCoordinates,
    entry: QueueEntry,
    stored: StoredMessage,
  ): boolean {
    if (stored.queueCustody?.entryId !== entry.id) {
      this.rollbackStagedReturn(coordinates, entry.id);
      this.assertExactReturn(stored, input);
      return false;
    } else {
      this.deps.queue.backfillMessageId(coordinates.threadId, coordinates.userId, entry.id, stored.id);
      return true;
    }
  }

  private rollbackStagedReturn(coordinates: ReturnCoordinates, entryId: string): void {
    const current = this.deps.queue.getEntrySnapshot(coordinates.threadId, coordinates.userId, entryId);
    if (!current || current.queueCustodyAdmissionId !== coordinates.admissionId) return;
    this.deps.queue.removeEntrySnapshotIfUnchanged(current, coordinates.admissionId);
  }

  private restoreDurableQueue(message: StoredMessage, coordinates: ReturnCoordinates): void {
    const custody = message.queueCustody;
    if (!custody?.entryId) throw new Error('conversation return has no durable Queue custody');
    const live = this.deps.queue.getEntrySnapshot(coordinates.threadId, coordinates.userId, custody.entryId);
    if (live) {
      if (
        live.messageId !== message.id ||
        (live.idempotencyKey !== undefined && live.idempotencyKey !== coordinates.idempotencyKey) ||
        !live.allTargetCats?.includes(coordinates.requesterCatId)
      ) {
        throw new Error('conversation return live Queue projection conflicts with durable custody');
      }
      if (!live.autoExecute || !live.idempotencyKey) {
        const repaired = this.deps.queue.restoreEntrySnapshotIfUnchanged(live, {
          ...live,
          autoExecute: true,
          idempotencyKey: coordinates.idempotencyKey,
        });
        if (!repaired) throw new Error('conversation return live Queue projection changed during recovery');
      }
      return;
    }
    const targetIsTerminal =
      custody.status === 'terminal' ||
      custody.handledByCatIds.includes(coordinates.requesterCatId) ||
      custody.failedByCatIds.includes(coordinates.requesterCatId) ||
      custody.withdrawnByCatIds?.includes(coordinates.requesterCatId) === true;
    if (targetIsTerminal) return;
    if (!custody.pendingTargetCats.includes(coordinates.requesterCatId)) {
      throw new Error('conversation return durable Queue target is neither pending nor terminal');
    }
    const restored = buildQueueEntry([structuredClone(message)], custody.entryId);
    restored.autoExecute = true;
    restored.idempotencyKey = coordinates.idempotencyKey;
    this.deps.queue.restoreDurableEntry(restored);
  }

  async readOwnerMessage(messageId: string): Promise<RuntimeConversationReturnMessage | null> {
    const message = await this.deps.messageStore.getById(messageId);
    if (!message) return null;
    return {
      userId: message.userId,
      threadId: message.threadId,
      catId: message.catId,
      timestamp: message.timestamp,
      ...(message.deletedAt !== undefined ? { deletedAt: message.deletedAt } : {}),
      ...(message._tombstone ? { tombstone: true } : {}),
    };
  }

  private async publishQueue(threadId: string, userId: string): Promise<void> {
    await emitQueueUpdated(
      this.deps.socketManager,
      userId,
      threadId,
      this.deps.queue.list(threadId, userId),
      this.deps.messageStore,
      'runtime_interaction_return',
    );
    await this.deps.tryAutoExecute(threadId);
  }

  private broadcastHostReturn(message: StoredMessage): void {
    this.deps.socketManager.broadcastToRoom(`thread:${message.threadId}`, 'connector_message', {
      threadId: message.threadId,
      message: {
        id: message.id,
        type: 'connector',
        content: message.content,
        source: RUNTIME_INTERACTION_SOURCE,
        timestamp: message.timestamp,
      },
    });
  }

  private assertExactReturn(message: StoredMessage, input: ConversationReturnInput): void {
    const request = input.record.request;
    if (request.kind !== 'conversation_decision' || !input.record.cardRef) throw new Error('wrong interaction kind');
    const meta = message.extra?.runtimeInteractionReturn;
    if (
      message.userId !== request.owner.userId ||
      message.threadId !== request.owner.threadId ||
      message.catId !== null ||
      message.content !== input.content ||
      message.replyTo !== input.record.cardRef.messageId ||
      meta?.interactionId !== input.interactionId ||
      meta.operationId !== input.operationId ||
      meta.author !== input.author ||
      meta.requesterCatId !== request.owner.catId ||
      meta.cardMessageId !== input.record.cardRef.messageId ||
      !message.mentions.includes(request.owner.catId as CatId) ||
      message.queueCustody?.ownerUserId !== request.owner.userId ||
      !message.queueCustody.allTargetCats.includes(request.owner.catId as CatId) ||
      message.queueCustody.ownerAuthProvenance !== (input.author === 'owner' ? 'strict' : 'unknown') ||
      (input.author === 'host' ? message.source?.connector !== 'runtime-interaction' : message.source !== undefined)
    ) {
      throw new Error('conversation return idempotency key conflicts with another message');
    }
  }
}
