'use client';

import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRoutingContext } from './routing-context-client';

export interface RoutingContextQueryState {
  data: RoutingContextReadModelV1 | null;
  loading: boolean;
  error: string | null;
  /**
   * Resolves to false when the read failed. Callers that just mutated routing truth
   * need this: keeping the previous snapshot on screen is fine, silently presenting
   * it as the post-write state is not.
   */
  refresh: () => Promise<boolean>;
}

export function useRoutingContext(): RoutingContextQueryState {
  const [data, setData] = useState<RoutingContextReadModelV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reader = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const refresh = useCallback(() => reader.current(), []);

  useEffect(() => {
    let mounted = true;
    let generation = 0;
    let active: Promise<boolean> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastActivation = document.visibilityState === 'hidden' ? -Infinity : Date.now();
    const controllers = new Set<AbortController>();
    const visible = () => document.visibilityState !== 'hidden';
    const clearTimer = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clearTimer();
      if (mounted && visible()) timer = setTimeout(() => void read(false), 60_000);
    };
    const read = (afterCurrentGet: boolean): Promise<boolean> => {
      if (!mounted) return Promise.resolve(false);
      if (!afterCurrentGet && active) return active;
      clearTimer();
      const current = ++generation;
      const controller = new AbortController();
      controllers.add(controller);
      setLoading(true);
      // Do not clear a prior read error until success: the retained data is still stale.
      const request = fetchRoutingContext(controller.signal, afterCurrentGet ? { afterCurrentGet: true } : undefined)
        .then((next) => {
          if (!mounted || controller.signal.aborted) return false;
          if (current === generation) {
            setData(next);
            setError(null);
          }
          return true;
        })
        .catch((cause: unknown) => {
          if (mounted && current === generation && !controller.signal.aborted)
            setError(cause instanceof Error ? cause.message : 'Routing context 暂时无法读取');
          return false;
        })
        .finally(() => {
          controllers.delete(controller);
          if (mounted && current === generation) {
            active = null;
            setLoading(false);
            schedule();
          }
        });
      active = request;
      return request;
    };
    reader.current = () => read(true);
    const onActivation = () => {
      if (!visible()) {
        clearTimer();
        lastActivation = -Infinity;
        return;
      }
      // Browsers emit visibility and focus together, including after fast local GETs.
      const now = Date.now();
      if (now - lastActivation < 100) return;
      lastActivation = now;
      void read(false);
    };
    document.addEventListener('visibilitychange', onActivation);
    window.addEventListener('focus', onActivation);
    if (visible()) void read(false);
    return () => {
      mounted = false;
      clearTimer();
      document.removeEventListener('visibilitychange', onActivation);
      window.removeEventListener('focus', onActivation);
      for (const controller of controllers) controller.abort();
      reader.current = () => Promise.resolve(false);
    };
  }, []);

  return { data, loading, error, refresh };
}
