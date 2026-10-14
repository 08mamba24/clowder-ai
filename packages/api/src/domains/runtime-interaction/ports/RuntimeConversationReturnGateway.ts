import type { RuntimeInteractionRecord } from '@cat-cafe/shared';

export interface RuntimeConversationReturnMessage {
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string | null;
  readonly timestamp: number;
  readonly deletedAt?: number;
  readonly tombstone?: boolean;
}

export interface RuntimeConversationReturnGateway {
  deliver(input: {
    interactionId: string;
    operationId: string;
    author: 'owner' | 'host';
    content: string;
    record: RuntimeInteractionRecord;
  }): Promise<{ messageId: string }>;
  readOwnerMessage(messageId: string): Promise<RuntimeConversationReturnMessage | null>;
}
