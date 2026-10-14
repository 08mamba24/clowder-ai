import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeInteractionRecord } from '@cat-cafe/shared';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { buildQueueEntry } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupQueueEntry.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { MessageQueueRuntimeConversationReturnGateway } from '../src/domains/runtime-interaction/MessageQueueRuntimeConversationReturnGateway.js';
import './helpers/setup-cat-registry.js';

function conversationRecord(interactionId = 'conversation-1'): RuntimeInteractionRecord {
  return {
    request: {
      version: 1,
      interactionId,
      kind: 'conversation_decision',
      owner: {
        userId: 'user-1',
        threadId: 'thread-1',
        catId: 'codex-sol',
        invocationId: 'requester-invocation',
      },
      createdAt: 1_000,
      title: 'Choose a release name',
      presentation: {
        id: 'decision-block',
        kind: 'interactive',
        v: 1,
        interactiveType: 'select',
        options: [
          { id: 'sunrise', label: 'Sunrise' },
          { id: 'moonrise', label: 'Moonrise' },
        ],
      },
      allowTextResponse: true,
    },
    source: {
      kind: 'conversation_decision',
      requesterCatId: 'codex-sol',
      requesterThreadId: 'thread-1',
      requesterInvocationId: 'requester-invocation',
    },
    returnBinding: { kind: 'conversation_turn', requesterCatId: 'codex-sol', requesterThreadId: 'thread-1' },
    status: 'pending',
    hostEpoch: 'host-1',
    revision: 3,
    cardRef: {
      threadId: 'thread-1',
      messageId: 'decision-card-message',
      blockId: 'decision-block',
      publishedAt: 1_000,
    },
    updatedAt: 1_100,
  };
}

class AppendAcknowledgementLossStore extends MessageStore {
  failOnce = true;

  override append(input: Parameters<MessageStore['append']>[0]) {
    const stored = super.append(input);
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error('simulated append acknowledgement loss');
    }
    return stored;
  }
}

class AppendAndRecoveryLookupLossStore extends AppendAcknowledgementLossStore {
  private lookupCount = 0;

  override getByIdempotencyKey(userId: string, threadId: string, idempotencyKey: string) {
    this.lookupCount += 1;
    if (this.lookupCount === 2) throw new Error('simulated recovery lookup loss');
    return super.getByIdempotencyKey(userId, threadId, idempotencyKey);
  }
}

function makeHarness(input?: { messageStore?: MessageStore; queue?: InvocationQueue }) {
  const messageStore = input?.messageStore ?? new MessageStore();
  const queue = input?.queue ?? new InvocationQueue();
  const roomEvents: unknown[] = [];
  const userEvents: unknown[] = [];
  const autoExecuteThreads: string[] = [];
  const gateway = new MessageQueueRuntimeConversationReturnGateway({
    messageStore,
    queue,
    socketManager: {
      broadcastToRoom: (room, event, data) => roomEvents.push({ room, event, data }),
      emitToUser: (userId, event, data) => userEvents.push({ userId, event, data }),
    },
    tryAutoExecute: async (threadId) => {
      autoExecuteThreads.push(threadId);
    },
    now: () => 2_000,
  });
  return { gateway, messageStore, queue, roomEvents, userEvents, autoExecuteThreads };
}

