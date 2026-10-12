import { ADD_TO_CHAT_LABEL } from '@/components/SelectionAnnotationAction';
import type { useWorkspaceMediaChat } from './useWorkspaceMediaChat';

type MediaChat = ReturnType<typeof useWorkspaceMediaChat>;

/** The same name and tooltip as the text selection card's action (one shared constant): one concept, one name. */
export function AddToChatButton({ chat }: { readonly chat: MediaChat }) {
  if (!chat.offered) return null;
  return (
    <button
      type="button"
      data-testid="workspace-content-review-media-add-to-chat"
      title={ADD_TO_CHAT_LABEL}
      onClick={chat.add}
      className="shrink-0 rounded-md border border-cafe-subtle px-2 py-1 text-xs font-medium text-cafe-accent"
    >
      {ADD_TO_CHAT_LABEL}
    </button>
  );
}

/** Says why a place could not be added, while that place is still selected. */
export function AddToChatNotice({ chat }: { readonly chat: MediaChat }) {
  if (!chat.notice || !chat.offered) return null;
  return <output className="block px-1 pt-1 text-xs text-cafe-muted">{chat.notice}</output>;
}
