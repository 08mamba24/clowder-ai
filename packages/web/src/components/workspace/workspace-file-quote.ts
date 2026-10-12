import { type ContextAttachment, ContextAttachmentsSchema } from '@cat-cafe/shared';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { createQuoteContextAttachment } from '../chat-context-reference';
import { composerAttachments, queuedServerAckBlocks } from '../composer-queue';
import { COMPOSER_RECALL_PENDING_COPY, COMPOSER_TOO_LARGE_COPY } from '../composer-refusal-copy';

/** A selection in one workspace file, with only the coordinates that were actually known. */
export interface WorkspaceFileQuote {
  readonly text: string;
  readonly comment: string;
  readonly path: string;
  /**
   * The exact version of the file the selection was made in: the owner's `sha256:<hex>` or the bare digest a file
   * API answers with. It is required so no producer can forget to say it; `null` is the explicit "this surface cannot
   * vouch for a version" (an unsaved draft, a file it has not verified), which leaves the reference unversioned.
   */
  readonly revision: string | null;
  readonly worktreeId?: string | null;
  readonly branch?: string | null;
  readonly language?: string | null;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
}

const SHA256_REVISION = /^(?:sha256:)?([0-9a-f]{64})$/;

/** The owner's form of a revision, or nothing: a reference never says a version it cannot back. */
function exactRevision(revision: string | null): `sha256:${string}` | null {
  const digest = revision ? SHA256_REVISION.exec(revision)?.[1] : undefined;
  return digest ? `sha256:${digest}` : null;
}

export function workspaceFileQuoteAttachment(quote: WorkspaceFileQuote): ContextAttachment {
  const revision = exactRevision(quote.revision);
  return createQuoteContextAttachment(
    quote.text,
    {
      kind: 'workspace_file',
      path: quote.path,
      ...(quote.worktreeId ? { worktreeId: quote.worktreeId } : {}),
      ...(quote.branch ? { branch: quote.branch } : {}),
      ...(revision ? { revision } : {}),
      ...(quote.language ? { language: quote.language } : {}),
      ...(quote.lineStart !== undefined && quote.lineEnd !== undefined
        ? { lineStart: quote.lineStart, lineEnd: quote.lineEnd }
        : {}),
    },
    {
      comment: quote.comment,
      ...(quote.selectionStart !== undefined && quote.selectionEnd !== undefined
        ? { selectionStart: quote.selectionStart, selectionEnd: quote.selectionEnd }
        : {}),
    },
  );
}

export type AddWorkspaceFileQuote =
  | { readonly kind: 'added' }
  | { readonly kind: 'refused'; readonly reason: 'too_large' | 'recall_pending' };

const REFUSAL_COPY = { too_large: COMPOSER_TOO_LARGE_COPY, recall_pending: COMPOSER_RECALL_PENDING_COPY } as const;

/**
 * The one "add to chat" for a workspace file selection: it lands in that thread's chat input as an
 * annotation chip. It does not send, delegate, or record anything else.
 *
 * What is already queued for this conversation stays: the input takes a queued place only when it is there to take
 * it (a chat folded away while the file is read does not), so a second place must not replace the first. A place that
 * would make the whole input more than one message can carry, or that would meet a recall's answer the input has not
 * taken yet, is refused before anything is queued: the person is told why, and the caller learns it too, so it can
 * keep the selection and the words where they are.
 */
export function addWorkspaceFileQuoteToChat(threadId: string, quote: WorkspaceFileQuote): AddWorkspaceFileQuote {
  const refuse = (reason: 'too_large' | 'recall_pending'): AddWorkspaceFileQuote => {
    useToastStore
      .getState()
      .addToast({ type: 'error', title: '没能放进输入框', message: REFUSAL_COPY[reason], duration: 6000 });
    return { kind: 'refused', reason };
  };
  if (queuedServerAckBlocks()) return refuse('recall_pending');
  const attachment = workspaceFileQuoteAttachment(quote);
  // The canonical rule for what one message carries, over the whole input: its stored draft with what is queued
  // applied, and this place.
  if (!ContextAttachmentsSchema.safeParse([...composerAttachments(threadId), attachment]).success)
    return refuse('too_large');
  const store = useChatStore.getState();
  const queued = store.pendingChatInsert;
  const base = queued && queued.threadId === threadId ? queued : { threadId, text: '' };
  store.setPendingChatInsert({ ...base, contextAttachments: [...(base.contextAttachments ?? []), attachment] });
  return { kind: 'added' };
}
