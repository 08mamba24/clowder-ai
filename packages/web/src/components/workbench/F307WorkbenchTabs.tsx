import { useShellPresentation } from '@/components/shell/shell-presentation';
import { F307WorkbenchControlRail } from './F307WorkbenchControlRail';
import { F307WorkbenchTab } from './F307WorkbenchTab';
import { V2WorkbenchChrome } from './V2WorkbenchChrome';
import type { WorkbenchAction, WorkbenchLayoutState } from './workbench-contract';

export interface F307WorkbenchTabsProps {
  layout: WorkbenchLayoutState;
  dispatch: (action: WorkbenchAction) => void;
  onAddSurface: () => void;
  onActivateSurface: () => void;
  homeFocused: boolean;
  isDesktop: boolean;
  artifactWorkHostAvailable: boolean;
  mainAreaAttentionSurfaceId: string | null;
  onEnterMainAreaAttention: (surfaceId: string) => void;
  onExitMainAreaAttention: () => void;
}

export function F307WorkbenchTabs(props: F307WorkbenchTabsProps) {
  const isV2 = useShellPresentation() === 'v2';
  const {
    layout,
    dispatch,
    onAddSurface,
    onActivateSurface,
    homeFocused,
    isDesktop,
    artifactWorkHostAvailable,
    mainAreaAttentionSurfaceId,
    onEnterMainAreaAttention,
    onExitMainAreaAttention,
  } = props;
  if (isV2) return <V2WorkbenchChrome {...props} />;
  return (
    <div
      className="flex min-h-10 shrink-0 items-stretch border-b border-cafe-subtle bg-cafe-surface"
      data-testid="f307-tab-actions"
    >
      <div
        className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto px-2 pt-1.5"
        role="tablist"
        data-testid="f307-tab-strip"
      >
        {layout.surfaces.map((surface, index) => {
          const active = !homeFocused && surface.id === layout.activeSurfaceId;
          return (
            <F307WorkbenchTab
              key={surface.id}
              surface={surface}
              index={index}
              layout={layout}
              active={active}
              dispatch={dispatch}
              onActivateSurface={onActivateSurface}
              returnsFromMainArea={mainAreaAttentionSurfaceId === surface.id}
              onExitMainAreaAttention={onExitMainAreaAttention}
            />
          );
        })}
      </div>
      <F307WorkbenchControlRail
        layout={layout}
        dispatch={dispatch}
        onAddSurface={onAddSurface}
        homeFocused={homeFocused}
        isDesktop={isDesktop}
        artifactWorkHostAvailable={artifactWorkHostAvailable}
        mainAreaAttentionSurfaceId={mainAreaAttentionSurfaceId}
        onEnterMainAreaAttention={onEnterMainAreaAttention}
        onExitMainAreaAttention={onExitMainAreaAttention}
      />
    </div>
  );
}
