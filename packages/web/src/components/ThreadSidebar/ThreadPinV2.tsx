'use client';

import { AppTooltip } from '../AppTooltip';
import { useShellCopy } from '../shell/shell-copy';
import { threadSignalsCopy } from './thread-signals.shell-copy';

/** The same filled mark on pinned Groups and conversations; an empty mark offers pinning. */
export function SidebarPinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3 w-3 shrink-0"
      fill={pinned ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.2"
    >
      <path d="m5 2 6 2-2 2 1 4-3-1-2 3-1-4-2-1zM5 10l-2 4" />
    </svg>
  );
}

/** Calls the existing pin command; the reserved slot remains in layout even while its icon is hidden. */
export function ThreadPinV2({
  id,
  title,
  pinned = false,
  onToggle,
}: {
  id: string;
  title: string;
  pinned?: boolean;
  onToggle?: (id: string, pinned: boolean) => void | Promise<void>;
}) {
  const copy = useShellCopy(threadSignalsCopy);
  if (id === 'default' || (!pinned && !onToggle)) return null;
  const style = { color: pinned ? 'var(--shell-primary)' : 'var(--shell-muted)' };
  if (!onToggle)
    return (
      <span
        role="img"
        aria-label={copy.pinned}
        data-testid="thread-pin-mark"
        className="inline-flex h-5 w-4 flex-none items-center justify-center"
        style={style}
      >
        <SidebarPinIcon pinned />
      </span>
    );
  const label = pinned ? copy.unpin : copy.pin;
  return (
    <AppTooltip label={label} side="right">
      <button
        type="button"
        aria-label={`${label} ${title}`}
        aria-pressed={pinned}
        data-testid="thread-pin-button"
        className={`shell-focusable inline-flex h-5 w-4 flex-none items-center justify-center rounded-sm ${pinned ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'}`}
        style={style}
        onClick={(event) => {
          event.stopPropagation();
          void onToggle(id, !pinned);
        }}
      >
        <SidebarPinIcon pinned={pinned} />
      </button>
    </AppTooltip>
  );
}
