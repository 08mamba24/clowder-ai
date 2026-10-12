// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { ContextualWorkspaceChrome } from '../../workspace/ContextualWorkspaceChrome';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { F307WorkbenchTabs } from '../F307WorkbenchTabs';
import { createBrowserSurface, createFileSurface } from '../real-surface-adapters';
import { createInitialWorkbenchState } from '../workbench-model';

let host: HTMLDivElement;
let root: Root;
const file = createFileSurface({ worktreeId: 'wt-code', path: 'docs/guide.md' });
const browser = createBrowserSurface({ ownerKey: 'wt-code', port: 5323, path: '/' });
const activate = vi.fn();
let props: ComponentProps<typeof F307WorkbenchTabs>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  writeShellPresentation('v2');
  activate.mockClear();
  const layout = { ...createInitialWorkbenchState(), surfaces: [file, browser], activeSurfaceId: file.id };
  useF307ExperienceWorkbenchStore.setState({ layout, focusSurfaceId: null });
  useChatStore.setState({
    currentThreadId: 'thread-code',
    presentationLock: null,
    workspaceOpenFilePath: 'stale-legacy.md',
    workspaceWorktreeId: 'legacy-worktree',
  });
  props = {
    layout,
    dispatch: useF307ExperienceWorkbenchStore.getState().dispatch,
    onAddSurface: vi.fn(),
    onActivateSurface: activate,
    homeFocused: false,
    isDesktop: true,
    artifactWorkHostAvailable: false,
    mainAreaAttentionSurfaceId: null,
    onEnterMainAreaAttention: vi.fn(),
    onExitMainAreaAttention: vi.fn(),
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  writeShellPresentation('classic');
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState(), focusSurfaceId: null });
  useChatStore.setState({ presentationLock: null });
});

it('keeps typed tabs visible, renders each title once and closes through the original layout owner', () => {
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  const strip = host.querySelector('[data-testid="f307-tab-strip"]');
  expect(strip).not.toBeNull();
  const tab = host.querySelector<HTMLButtonElement>(`[role="tab"][data-tool-surface-id="${file.id}"]`);
  expect(tab?.textContent).toBe('guide.md');
  expect(host.querySelector('[data-testid="v2-workspace-tool-switcher"]')).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="专注当前工具"]')?.click());
  expect(useF307ExperienceWorkbenchStore.getState().focusSurfaceId).toBe(file.id);
  act(() => useF307ExperienceWorkbenchStore.getState().exitFocusMode());
  act(() => host.querySelector<HTMLButtonElement>(`[aria-label="关闭 ${browser.title}"]`)?.click());
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toEqual([file]);
});

it('closes all unpinned tabs without discarding pinned owner descriptors', () => {
  props.layout.pinnedSurfaceIds = [file.id];
  useF307ExperienceWorkbenchStore.setState({ layout: props.layout });
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  act(() => {
    const menu = host.querySelector('[data-testid="v2-more-tabs"]')?.closest('details');
    if (menu) {
      menu.open = true;
      menu.dispatchEvent(new Event('toggle'));
    }
  });
  const closeAll = document.querySelector<HTMLButtonElement>('[data-testid="v2-close-all-tabs"]');
  expect(closeAll).not.toBeNull();
  act(() => closeAll?.click());
  const result = useF307ExperienceWorkbenchStore.getState().layout;
  expect(result.surfaces).toEqual([file]);
  expect(result.pinnedSurfaceIds).toEqual([file.id]);
  expect(result.recentlyClosed).toContainEqual(browser);
});

it('lets the user pin the active inline preview without forcing it into the overflow menu', () => {
  props.layout.previewSurfaceId = file.id;
  useF307ExperienceWorkbenchStore.setState({ layout: props.layout });
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  const pin = host.querySelector<HTMLButtonElement>(`[aria-label="固定 ${file.title}"]`);
  expect(pin).not.toBeNull();
  act(() => pin?.click());
  const state = useF307ExperienceWorkbenchStore.getState().layout;
  expect(state.pinnedSurfaceIds).toContain(file.id);
  expect(state.previewSurfaceId).toBeNull();
  expect(state.surfaces).toEqual([file, browser]);
});

it('closes other unpinned tabs using the existing bulk action and keeps the current one', () => {
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  act(() => {
    const menu = host.querySelector('[data-testid="v2-more-tabs"]')?.closest('details');
    if (menu) {
      menu.open = true;
      menu.dispatchEvent(new Event('toggle'));
    }
  });
  const closeOthers = document.querySelector<HTMLButtonElement>('[data-testid="v2-close-other-tabs"]');
  expect(closeOthers).not.toBeNull();
  act(() => closeOthers?.click());
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toEqual([file]);
});

it('returns an expanded tab to its original sidebar before detaching it', () => {
  props.mainAreaAttentionSurfaceId = file.id;
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  const close = host.querySelector<HTMLButtonElement>('[data-testid="v2-close-tab"]');
  expect(close).not.toBeNull();
  act(() => close?.click());
  expect(props.onExitMainAreaAttention).toHaveBeenCalledOnce();
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toEqual([file, browser]);
});

it('keeps the classic tab strip and its original controls', () => {
  writeShellPresentation('classic');
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  expect(host.querySelector('[data-testid="v2-workspace-tool-switcher"]')).toBeNull();
  expect(host.querySelector('[data-testid="f307-tab-strip"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="f307-control-rail"]')).not.toBeNull();
});

it('keeps the mobile host fold action in the single v2 tool header', () => {
  const fold = vi.fn();
  act(() =>
    root.render(
      <ContextualWorkspaceChrome mode="workspace" onFold={fold} showFold>
        <F307WorkbenchTabs {...props} isDesktop={false} />
      </ContextualWorkspaceChrome>,
    ),
  );
  expect(host.querySelector('[data-workspace-chrome-layer="shell"]')?.hasAttribute('hidden')).toBe(true);
  const header = host.querySelector('[data-testid="v2-workspace-chrome"]');
  const close = header?.querySelector<HTMLButtonElement>('[aria-label="收起 Workspace"]');
  if (!close) throw new Error('the original mobile fold action must remain reachable');
  act(() => close.click());
  expect(fold).toHaveBeenCalledOnce();
});

it('locks the current real file from the common tool header and exposes a named unlock action', () => {
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  const lock = host.querySelector<HTMLButtonElement>('[aria-label="锁定视图"]');
  expect(lock).not.toBeNull();
  act(() => lock?.click());
  expect(useChatStore.getState().presentationLock).toMatchObject({
    surfaceId: file.id,
    worktreeId: 'wt-code',
    filePath: 'docs/guide.md',
  });
  expect(host.querySelector('[aria-label="解锁视图"]')?.textContent).toContain('已锁定');
});

it('names the English host action as a fold while preserving the same common header and callback', () => {
  const fold = vi.fn();
  act(() =>
    root.render(
      <ContextualWorkspaceChrome mode="workspace" onFold={fold} showFold>
        <F307WorkbenchTabs {...props} homeFocused />
      </ContextualWorkspaceChrome>,
    ),
  );
  const selector = host.querySelector('[data-testid="v2-workspace-home"]');
  const header = selector?.closest('header');
  act(() => writeShellLanguage('en'));
  expect(host.querySelector('[data-testid="v2-workspace-home"]')).toBe(selector);
  expect(selector?.getAttribute('aria-label')).toBe('Workspace home');
  const collapse = header?.querySelector<HTMLButtonElement>('[aria-label="Collapse Workspace"]');
  expect(collapse).not.toBeNull();
  act(() => collapse?.click());
  expect(fold).toHaveBeenCalledOnce();
});
