'use client';

import { useEffect, useRef, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { V2WorkspaceMenu } from '@/components/workspace/V2WorkspaceMenu';
import type { F307WorkbenchTabsProps } from './F307WorkbenchTabs';
import { V2WorkbenchTab } from './V2WorkbenchTab';
import { workspaceChromeCopy } from './workspace-chrome.shell-copy';

export function V2WorkbenchTabStrip({ props }: { props: F307WorkbenchTabsProps }) {
  const t = useShellCopy(workspaceChromeCopy);
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  const surfaces = props.layout.surfaces;
  const capacity = width ? Math.max(1, Math.floor((width - 64) / 100)) : surfaces.length;
  const visible = surfaces.slice(0, capacity);
  const active = surfaces.find((surface) => surface.id === props.layout.activeSurfaceId);
  if (active && !visible.includes(active) && visible.length) visible[visible.length - 1] = active;
  const overflow = surfaces.filter((surface) => !visible.includes(surface));
  return (
    <div ref={root} className="flex min-w-[144px] flex-1 items-center gap-1" data-testid="v2-tab-strip-host">
      <div className="flex min-w-0 flex-1" role="tablist" aria-label={t.tabs} data-testid="f307-tab-strip">
        {visible.map((surface) => (
          <V2WorkbenchTab key={surface.id} surface={surface} props={props} />
        ))}
      </div>
      <V2WorkspaceMenu
        width={256}
        trigger={
          <>
            {t.moreTabs(overflow.length)} <span aria-hidden="true">⌄</span>
          </>
        }
        triggerProps={{
          className:
            'list-none cursor-pointer rounded px-1 py-2 text-xs text-cafe-secondary hover:bg-cafe-surface-sunken',
          'data-testid': 'v2-more-tabs',
        }}
      >
        {(close) => (
          <>
            {overflow.map((surface) => (
              <V2WorkbenchTab key={surface.id} surface={surface} props={props} menu onDone={close} />
            ))}
            <button
              type="button"
              data-testid="v2-close-other-tabs"
              disabled={
                !active || !surfaces.some((s) => s.id !== active.id && !props.layout.pinnedSurfaceIds.includes(s.id))
              }
              className="block w-full rounded px-3 py-2 text-left text-xs disabled:opacity-30 hover:bg-cafe-surface-sunken"
              onClick={() => {
                if (active)
                  props.dispatch({
                    type: 'close-other-surfaces',
                    preserveSurfaceId: active.id,
                    entitlement: { kind: 'user', reason: 'bulk-close' },
                  });
                close();
              }}
            >
              {t.closeOthers}
            </button>
            <button
              type="button"
              data-testid="v2-close-all-tabs"
              disabled={!surfaces.some((s) => !props.layout.pinnedSurfaceIds.includes(s.id))}
              className="block w-full rounded px-3 py-2 text-left text-xs disabled:opacity-30 hover:bg-cafe-surface-sunken"
              onClick={() => {
                props.dispatch({ type: 'close-all-unpinned', entitlement: { kind: 'user', reason: 'bulk-close' } });
                close();
              }}
            >
              {t.closeAll}
            </button>
          </>
        )}
      </V2WorkspaceMenu>
    </div>
  );
}
