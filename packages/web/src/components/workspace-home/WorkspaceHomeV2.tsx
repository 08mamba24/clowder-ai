'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import type { WorkspaceDevSurface, WorkspaceLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import type { LauncherWorkspaceSearch } from '@/components/workspace/WorkspaceLauncherSearch';
import { HomeLiveCard } from './HomeLiveCard';
import { HomeTools } from './HomeTools';
import { HomeWaitCard } from './HomeWaitCard';
import { useChangedFileCount } from './use-changed-file-count';
import { useHomeDestinationSelect } from './use-home-destination';
import './workspace-home-cards.css';
import './workspace-home-tools.css';

/**
 * The Workspace home in the new shell (F322 original-B, home-northstar §1.8 w1 + §1.12 窄栏 1): 正在发生, 等待与接回,
 * then the tool list — one column that reads the same canonical sources as the classic home and chooses the same
 * destinations through the same host callbacks. It is rendered only while the shell presentation is `v2`
 * (`F307WorkspaceHomePage` decides); the classic home is the other branch there and is not touched by anything here.
 *
 * Wide or narrow is the column's own width (container query in `workspace-home-*.css`), because the Workspace is a draggable
 * 20%–80% panel, not a viewport.
 */
export function WorkspaceHomeV2({
  threadId,
  defaultCatId,
  worktreeId,
  repository,
  workspaceSearch,
  workspaceSearchQuery,
  destinationMessage,
  onSelectDevSurface,
  onSelectDestination,
  onSelectExecution,
}: {
  threadId?: string;
  defaultCatId: string;
  worktreeId: string | null;
  repository?: { name: string; branch: string };
  workspaceSearch?: LauncherWorkspaceSearch;
  workspaceSearchQuery?: string;
  /** The host's "opening… / no workspace" admission status for the destination just chosen. */
  destinationMessage: string | null;
  onSelectDevSurface: (surface: WorkspaceDevSurface) => void;
  onSelectDestination: (destination: WorkspaceLauncherDestination) => void;
  onSelectExecution: (execution: ActiveExecutionProjection) => void;
}) {
  const changedFileCount = useChangedFileCount(worktreeId);
  const selectDestination = useHomeDestinationSelect({ onSelectDevSurface, onSelectDestination });

  return (
    <div
      className="home-v2 min-h-0 flex-1 overflow-y-auto"
      data-testid="f307-workspace-home-page"
      data-home-presentation="v2"
    >
      {/* A Host reservation for the floating Cat Ball (F229): it steps out of this column instead of sitting on the rows it
          would hide and catch clicks for. Only this column is reserved, so a wide panel still leaves its margins to the ball. */}
      <div className="home-column">
        <HomeLiveCard threadId={threadId} onSelectExecution={onSelectExecution} />
        <HomeWaitCard />
        {destinationMessage && (
          <output
            className="home-card home-note text-xs"
            aria-live="polite"
            data-testid="f307-destination-admission-status"
          >
            {destinationMessage}
          </output>
        )}
        <HomeTools
          threadId={threadId}
          defaultCatId={defaultCatId}
          repository={repository}
          changedFileCount={changedFileCount}
          workspaceSearch={workspaceSearch}
          initialSearchQuery={workspaceSearchQuery}
          onSelectDestination={selectDestination}
        />
      </div>
    </div>
  );
}
