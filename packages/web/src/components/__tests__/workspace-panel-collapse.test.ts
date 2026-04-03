import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePanel } from '@/components/WorkspacePanel';

/**
 * Tests for workspace panel file tree collapse feature.
 * Covers: treeBasis clamp [0,80], double-click toggle 0↔40,
 * handleFileSelect does NOT override user's manual ratio.
 */

const persistedState = new Map<string, number>();
const persistedDefaults = new Map<string, number>();

function usePersistedStateTracked(key: string, defaultValue: number) {
  const stored = persistedState.get(key);
  const initial = stored !== undefined ? stored : defaultValue;
  // Store initial value so persistedState.get() works after render
  persistedState.set(key, initial);
  const [value, setValue] = React.useState(initial);

  const set = React.useCallback(
    (v: number | ((prev: number) => number)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? v(prev) : v;
        persistedState.set(key, next);
        return next;
      });
    },
    [key],
  );

  const reset = React.useCallback(() => {
    const d = persistedDefaults.get(key) ?? defaultValue;
    persistedState.set(key, d);
    setValue(d);
  }, [defaultValue, key]);

  persistedDefaults.set(key, defaultValue);

  return [value, set, reset] as const;
}

/* ---- Hoisted mocks ---- */
const mocks = vi.hoisted(() => ({
  useWorkspace: vi.fn(),
  useFileManagement: vi.fn(),
  useChatStore: vi.fn(),
  apiFetch: vi.fn(),
  usePersistedState: vi.fn(),
}));

vi.mock('@/hooks/useWorkspace', () => ({
  useWorkspace: (...args: unknown[]) => mocks.useWorkspace(...args),
}));
vi.mock('@/hooks/useFileManagement', () => ({
  useFileManagement: (...args: unknown[]) => mocks.useFileManagement(...args),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) => mocks.useChatStore(sel),
}));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3004',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('@/hooks/usePersistedState', () => ({
  usePersistedState: usePersistedStateTracked,
}));

vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: () => React.createElement('div', { 'data-testid': 'markdown' }),
}));
vi.mock('@/components/workspace/ChangesPanel', () => ({
  ChangesPanel: () => null,
}));
vi.mock('@/components/workspace/GitPanel', () => ({
  GitPanel: () => null,
}));
vi.mock('@/components/workspace/TerminalTab', () => ({
  TerminalTab: () => null,
}));
vi.mock('@/components/workspace/JsxPreview', () => ({
  JsxPreview: () => null,
}));
vi.mock('@/components/workspace/LinkedRootsManager', () => ({
  LinkedRootsManager: () => null,
  LinkedRootRemoveButton: () => null,
}));
vi.mock('@/components/workspace/CodeViewer', () => ({
  CodeViewer: () => React.createElement('div', { 'data-testid': 'code-viewer' }),
}));
vi.mock('@/components/workspace/FileIcons', () => ({
  FileIcon: () => null,
}));
vi.mock('@/components/workspace/BrowserPanel', () => ({
  BrowserPanel: () => null,
}));

// Track all ResizeHandle props
const capturedHandles: Array<Record<string, unknown>> = [];
vi.mock('@/components/workspace/ResizeHandle', () => ({
  ResizeHandle: (props: Record<string, unknown>) => {
    capturedHandles.push(props);
    return React.createElement('div', { 'data-testid': 'resize-handle' });
  },
}));

// Mock WorkspaceTree to capture onSelect and basisPct
let capturedTreeProps: Record<string, unknown> = {};
vi.mock('@/components/workspace/WorkspaceTree', () => ({
  WorkspaceTree: (props: Record<string, unknown>) => {
    capturedTreeProps = props;
    return React.createElement('div', { 'data-testid': 'tree' });
  },
}));

