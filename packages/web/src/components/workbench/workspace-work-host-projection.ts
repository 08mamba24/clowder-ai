import type { ShellPresentation } from '@/components/shell/shell-presentation';
import {
  type ArtifactWorkPresentationState,
  isWorkspaceArtworkFile,
  isWorkspaceFullWindowSurface,
} from './artifact-work-presentation';
import type { WorkbenchLayoutState } from './workbench-contract';

interface WorkspaceWorkHostInput {
  threadId: string | null;
  viewMode: 'single' | 'split';
  isDesktop: boolean;
  statusPanelOpen: boolean;
  rightPanelMode: 'status' | 'workspace' | 'transcript';
  shellPresentation: ShellPresentation;
}

/** Read the existing session for both shells; ownership and invalidation stay in the original controller. */
export function projectWorkspaceWorkHost(
  input: WorkspaceWorkHostInput,
  layout: WorkbenchLayoutState,
  presentation: ArtifactWorkPresentationState,
) {
  const activeSurface = layout.surfaces.find((surface) => surface.id === layout.activeSurfaceId) ?? null;
  const surfaceActive = isWorkspaceFullWindowSurface(activeSurface, input.shellPresentation);
  const hostEligible =
    input.viewMode === 'single' &&
    input.isDesktop &&
    input.statusPanelOpen &&
    input.rightPanelMode === 'workspace' &&
    surfaceActive;
  const sessionMatchesHost =
    presentation.session?.threadId === input.threadId && presentation.session?.surfaceId === activeSurface?.id;
  const fullWindowActive = hostEligible && sessionMatchesHost && presentation.session?.mode === 'full-window';
  return {
    activeSurface,
    surfaceActive,
    hostEligible,
    fullWindowActive,
    // v2 file artwork shares the Artifact ratio; browser previews keep the Chat owner's ratio.
    splitPreferenceActive:
      hostEligible && (isWorkspaceFullWindowSurface(activeSurface, 'classic') || isWorkspaceArtworkFile(activeSurface)),
    suppressCafeSidebar: input.shellPresentation === 'v2' && fullWindowActive,
  };
}
