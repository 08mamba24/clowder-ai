'use client';

import { useEffect, useRef, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { AppTooltip } from '../AppTooltip';
import { useShellCopy } from '../shell/shell-copy';
import type { AttentionClusterHeaderProps } from './AttentionCluster';
import { SidebarPinIcon } from './ThreadPinV2';
import { CollapsedGroupPresence, SidebarSignalLayout, ThreadSignalPills } from './ThreadRowSignals';
import { threadSignalsCopy } from './thread-signals.shell-copy';

/** The same F277 group, preferences and actions; only its v2 presentation changes. */
export function AttentionClusterHeaderV2({
  cluster,
  members,
  expanded,
  displayTitle,
  onToggle,
  onRename,
  onAdd,
  memberSort,
  onMemberSort,
  onResetMemberSort,
  sortingDisabled = false,
}: AttentionClusterHeaderProps) {
  const copy = useShellCopy(threadSignalsCopy);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(displayTitle);
  const rootRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ime = useIMEGuard();
  const pinned = members.some((member) => member.pinned);
  const mentions = members.filter((member) => member.hasUserMention).length;
  const unread = members.reduce((total, member) => total + member.unreadCount, 0);
  useEffect(() => setName(displayTitle), [displayTitle]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menuOpen]);
  const closeMenu = () => {
    setMenuOpen(false);
    moreRef.current?.focus();
  };
  const actionClass =
    'shell-focusable shell-nav-row block w-full rounded-md px-2 py-1.5 text-left text-xs disabled:opacity-50';
  return (
    <section
      ref={rootRef}
      data-attention-cluster={cluster.anchor}
      data-expanded={expanded}
      data-cluster-segment={expanded ? 'start' : 'only'}
      data-testid="group-header-v2"
      className="group relative mx-2 min-w-0 rounded-lg px-3 py-1.5 text-sm"
      style={{ color: 'var(--shell-body)' }}
    >
      <div className="flex min-w-0 items-center gap-1 leading-5" data-testid="group-title-line">
        <AppTooltip label={displayTitle} side="right" intent="content" onlyWhenTruncated multiline>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={`attention-members-${cluster.rootThreadId}`}
            onClick={onToggle}
            className="shell-focusable flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className={`h-3 w-3 shrink-0 ${expanded ? 'rotate-90' : ''}`}
            >
              <path d="m6 3 5 5-5 5" />
            </svg>
            <span className="truncate font-semibold">{displayTitle}</span>
            {pinned && (
              <span
                data-testid="group-pinned"
                role="img"
                aria-label={copy.pinned}
                className="inline-flex shrink-0"
                style={{ color: 'var(--shell-primary)' }}
              >
                <SidebarPinIcon pinned />
              </span>
            )}
          </button>
        </AppTooltip>
        {expanded && (
          <AppTooltip label={`${members.length} ${copy.conversations}`} side="right" intent="content">
            <span
              role="img"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Focus reveals the full tooltip content.
              tabIndex={0}
              data-testid="group-count"
              aria-label={`${members.length} ${copy.conversations}`}
              className="shell-focusable shrink-0 rounded-sm text-label"
              style={{ color: 'var(--shell-muted)' }}
            >
              {members.length}
            </span>
          </AppTooltip>
        )}
        <AppTooltip label={copy.more} side="right" disabled={menuOpen || editing}>
          <button
            ref={moreRef}
            type="button"
            aria-label={copy.more}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className={`shell-focusable shrink-0 rounded px-0.5 ${menuOpen || editing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100'}`}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor">
              <circle cx="3" cy="8" r="1" />
              <circle cx="8" cy="8" r="1" />
              <circle cx="13" cy="8" r="1" />
            </svg>
          </button>
        </AppTooltip>
      </div>
      {!expanded && (
        <SidebarSignalLayout
          testId="group-status-line"
          presence={<CollapsedGroupPresence members={members} />}
          badges={
            <ThreadSignalPills
              unreadCount={unread}
              hasUserMention={mentions > 0}
              mentionCount={mentions}
              testIdPrefix="group"
            />
          }
        />
      )}
      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={copy.more}
          className="absolute right-0 top-8 z-50 min-w-40 rounded-lg border p-1 shadow-md"
          style={{ background: 'var(--shell-paper)', borderColor: 'var(--shell-hairline)' }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              closeMenu();
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const index =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[index]?.focus();
          }}
        >
          {onAdd && (
            <button
              type="button"
              role="menuitem"
              className={actionClass}
              onClick={() => {
                closeMenu();
                onAdd();
              }}
            >
              {copy.add}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={actionClass}
            onClick={() => {
              setMenuOpen(false);
              setEditing(true);
            }}
          >
            {copy.rename}
          </button>
          {onMemberSort && (
            <fieldset
              aria-label={copy.sort}
              className="mt-1 border-t pt-1"
              style={{ borderColor: 'var(--shell-hairline)' }}
            >
              {(['recent', 'manual', 'running-first'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode === 'recent' ? memberSort === undefined : memberSort === mode}
                  disabled={sortingDisabled || (mode === 'recent' && !onResetMemberSort)}
                  className={actionClass}
                  onClick={() => {
                    closeMenu();
                    if (mode === 'recent') onResetMemberSort?.();
                    else onMemberSort(mode);
                  }}
                >
                  {mode === 'recent' ? copy.recentFirst : mode === 'manual' ? copy.manual : copy.runningFirst}
                </button>
              ))}
            </fieldset>
          )}
        </div>
      )}
      {editing && (
        <form
          className="absolute inset-x-0 top-0 z-50 flex flex-wrap gap-1 rounded-lg border p-2 shadow-md"
          style={{ background: 'var(--shell-paper)', borderColor: 'var(--shell-hairline)' }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setName(displayTitle);
              setEditing(false);
              moreRef.current?.focus();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || ime.isComposing()) return;
            onRename(name);
            setEditing(false);
            moreRef.current?.focus();
          }}
        >
          <input
            ref={inputRef}
            aria-label={copy.name}
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            className="shell-focusable w-full min-w-0 rounded border bg-transparent px-2 py-1"
          />
          <button type="submit" className="shell-focusable rounded px-1 py-1">
            {copy.save}
          </button>
          <button
            type="button"
            className="shell-focusable rounded px-1 py-1"
            onClick={() => {
              onRename(null);
              setEditing(false);
              moreRef.current?.focus();
            }}
          >
            {copy.reset}
          </button>
          <button
            type="button"
            className="shell-focusable rounded px-1 py-1"
            onClick={() => {
              setName(displayTitle);
              setEditing(false);
              moreRef.current?.focus();
            }}
          >
            {copy.cancel}
          </button>
        </form>
      )}
    </section>
  );
}