/* ---- Helpers ---- */
function makeFile(overrides: Record<string, unknown> = {}) {
  return {
    path: 'README.md',
    content: '# Hello World\n',
    sha256: 'abc123',
    size: 42,
    mime: 'text/markdown',
    truncated: false,
    binary: false,
    ...overrides,
  };
}

function setupMocks(fileOverrides: Record<string, unknown> = {}) {
  const file = makeFile(fileOverrides);
  mocks.useWorkspace.mockReturnValue({
    worktrees: [],
    worktreeId: 'wt-123',
    tree: [{ type: 'directory', path: 'src', name: 'src', children: [file] }],
    file,
    loading: false,
    searchLoading: false,
    error: null,
    searchResults: [],
    search: vi.fn(),
    setSearchResults: vi.fn(),
    fetchFile: vi.fn().mockResolvedValue(file),
    fetchTree: vi.fn().mockResolvedValue(void 0),
    fetchSubtree: vi.fn().mockResolvedValue(void 0),
    fetchWorktrees: vi.fn().mockResolvedValue(void 0),
    revealInFinder: vi.fn(),
    expandedPaths: new Set(),
    toggleExpand: vi.fn(),
    createFile: vi.fn().mockResolvedValue(file),
    createDirectory: vi.fn().mockResolvedValue({}),
    deleteItem: vi.fn().mockResolvedValue(void 0),
    renameItem: vi.fn().mockResolvedValue(void 0),
    uploadFile: vi.fn().mockResolvedValue(void 0),
  });
  mocks.useFileManagement.mockReturnValue({
    createFile: vi.fn().mockResolvedValue(file),
    createDir: vi.fn().mockResolvedValue({}),
    deleteItem: vi.fn().mockResolvedValue(void 0),
    renameItem: vi.fn().mockResolvedValue(void 0),
    uploadFile: vi.fn().mockResolvedValue(void 0),
  });
  mocks.useChatStore.mockImplementation((sel: (s: Record<string, unknown>) => unknown) => {
    const state: Record<string, unknown> = {
      workspaceOpenFile: null,
      workspaceOpenFilePath: null,
      workspaceOpenTabs: [],
      setWorkspaceOpenFile: vi.fn(),
      closeWorkspaceTab: vi.fn(),
      setWorkspaceWorktreeId: vi.fn(),
      workspaceOpenFileLine: null,
      setRightPanelMode: vi.fn(),
      setPendingChatInsert: vi.fn(),
      currentThreadId: 'test-thread',
      workspaceEditToken: null,
      workspaceEditTokenExpiry: null,
      setWorkspaceEditToken: vi.fn(),
      pendingPreviewAutoOpen: null,
      consumePreviewAutoOpen: vi.fn(),
      workspaceRevealPath: null,
      setWorkspaceRevealPath: vi.fn(),
      workspaceMode: 'files',
      setWorkspaceMode: vi.fn(),
    };
    return sel(state);
  });
}

function setupCollapseMocks() {
  setupMocks({
    path: 'src/app.tsx',
    content: 'console.log("hello")',
  });
}

/** Get the vertical resize handle (for the tree ↔ file viewer split). */
function getVerticalHandle() {
  return capturedHandles.find((h) => h.direction === 'vertical');
}

