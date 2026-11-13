import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RoutingContextQueryState, useRoutingContext } from '../useRoutingContext';
import { model } from './team-panel-fixtures';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../routing-context-client', () => ({ fetchRoutingContext: mocks.fetch }));

const reads = new Map<string, RoutingContextQueryState>();
function Probe({ id = 'one' }: { id?: string }) {
  const value = useRoutingContext();
  reads.set(id, value);
  return <output>{value.data?.catalogRevision ?? 'loading'}</output>;
}
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('read-only routing snapshot lifecycle', () => {
  let root: Root;
  let host: HTMLDivElement;
  let visibility = 'visible';
  const read = () => {
    const state = reads.get('one');
    if (!state) throw new Error('Probe must be mounted');
    return state;
  };
  const tick = async (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const event = async (kind: 'focus' | 'visibilitychange') =>
    act(async () => {
      (kind === 'focus' ? window : document).dispatchEvent(new Event(kind));
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(model.observedAt);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
    mocks.fetch.mockReset().mockResolvedValue(structuredClone(model));
    reads.clear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reads immediately and every sixty visible seconds', async () => {
    await act(async () => root.render(<Probe />));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(read().data?.catalogRevision).toBe(model.catalogRevision);
    await tick(59_999);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('pauses while hidden and coalesces a visible/focus activation even after a fast response', async () => {
    await act(async () => root.render(<Probe />));
    visibility = 'hidden';
    await event('visibilitychange');
    await tick(180_000);
    await event('focus');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    visibility = 'visible';
    await event('visibilitychange');
    await tick(20);
    await event('focus');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await tick(60_000);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it('does not auto-read a hidden mount until it becomes visible', async () => {
    visibility = 'hidden';
    await act(async () => root.render(<Probe />));
    await tick(120_000);
    expect(mocks.fetch).not.toHaveBeenCalled();
    visibility = 'visible';
    await event('visibilitychange');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes a visible window when it regains focus', async () => {
    await act(async () => root.render(<Probe />));
    await tick(10_000);
    await event('focus');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('cleans up only the unmounted subscriber while another instance keeps polling', async () => {
    await act(async () =>
      root.render(
        <>
          <Probe />
          <Probe id="two" />
        </>,
      ),
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(reads.get('two')?.data).toBe(read().data);
    await tick(60_000);
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
    await act(async () => root.render(<Probe />));
    await tick(60_000);
    expect(mocks.fetch).toHaveBeenCalledTimes(5);
  });

  it('never overlaps automatic requests while a read is pending', async () => {
    const request = pending<RoutingContextReadModelV1>();
    mocks.fetch.mockReturnValue(request.promise);
    await act(async () => root.render(<Probe />));
    await tick(120_000);
    await event('focus');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve(model));
    expect(read().loading).toBe(false);
  });

  it('waits for a post-mutation read instead of reusing an older in-flight snapshot', async () => {
    const older = pending<RoutingContextReadModelV1>();
    const newer = pending<RoutingContextReadModelV1>();
    mocks.fetch.mockReturnValueOnce(older.promise).mockReturnValue(newer.promise);
    await act(async () => root.render(<Probe />));
    let first!: Promise<boolean>, second!: Promise<boolean>;
    await act(async () => {
      first = read().refresh();
      second = read().refresh();
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.fetch.mock.calls.slice(1).every((call) => call[1]?.afterCurrentGet === true)).toBe(true);
    await act(async () => older.resolve(model));
    expect(read().data).toBeNull();
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    await act(async () => newer.resolve({ ...model, catalogRevision: 'after-mutation' }));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(read().data?.catalogRevision).toBe('after-mutation');
  });

  it('resumes immediately after a short hide, even during the activation dedupe window', async () => {
    await act(async () => root.render(<Probe />));
    visibility = 'hidden';
    await event('visibilitychange');
    await tick(10);
    visibility = 'visible';
    await event('visibilitychange');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await event('focus');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('starts the next sixty seconds after a slow request settles', async () => {
    const slow = pending<RoutingContextReadModelV1>();
    mocks.fetch.mockReturnValueOnce(slow.promise);
    await act(async () => root.render(<Probe />));
    await tick(70_000);
    await act(async () => slow.resolve(model));
    await tick(59_999);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the read error visible while a retry is still pending', async () => {
    await act(async () => root.render(<Probe />));
    mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    await tick(60_000);
    const retry = pending<RoutingContextReadModelV1>();
    mocks.fetch.mockReturnValueOnce(retry.promise);
    await tick(60_000);
    expect(read().loading).toBe(true);
    expect(read().error).toBe('offline');
    await act(async () => retry.resolve(model));
    expect(read().error).toBeNull();
  });

  it('keeps prior data with an error and retries at the normal cadence', async () => {
    await act(async () => root.render(<Probe />));
    mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    await tick(60_000);
    expect(read().data?.catalogRevision).toBe(model.catalogRevision);
    expect(read().error).toBe('offline');
    await tick(59_999);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(read().error).toBe(null);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it('aborts on last unmount and ignores late data from that lifecycle', async () => {
    const old = pending<RoutingContextReadModelV1>();
    mocks.fetch.mockReturnValueOnce(old.promise);
    await act(async () => root.render(<Probe />));
    const signal = mocks.fetch.mock.calls[0][0] as AbortSignal;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => root.render(<Probe />));
    await act(async () => old.resolve({ ...model, catalogRevision: 'obsolete' }));
    expect(read().data?.catalogRevision).toBe(model.catalogRevision);
  });

  it('contains StrictMode cleanup without letting its abandoned response win', async () => {
    const old = pending<RoutingContextReadModelV1>();
    mocks.fetch.mockReturnValueOnce(old.promise);
    await act(async () =>
      root.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      ),
    );
    expect((mocks.fetch.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
    await act(async () => old.resolve({ ...model, catalogRevision: 'strict-old' }));
    expect(read().data?.catalogRevision).toBe(model.catalogRevision);
  });
});
