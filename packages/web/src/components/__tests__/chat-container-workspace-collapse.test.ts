import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';

/**
 * Tests for workspace collapse feature in ChatContainer.
 * Covers: chatBasis clamp [0,80], double-click toggle 0↔50.
 */

/* ---- Mock usePersistedState with real state tracking ---- */
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

const mockStoreState = () => ({
  messages: [],
  isLoading: false,
  hasActiveInvocation: false,
  intentMode: null,
  targetCats: [],
  catStatuses: {},
  catInvocations: {},
  activeInvocations: {},
  addMessage: vi.fn(),
  removeMessage: vi.fn(),
  setLoading: vi.fn(),
  setHasActiveInvocation: vi.fn(),
  setIntentMode: vi.fn(),
  setTargetCats: vi.fn(),
  clearCatStatuses: vi.fn(),
  setCurrentThread: vi.fn(),
  updateThreadTitle: vi.fn(),
  setCurrentGame: vi.fn(),
  currentGame: null,
  viewMode: 'single' as const,
  setViewMode: vi.fn(),
  clearUnread: vi.fn(),
  confirmUnreadAck: vi.fn(),
  armUnreadSuppression: vi.fn(),
  splitPaneThreadIds: [],
  setSplitPaneThreadIds: vi.fn(),
  setSplitPaneTarget: vi.fn(),
  threads: [],
  rightPanelMode: 'workspace',
});

vi.mock('@/stores/chatStore', () => {
  const hook = (selector?: (s: ReturnType<typeof mockStoreState>) => unknown) => {
    const state = mockStoreState();
    return selector ? selector(state) : state;
  };
  return { useChatStore: hook };
});

vi.mock('@/hooks/usePersistedState', () => ({ usePersistedState: usePersistedStateTracked }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => ({ tasks: [], addTask: vi.fn(), updateTask: vi.fn(), clearTasks: vi.fn() }),
}));
vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ cancelInvocation: vi.fn(), syncRooms: vi.fn() }),
}));
vi.mock('@/hooks/useAgentMessages', () => ({
  useAgentMessages: () => ({
    handleAgentMessage: vi.fn(),
    handleStop: vi.fn(),
    resetRefs: vi.fn(),
    resetTimeout: vi.fn(),
  }),
}));
vi.mock('@/hooks/useChatHistory', () => ({
  useChatHistory: () => ({
    handleScroll: vi.fn(),
    scrollContainerRef: { current: null },
    messagesEndRef: { current: null },
    isLoadingHistory: false,
    hasMore: false,
  }),
}));
vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: vi.fn() }),
}));
vi.mock('@/hooks/useAuthorization', () => ({
  useAuthorization: () => ({ pending: [], respond: vi.fn(), handleAuthRequest: vi.fn(), handleAuthResponse: vi.fn() }),
}));
vi.mock('@/hooks/useSplitPaneKeys', () => ({ useSplitPaneKeys: vi.fn() }));
vi.mock('@/hooks/useChatSocketCallbacks', () => ({
  useChatSocketCallbacks: () => ({}),
}));

