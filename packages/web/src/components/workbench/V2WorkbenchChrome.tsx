'use client';

import { useShellCopy } from '@/components/shell/shell-copy';
import { useWorkspaceHostChromeActions } from '@/components/workspace/ContextualWorkspaceChrome';
import { V2WorkspaceMenu } from '@/components/workspace/V2WorkspaceMenu';
import { useChatStore } from '@/stores/chatStore';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import { F307WorkbenchControlRail } from './F307WorkbenchControlRail';
import type { F307WorkbenchTabsProps } from './F307WorkbenchTabs';
import { V2WorkbenchTabStrip } from './V2WorkbenchTabStrip';
import { workspaceChromeCopy } from './workspace-chrome.shell-copy';
import { lockCurrentWorkspace } from './workspace-presentation-lock';

/** Compact presentation of the existing working set; all topology and focus writes retain their owners. */
export function V2WorkbenchChrome(props: F307WorkbenchTabsProps) {
  const t = useShellCopy(workspaceChromeCopy);
  const actions = useWorkspaceHostChromeActions();
  const locked = useChatStore((state) => state.presentationLock != null);
  const unlock = useChatStore((state) => state.disablePresentationLock);
  const active = props.homeFocused
    ? undefined
    : props.layout.surfaces.find((surface) => surface.id === props.layout.activeSurfaceId);
  return (
    <header
      data-testid="v2-workspace-chrome"
      data-v2-workspace-menu-boundary=""
      className="relative z-30 flex min-h-11 min-w-0 shrink-0 flex-wrap items-center gap-1 border-b border-cafe-subtle bg-cafe-surface px-2 py-1"
    >
      <V2WorkbenchTabStrip props={props} />
      <button
        type="button"
        data-testid="v2-workspace-home"
        aria-label={t.home}
        onClick={props.onAddSurface}
        className="h-8 w-7 shrink-0 rounded-md text-cafe-secondary hover:bg-cafe-surface-sunken"
        aria-pressed={props.homeFocused}
      >
        +
      </button>
      <button
        type="button"
        aria-label={locked ? t.unlock : t.lock}
        title={locked ? t.unlock : t.lock}
        aria-pressed={locked}
        disabled={!active && !locked}
        className="flex h-8 shrink-0 items-center gap-1 rounded-md px-1 text-xs text-cafe-secondary hover:bg-cafe-surface-sunken disabled:opacity-30"
        onClick={locked ? unlock : lockCurrentWorkspace}
      >
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d={locked ? 'M5 7V5a3 3 0 0 1 6 0v2' : 'M5 7V5a3 3 0 0 1 6 0'} />
        </svg>
        {locked && t.locked}
      </button>
      <button
        type="button"
        aria-label={t.focusCurrent}
        title={t.focusCurrent}
        disabled={!active}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-cafe-secondary hover:bg-cafe-surface-sunken disabled:opacity-30"
        onClick={() => {
          if (active) useF307ExperienceWorkbenchStore.getState().enterFocusMode(active.id);
        }}
      >
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4" />
        </svg>
      </button>
      <V2WorkspaceMenu
        width={160}
        trigger="⋯"
        triggerProps={{
          'aria-label': t.more,
          title: t.more,
          className:
            'flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md text-cafe-secondary hover:bg-cafe-surface-sunken',
        }}
      >
        <F307WorkbenchControlRail {...props} />
      </V2WorkspaceMenu>
      {actions?.showFold && (
        <button
          type="button"
          onClick={actions.onFold}
          aria-label={t.fold}
          title={t.fold}
          className="h-8 w-8 shrink-0 rounded-md text-cafe-secondary hover:bg-cafe-surface-sunken"
        >
          ×
        </button>
      )}
    </header>
  );
}
