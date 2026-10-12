import type { ContextAttachment } from '@cat-cafe/shared';
import type { RefObject } from 'react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { applyContextAttachmentDelta } from '@/components/durable-composer-draft-merge';
import { useShellCopy } from '@/components/shell/shell-copy';
import { getContextAttachmentDraft, subscribeContextAttachmentDrafts } from '@/components/thread-drafts';
import { useChatStore } from '@/stores/chatStore';
import { observeWorkspaceQuoteLayout } from './observe-workspace-quote-layout';
import { workspaceFileQuotesCopy } from './workspace-file-quotes.shell-copy';

type Mark = { ids: string[]; numbers: number[]; top: number };
const EMPTY: readonly ContextAttachment[] = [];

/** Do not turn a rendered offset or a repeated quote into a guessed file position. */
function uniqueRenderedLeaf(nodes: readonly HTMLElement[], quote: string): HTMLElement | null {
  const matches = nodes.filter((node) => node.textContent?.includes(quote));
  const leaves = matches.filter((node) => !matches.some((child) => child !== node && node.contains(child)));
  return leaves.length === 1 && leaves[0].textContent?.split(quote).length === 2 ? leaves[0] : null;
}

function currentDraftLeaf(nodes: readonly HTMLElement[], attachment: ContextAttachment, revision: string) {
  return attachment.kind === 'quote' &&
    attachment.source.kind === 'workspace_file' &&
    attachment.source.revision === revision
    ? uniqueRenderedLeaf(nodes, attachment.text)
    : null;
}

/** The existing composer is the only draft. A local mark neither publishes a quote nor creates a request. */
export function WorkspacePendingFileQuoteMarks({
  locator,
  revision,
  text,
  container,
  visible,
}: {
  locator: { worktreeId: string; path: string };
  revision: string;
  text: string;
  container: RefObject<HTMLDivElement | null>;
  visible: boolean;
}) {
  const threadId = useChatStore((store) => store.currentThreadId);
  const queued = useChatStore((store) => store.pendingChatInsert);
  const stored = useSyncExternalStore(
    subscribeContextAttachmentDrafts,
    () => getContextAttachmentDraft(threadId),
    () => EMPTY,
  );
  const pending = useMemo(() => {
    const attachments =
      queued?.threadId === threadId
        ? applyContextAttachmentDelta(
            stored,
            queued.contextAttachments ?? [],
            new Set(queued.removeContextAttachmentIds ?? []),
          )
        : stored;
    return attachments
      .filter((quote) => quote.kind === 'quote' && quote.source.kind === 'workspace_file')
      .map((attachment, index) => ({ attachment, number: index + 1 }))
      .filter(
        ({ attachment }) =>
          attachment.kind === 'quote' &&
          attachment.source.kind === 'workspace_file' &&
          attachment.source.worktreeId === locator.worktreeId &&
          attachment.source.path === locator.path,
      );
  }, [threadId, stored, queued, locator.worktreeId, locator.path]);
  const scope = JSON.stringify([threadId, locator, revision, text, pending]);
  const [layout, setLayout] = useState<{ scope: string; marks: Mark[]; unlocated: number }>({
    scope,
    marks: [],
    unlocated: 0,
  });
  const t = useShellCopy(workspaceFileQuotesCopy);
  useEffect(() => {
    const paper = container.current,
      parent = paper?.parentElement;
    if (!paper || !parent || !visible) return;
    const measure = () => {
      const paperRect = paper.getBoundingClientRect(),
        parentRect = parent.getBoundingClientRect();
      const nodes = [...paper.querySelectorAll<HTMLElement>('[data-source-line]')];
      const groups = new Map<HTMLElement, Mark>();
      let unlocated = 0;
      for (const { attachment, number } of pending) {
        // Rendered Markdown offsets are not raw-file offsets. Only one exact visible leaf can vouch for this mark.
        const node = currentDraftLeaf(nodes, attachment, revision);
        if (!node) {
          unlocated++;
          continue;
        }
        const rect = node.getBoundingClientRect();
        if (rect.bottom <= paperRect.top || rect.top >= paperRect.bottom) continue;
        const group = groups.get(node) ?? {
          ids: [],
          numbers: [],
          top: Math.max(paperRect.top, rect.top) - parentRect.top,
        };
        group.ids.push(attachment.id);
        group.numbers.push(number);
        groups.set(node, group);
      }
      const next = { scope, marks: [...groups.values()], unlocated };
      setLayout((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    measure();
    return observeWorkspaceQuoteLayout(paper, parent, measure);
  }, [container, pending, revision, scope, visible]);
  if (!visible || pending.length === 0) return null;
  const current = layout.scope === scope ? layout : { marks: [], unlocated: 0 };
  return (
    <>
      <output className="shrink-0 px-3 py-1 text-xs text-cafe-secondary">
        {t.pending(pending.length)}
        {current.unlocated ? ` · ${t.unlocated}` : ''}
      </output>
      {current.marks.map((mark) => (
        <span
          role="note"
          key={mark.ids.join(':')}
          data-pending-file-quote={mark.ids.join(':')}
          title={t.pendingPlaces(mark.numbers.join(', '))}
          aria-label={t.pendingPlaces(mark.numbers.join(', '))}
          className="absolute left-2 z-10 max-w-8 whitespace-nowrap rounded border border-cafe-subtle bg-cafe-surface-elevated px-1 text-micro text-cafe-secondary"
          style={{ top: mark.top }}
        >
          {mark.numbers.length === 1 ? mark.numbers[0] : `${mark.numbers[0]}+${mark.numbers.length - 1}`}
        </span>
      ))}
    </>
  );
}