// Stub child components
vi.mock('@/components/ChatMessage', () => ({ ChatMessage: () => null }));
vi.mock('@/components/ChatInput', () => ({ ChatInput: () => null }));
vi.mock('@/components/ChatContainerHeader', () => ({
  ChatContainerHeader: () => React.createElement('div', { 'data-testid': 'header' }),
}));
vi.mock('@/components/ThreadSidebar', () => ({
  ThreadSidebar: () => null,
}));
vi.mock('@/components/RightStatusPanel', () => ({ RightStatusPanel: () => null }));
vi.mock('@/components/MobileStatusSheet', () => ({
  MobileStatusSheet: () => null,
}));
vi.mock('@/components/ParallelStatusBar', () => ({ ParallelStatusBar: () => null }));
vi.mock('@/components/ThinkingIndicator', () => ({ ThinkingIndicator: () => null }));
vi.mock('@/components/A2ACollapsible', () => ({ A2ACollapsible: () => null }));
vi.mock('@/components/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/components/MessageNavigator', () => ({ MessageNavigator: () => null }));
vi.mock('@/components/MessageActions', () => ({
  MessageActions: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/CatCafeHub', () => ({ CatCafeHub: () => null }));
vi.mock('@/components/SplitPaneView', () => ({ SplitPaneView: () => null }));
vi.mock('@/components/AuthorizationCard', () => ({ AuthorizationCard: () => null }));
vi.mock('@/components/WorkspacePanel', () => ({
  WorkspacePanel: () => React.createElement('div', { 'data-testid': 'workspace-panel' }),
}));

// Track all ResizeHandle props to find the workspace one
const capturedHandles: Array<Record<string, unknown>> = [];
vi.mock('@/components/workspace/ResizeHandle', () => ({
  ResizeHandle: (props: Record<string, unknown>) => {
    capturedHandles.push(props);
    return React.createElement('div', { 'data-testid': 'resize-handle' });
  },
}));

/** Find the workspace horizontal resize handle (last horizontal one rendered). */
function getWorkspaceHandle() {
  const horizontal = capturedHandles.filter((h) => h.direction === 'horizontal');
  return horizontal.at(-1);
}

describe('ChatContainer workspace collapse', () => {
  let container: HTMLDivElement;
  let root: Root;

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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width: 768px'),
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
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders workspace panel when rightPanelMode is workspace', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });
    expect(container.querySelector('[data-testid="workspace-panel"]')).not.toBeNull();
  });

  it('chatBasis default is 50', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });
    expect(persistedState.get('cat-cafe:chatBasis')).toBe(50);
  });

  it('double-clicking horizontal resize handle toggles chatBasis between 0 and 50', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });

    const handle = getWorkspaceHandle();
    const onDoubleClick = handle?.onDoubleClick as (() => void) | undefined;
    expect(typeof onDoubleClick).toBe('function');

    // First: 50 → 0 (collapse, since 50 > 5)
    act(() => {
      onDoubleClick?.();
    });
    expect(persistedState.get('cat-cafe:chatBasis')).toBe(0);

    // Second: 0 → 50 (restore, since 0 <= 5)
    act(() => {
      onDoubleClick?.();
    });
    expect(persistedState.get('cat-cafe:chatBasis')).toBe(50);

    // Third: 50 → 0 (collapse again)
    act(() => {
      onDoubleClick?.();
    });
    expect(persistedState.get('cat-cafe:chatBasis')).toBe(0);
  });

  it('double-click restores to 50 even after intermediate drag to 30', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });

    const handle = getWorkspaceHandle();
    const onDoubleClick = handle?.onDoubleClick as (() => void) | undefined;
    const onResize = handle?.onResize as ((delta: number) => void) | undefined;
    expect(typeof onDoubleClick).toBe('function');
    expect(typeof onResize).toBe('function');

    // Set up offsetWidth on the component's root element so handleHorizontalResize works
    const rootEl = container.firstElementChild as HTMLElement | null;
    if (rootEl) {
      Object.defineProperty(rootEl, 'offsetWidth', { value: 1000, configurable: true });
    }

    // Simulate drag: delta=-200 → pct = -20 → chatBasis = 50 + (-20) = 30
    act(() => {
      onResize?.(-200);
    });
    expect(persistedState.get('cat-cafe:chatBasis')).toBe(30);

    // Double-click: 30 > 5 → collapse to 0
    act(() => {
      onDoubleClick?.();
    });
    expect(persistedState.get('cat-cafe:chatBasis')).toBe(0);

    // Double-click again: 0 <= 5 → restore to 50
    act(() => {
      onDoubleClick?.();
    });
    expect(persistedState.get('cat-cafe:chatBasis')).toBe(50);
  });
});
