import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { type RoutingContextQueryState, useRoutingContext } from '../useRoutingContext';
import { model } from './team-panel-fixtures';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('uses the real client to merge concurrent subscribers and queue a causal read after a pending snapshot', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const current = deferred<Response>();
  const trailing = deferred<Response>();
  const snapshots: string[] = [];
  const unexpected: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (String(url).includes('/api/session')) return Promise.resolve(new Response('{}'));
      if (!String(url).endsWith('/api/routing-context/snapshot') || (init?.method ?? 'GET') !== 'GET') {
        unexpected.push(String(url));
        return Promise.reject(new Error('unexpected side effect'));
      }
      snapshots.push(String(url));
      return snapshots.length === 1 ? current.promise : trailing.promise;
    }),
  );
  const states = new Map<string, RoutingContextQueryState>();
  function Probe({ id }: { id: string }) {
    const value = useRoutingContext();
    states.set(id, value);
    return <span>{value.data?.catalogRevision}</span>;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <>
          <Probe id="one" />
          <Probe id="two" />
        </>,
      ),
    );
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    let refreshed!: Promise<boolean>;
    await act(async () => {
      const state = states.get('one');
      if (!state) throw new Error('Probe must be mounted');
      refreshed = state.refresh();
    });
    expect(snapshots).toHaveLength(1);
    await act(async () => {
      current.resolve(new Response(JSON.stringify(model)));
      await vi.waitFor(() => expect(snapshots).toHaveLength(2));
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(states.get('two')?.data).not.toBeNull();
    });
    expect(states.get('one')?.data).toBeNull();
    expect(states.get('two')?.data?.catalogRevision).toBe(model.catalogRevision);
    await act(async () => {
      const next = structuredClone(model);
      next.catalogRevision = 'post-write';
      next.resolution.snapshot.catalogRevision = 'post-write';
      trailing.resolve(new Response(JSON.stringify(next)));
      expect(await refreshed, states.get('one')?.error ?? undefined).toBe(true);
    });
    expect(states.get('one')?.data?.catalogRevision).toBe('post-write');
    expect(snapshots).toHaveLength(2);
    expect(unexpected).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
