'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import {
  type WorkspaceDevSurface,
  WorkspaceLauncher,
  type WorkspaceLauncherDestination,
} from '@/components/workspace/WorkspaceLauncher';
import type { LauncherWorkspaceSearch } from '@/components/workspace/WorkspaceLauncherSearch';
import { WorkspaceNowSurface } from '@/components/workspace/WorkspaceNowSurface';
import { WorkspaceHomeV2 } from '@/components/workspace-home/WorkspaceHomeV2';
import { useChatStore } from '@/stores/chatStore';
import { createAgentRunSurface, createFileSurface } from './real-surface-adapters';
import { workspaceHomeDestinationToSurface } from './workspace-home-adapter';

function requiresWorktreeOwner(destination: WorkspaceLauncherDestination): boolean {
  return destination.kind === 'surface' && ['files', 'changes', 'terminal'].includes(destination.id);
}

export function F307WorkspaceHomePage({
  threadId,
  defaultCatId,
  onSelectDevSurface,
  onSelectSurface,
  worktreeId,
  canonicalWorktreeId,
  worktreeLoading = false,
  worktreeError = null,
  openFilePath,
  preview,
  repository,
  rootSelection,
  workspaceSearch,
  workspaceSearchQuery,
}: {
  threadId?: string;
  defaultCatId: string;
  onSelectDevSurface: (surface: WorkspaceDevSurface) => void;
  onSelectSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  worktreeId: string | null;
  canonicalWorktreeId?: string | null;
  worktreeLoading?: boolean;
  worktreeError?: string | null;
  openFilePath: string | null;
  preview: { port?: number; path: string };
  repository?: { name: string; branch: string };
  rootSelection?: WorkspaceSurfaceDescriptor['rootSelection'];
  workspaceSearch?: LauncherWorkspaceSearch;
  /** F307 host restores this transient value after an ordinary Home-origin return. */
  workspaceSearchQuery?: string;
}) {
  const presentation = useShellPresentation();
  const threadTitle = useChatStore((state) => state.threads.find((thread) => thread.id === threadId)?.title);
  const [pendingDestination, setPendingDestination] = useState<WorkspaceLauncherDestination | null>(null);
  const [destinationMessage, setDestinationMessage] = useState<string | null>(null);

  const selectDestination = (destination: WorkspaceLauncherDestination) => {
    // The classic Launcher has already opened the original replay overlay.
    if (presentation === 'classic' && destination.kind === 'action') return;
    const surface = workspaceHomeDestinationToSurface(destination, {
      threadId,
      threadTitle,
      worktreeId,
      canonicalWorktreeId,
      openFilePath,
      preview,
    });
    if (surface) {
      setPendingDestination(null);
      setDestinationMessage(null);
      onSelectSurface(surface);
      return;
    }
    if (!requiresWorktreeOwner(destination)) return;
    if (worktreeLoading) {
      setPendingDestination(destination);
      setDestinationMessage(`正在读取工作区，随后打开${destination.label}…`);
      return;
    }
    setPendingDestination(null);
    setDestinationMessage(worktreeError ?? `当前项目没有可用工作区，暂时无法打开${destination.label}`);
  };

  useEffect(() => {
    if (!pendingDestination) return;
    if (!worktreeId) {
      if (!worktreeLoading) {
        setDestinationMessage(worktreeError ?? `当前项目没有可用工作区，暂时无法打开${pendingDestination.label}`);
        setPendingDestination(null);
      }
      return;
    }
    const surface = workspaceHomeDestinationToSurface(pendingDestination, {
      threadId,
      threadTitle,
      worktreeId,
      canonicalWorktreeId,
      openFilePath,
      preview,
    });
    if (!surface) return;
    setPendingDestination(null);
    setDestinationMessage(null);
    onSelectSurface(surface);
  }, [
    canonicalWorktreeId,
    onSelectSurface,
    openFilePath,
    pendingDestination,
    preview,
    threadId,
    threadTitle,
    worktreeError,
    worktreeId,
    worktreeLoading,
  ]);

  const launcherSearch: LauncherWorkspaceSearch | undefined = workspaceSearch
    ? {
        ...workspaceSearch,
        onOpenResult: (path, line) => {
          workspaceSearch.onOpenResult(path, line);
          if (presentation !== 'v2' && worktreeId)
            onSelectSurface(
              createFileSurface({
                worktreeId,
                path,
                scrollToLine: line,
                navigationOrigin: workspaceSearch.fileNavigationOrigin?.(),
                ...(rootSelection ? { rootSelection } : {}),
              }),
            );
        },
      }
    : undefined;
  const openRunningObject = (execution: ActiveExecutionProjection) => {
    const surface = createAgentRunSurface({ execution });
    if (surface) onSelectSurface(surface);
  };

  // The new shell's home reads the same sources and chooses through the same callbacks above; the classic home below is
  // the other branch and is the markup it always was.
  if (presentation === 'v2') {
    return (
      <WorkspaceHomeV2
        threadId={threadId}
        defaultCatId={defaultCatId}
        worktreeId={worktreeId}
        repository={repository}
        workspaceSearch={launcherSearch}
        workspaceSearchQuery={workspaceSearchQuery}
        destinationMessage={destinationMessage}
        onSelectDevSurface={onSelectDevSurface}
        onSelectDestination={selectDestination}
        onSelectExecution={openRunningObject}
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--console-panel-bg)]" data-testid="f307-workspace-home-page">
      <WorkspaceNowSurface repository={repository} onSelectExecution={openRunningObject} />
      {destinationMessage && (
        <div className="mx-auto w-full max-w-4xl px-5 pt-3">
          <div
            className="rounded-xl border border-cafe-subtle bg-cafe-surface px-4 py-3 text-xs text-cafe-secondary"
            role="status"
            aria-live="polite"
            data-testid="f307-destination-admission-status"
          >
            {destinationMessage}
          </div>
        </div>
      )}
      <WorkspaceLauncher
        threadId={threadId}
        defaultCatId={defaultCatId}
        initialSearchQuery={workspaceSearchQuery}
        onSelectDevSurface={onSelectDevSurface}
        workspaceSearch={launcherSearch}
        onSelectDestination={selectDestination}
      />
    </div>
  );
}
