// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { HomeLiveCard } from '../HomeLiveCard';
import { live, NOW, seed } from './home-fixtures';

const cancel = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useActiveExecutionProjection', () => ({ cancelProjectedExecution: cancel }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ displayName: 'Sol 6.1' }) }) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span data-testid="avatar" /> }));
let host: HTMLDivElement;
let root: Root;
const title = 'F322 公共工作台：一条很长但仍然需要完整看清的真实对话标题';
const execution = { ...live('codex61-sol', 'thread-home-source', title, 'run-live'), startedAt: NOW - 90_000 };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  writeShellLanguage('zh');
  useActiveExecutionStore.getState().reset();
  seed([execution]);
  cancel.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useActiveExecutionStore.getState().reset();
});

it('updates the single live execution clock while leaving the original execution projection intact', () => {
  act(() => root.render(<HomeLiveCard threadId="thread-elsewhere" />));
  const link = host.querySelector<HTMLAnchorElement>('a[href="/thread/thread-home-source"]');
  expect(link?.textContent).toContain('1:30');
  act(() => vi.advanceTimersByTime(60_000));
  expect(link?.textContent).toContain('2:30');
  expect(useActiveExecutionStore.getState().executionsByKey[activeExecutionKey(execution)]).toBe(execution);
});

it('makes the whole text-bearing row a native conversation link with name, clock and separate title', () => {
  act(() => root.render(<HomeLiveCard threadId="thread-elsewhere" onSelectExecution={vi.fn()} />));
  const link = host.querySelector<HTMLAnchorElement>('a[href="/thread/thread-home-source"]');
  expect(link?.textContent).toContain('Sol 6.1');
  expect(link?.textContent).toContain('1:30');
  expect(link?.textContent).toContain(title);
  expect(link?.textContent).not.toContain('打开对话');
  expect(link?.querySelector('button')).toBeNull();
});

it('keeps details and stop as separate named icon actions using the original execution', () => {
  const details = vi.fn();
  act(() => root.render(<HomeLiveCard threadId="thread-elsewhere" onSelectExecution={details} />));
  const open = host.querySelector<HTMLButtonElement>('[data-testid="workspace-open-running-object"]');
  expect(open?.getAttribute('aria-label')).toBe('详情');
  expect(open?.textContent).toBe('›');
  act(() => open?.click());
  expect(details).toHaveBeenCalledWith(execution);
  const stop = host.querySelector<HTMLButtonElement>('[aria-label="Stop codex61-sol live_invocation run-live"]');
  expect(stop?.textContent).toBe('■');
  act(() => stop?.click());
  expect(cancel).toHaveBeenCalledWith(execution);
});

it('marks the current conversation without disabling its native link or losing pending cancellation truth', () => {
  useActiveExecutionStore.setState({ cancelPendingByKey: { [activeExecutionKey(execution)]: true } });
  act(() => root.render(<HomeLiveCard threadId="thread-home-source" onSelectExecution={vi.fn()} />));
  expect(host.querySelector('a[href="/thread/thread-home-source"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="workspace-running-here"]')?.textContent).toBe('当前对话');
  expect(host.querySelectorAll('[data-testid="workspace-running-object"]')).toHaveLength(1);
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Stop codex61-sol live_invocation run-live"]')?.disabled,
  ).toBe(true);
  expect(cancel).not.toHaveBeenCalled();
});