describe('WorkspacePanel file tree collapse', () => {
  let container: HTMLDivElement;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ENVIRONMENT?: boolean }).IS_REACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ENVIRONMENT?: boolean }).IS_REACT_ENVIRONMENT;
  });

  beforeEach(() => {
    persistedState.clear();
    persistedDefaults.clear();
    capturedHandles.length = 0;
    capturedTreeProps = {};
    container = document.createElement('div');
    document.body.appendChild(container);
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    act(() => {
      try {
        (container as unknown as { _reactRoot?: { unmount?: () => void } })._reactRoot?.unmount?.();
      } catch {}
      container.remove();
    });
    vi.restoreAllMocks();
  });

  it('treeBasis default is 40', () => {
    setupCollapseMocks();
    const root = createRoot(container);
    act(() => {
      root.render(React.createElement(WorkspacePanel));
    });
    expect(persistedState.get('cat-cafe:treeBasis')).toBe(40);
  });

  it('double-clicking vertical resize handle toggles treeBasis between 0 and 40', () => {
    setupCollapseMocks();
    const root = createRoot(container);
    act(() => {
      root.render(React.createElement(WorkspacePanel));
    });

    const handle = getVerticalHandle();
    const onDoubleClick = handle?.onDoubleClick as (() => void) | undefined;
    expect(typeof onDoubleClick).toBe('function');

    // First: 40 → 0 (collapse, since 40 > 5)
    act(() => {
      onDoubleClick?.();
    });
    expect(persistedState.get('cat-cafe:treeBasis')).toBe(0);

    // Second: 0 → 40 (restore, since 0 <= 5)
    act(() => {
      onDoubleClick?.();
    });
    expect(persistedState.get('cat-cafe:treeBasis')).toBe(40);

    // Third: 40 → 0 (collapse again)
    act(() => {
      onDoubleClick?.();
    });
    expect(persistedState.get('cat-cafe:treeBasis')).toBe(0);
  });

  it('double-click restores to 40 even after intermediate drag to 25', () => {
    setupCollapseMocks();
    const root = createRoot(container);
    act(() => {
      root.render(React.createElement(WorkspacePanel));
    });

    const handle = getVerticalHandle();
    const onDoubleClick = handle?.onDoubleClick as (() => void) | undefined;
    const onResize = handle?.onResize as ((delta: number) => void) | undefined;
    expect(typeof onDoubleClick).toBe('function');
    expect(typeof onResize).toBe('function');

    // Set up offsetHeight on the panel element so handleVerticalResize works
    const panelEl = container.firstElementChild as HTMLElement | null;
    if (panelEl) {
      Object.defineProperty(panelEl, 'offsetHeight', { value: 1000, configurable: true });
    }

    // Simulate drag: delta=-150 → pct = -15 → treeBasis = 40 + (-15) = 25
    act(() => {
      onResize?.(-150);
    });
    expect(persistedState.get('cat-cafe:treeBasis')).toBe(25);

    // Double-click: 25 > 5 → collapse to 0
    act(() => {
      onDoubleClick?.();
    });
    expect(persistedState.get('cat-cafe:treeBasis')).toBe(0);

    // Double-click again: 0 <= 5 → restore to 40
    act(() => {
      onDoubleClick?.();
    });
    expect(persistedState.get('cat-cafe:treeBasis')).toBe(40);
  });

  it('handleFileSelect does NOT override user-set treeBasis', () => {
    setupCollapseMocks();
    const root = createRoot(container);
    act(() => {
      root.render(React.createElement(WorkspacePanel));
    });

    // Simulate user dragging treeBasis via the resize handler
    const handle = getVerticalHandle();
    const onResize = handle?.onResize as ((delta: number) => void) | undefined;
    expect(typeof onResize).toBe('function');

    const panelEl = container.firstElementChild as HTMLElement | null;
    if (panelEl) {
      Object.defineProperty(panelEl, 'offsetHeight', { value: 1000, configurable: true });
    }

    // Drag to ~33: delta=-70 → pct = -7 → treeBasis = 40 + (-7) = 33
    act(() => {
      onResize?.(-70);
    });
    const preSelectBasis = persistedState.get('cat-cafe:treeBasis');
    expect(preSelectBasis).toBe(33);

    // Now trigger file select via the WorkspaceTree onSelect prop
    const onSelect = capturedTreeProps?.onSelect as ((path: string) => void) | undefined;
    expect(typeof onSelect).toBe('function');

    act(() => {
      onSelect?.('src/other.tsx');
    });

    // treeBasis should NOT have changed (no auto-collapse)
    expect(persistedState.get('cat-cafe:treeBasis')).toBe(preSelectBasis);
  });
});