describe('MessageQueueRuntimeConversationReturnGateway', () => {
  it('persists one owner-authored response and one exact Queue carrier across retries', async () => {
    const { gateway, messageStore, queue, autoExecuteThreads } = makeHarness();
    const input = {
      interactionId: 'conversation-1',
      operationId: 'owner-operation',
      author: 'owner' as const,
      content: 'Release name: Sunrise',
      record: conversationRecord(),
    };

    const first = await gateway.deliver(input);
    const second = await gateway.deliver(input);
    assert.equal(second.messageId, first.messageId);
    const message = await messageStore.getById(first.messageId);
    assert.equal(message?.catId, null);
    assert.equal(message?.source, undefined, 'an authenticated card answer is owner speech, not connector speech');
    assert.equal(message?.replyTo, 'decision-card-message');
    assert.equal(message?.deliveryStatus, 'queued');
    assert.deepEqual(message?.extra?.runtimeInteractionReturn, {
      interactionId: 'conversation-1',
      operationId: 'owner-operation',
      author: 'owner',
      requesterCatId: 'codex-sol',
      cardMessageId: 'decision-card-message',
    });
    const queued = queue.list('thread-1', 'user-1');
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.messageId, first.messageId);
    assert.deepEqual(queued[0]?.targetCats, ['codex-sol']);
    assert.equal(queued[0]?.ownerAuthProvenance, 'strict');
    assert.deepEqual(autoExecuteThreads, ['thread-1', 'thread-1']);
  });

  it('attributes deadline returns to Host while targeting the original requester', async () => {
    const { gateway, messageStore, queue, roomEvents } = makeHarness();
    const delivered = await gateway.deliver({
      interactionId: 'conversation-default',
      operationId: 'deadline:2500',
      author: 'host',
      content: '截止已到，按默认继续：Release name: Sunrise',
      record: conversationRecord('conversation-default'),
    });

    const message = await messageStore.getById(delivered.messageId);
    assert.equal(message?.catId, null);
    assert.equal(message?.source?.connector, 'runtime-interaction');
    assert.equal(message?.extra?.runtimeInteractionReturn?.author, 'host');
    assert.equal(queue.list('thread-1', 'user-1')[0]?.source, 'connector');
    assert.equal(queue.list('thread-1', 'user-1')[0]?.ownerAuthProvenance, 'unknown');
    assert.equal(roomEvents.length, 1, 'Host returns are explicitly broadcast as connector messages');
  });

  it('keeps the original Queue owner when message append commits but its acknowledgement is lost', async () => {
    const messageStore = new AppendAcknowledgementLossStore();
    const { gateway, queue } = makeHarness({ messageStore });
    const delivered = await gateway.deliver({
      interactionId: 'conversation-1',
      operationId: 'ack-loss-operation',
      author: 'owner',
      content: 'Release name: Sunrise',
      record: conversationRecord(),
    });

    const [entry] = queue.list('thread-1', 'user-1');
    const stored = await messageStore.getById(delivered.messageId);
    assert.equal(entry?.messageId, delivered.messageId);
    assert.equal(stored?.queueCustody?.entryId, entry?.id);
    assert.equal(queue.list('thread-1', 'user-1').length, 1);
  });

  it('restores durable Queue custody when append and its immediate recovery lookup both lose acknowledgement', async () => {
    const messageStore = new AppendAndRecoveryLookupLossStore();
    const { gateway, queue, roomEvents } = makeHarness({ messageStore });
    const input = {
      interactionId: 'conversation-1',
      operationId: 'double-ack-loss-operation',
      author: 'host' as const,
      content: '截止已到，按默认继续：Release name: Sunrise',
      record: conversationRecord(),
    };

    await assert.rejects(gateway.deliver(input), /recovery lookup loss/);
    assert.equal(queue.list('thread-1', 'user-1').length, 0, 'the uncertain in-memory enqueue is rolled back');

    const recovered = await gateway.deliver(input);
    const [entry] = queue.list('thread-1', 'user-1');
    assert.equal(entry?.messageId, recovered.messageId);
    assert.equal(entry?.id, (await messageStore.getById(recovered.messageId))?.queueCustody?.entryId);
    assert.equal(entry?.autoExecute, true, 'a recovered conversation return must still wake its requester');
    assert.deepEqual(
      queue.listAutoExecute('thread-1').map((candidate) => candidate.id),
      [entry?.id],
      'durable recovery must remain eligible for automatic execution',
    );
    assert.equal(roomEvents.length, 1, 'the recovered Host notice is republished with its stable message id');
  });

  it('keeps a new return fenced from Queue execution until its durable message exists', async () => {
    const messageStore = new MessageStore();
    const { gateway, queue } = makeHarness({ messageStore });
    let dispatchableDuringAppend = -1;
    const append = messageStore.append.bind(messageStore);
    messageStore.append = (input) => {
      dispatchableDuringAppend = queue.listAutoExecute('thread-1').length;
      return append(input);
    };

    await gateway.deliver({
      interactionId: 'conversation-1',
      operationId: 'durable-boundary-operation',
      author: 'owner',
      content: 'Release name: Sunrise',
      record: conversationRecord(),
    });

    assert.equal(dispatchableDuringAppend, 0, 'the in-memory Queue row must stay fenced before append commits');
    assert.equal(queue.listAutoExecute('thread-1').length, 1, 'the fence releases after durable custody commits');
  });

  it('coalesces concurrent retries onto one durable return admission', async () => {
    const messageStore = new MessageStore();
    const { gateway, queue } = makeHarness({ messageStore });
    let appendCount = 0;
    const append = messageStore.append.bind(messageStore);
    messageStore.append = (input) => {
      appendCount += 1;
      return append(input);
    };
    const input = {
      interactionId: 'conversation-1',
      operationId: 'concurrent-operation',
      author: 'owner' as const,
      content: 'Release name: Sunrise',
      record: conversationRecord(),
    };

    const [first, second] = await Promise.all([gateway.deliver(input), gateway.deliver(input)]);

    assert.equal(first.messageId, second.messageId);
    assert.equal(appendCount, 1);
    assert.equal(queue.list('thread-1', 'user-1').length, 1);
  });

  it('re-enables automatic requester wakeup on a generic startup-restored Queue entry', async () => {
    const first = makeHarness();
    const input = {
      interactionId: 'conversation-1',
      operationId: 'startup-recovery-operation',
      author: 'owner' as const,
      content: 'Release name: Sunrise',
      record: conversationRecord(),
    };
    const delivered = await first.gateway.deliver(input);
    const stored = await first.messageStore.getById(delivered.messageId);
    assert.ok(stored?.queueCustody);

    const restoredQueue = new InvocationQueue();
    const genericRestored = buildQueueEntry([structuredClone(stored)], stored.queueCustody.entryId);
    assert.equal(genericRestored.autoExecute, false);
    restoredQueue.restoreDurableEntry(genericRestored);
    const second = makeHarness({ messageStore: first.messageStore, queue: restoredQueue });

    await second.gateway.deliver(input);

    assert.equal(restoredQueue.list('thread-1', 'user-1')[0]?.autoExecute, true);
    assert.equal(restoredQueue.listAutoExecute('thread-1').length, 1);
  });

  it('rejects an idempotency-key collision instead of reusing unrelated speech', async () => {
    const { gateway, messageStore } = makeHarness();
    await messageStore.append({
      userId: 'user-1',
      threadId: 'thread-1',
      catId: null,
      content: 'unrelated',
      mentions: [],
      timestamp: 1_500,
      idempotencyKey: 'runtime-interaction:return:conversation-1:owner-operation',
    });
    await assert.rejects(
      gateway.deliver({
        interactionId: 'conversation-1',
        operationId: 'owner-operation',
        author: 'owner',
        content: 'Release name: Sunrise',
        record: conversationRecord(),
      }),
      /idempotency key conflicts/i,
    );
  });
});
