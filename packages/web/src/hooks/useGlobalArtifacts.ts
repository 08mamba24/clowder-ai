/**
 * F232 Phase B: Fetch the globally aggregated artifacts across all user threads.
 * Backs ArtifactsPanel in "全局" scope mode. Mirrors useThreadArtifacts' shape
 * (AbortController + apiFetch + refetch) for drop-in scope switching.
 */

import type { GlobalArtifactDTO, GlobalArtifactsResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api-client';

type WorkLineage = GlobalArtifactsResponse['workLineage'];

interface GlobalArtifactsPayload {
  artifacts: GlobalArtifactDTO[];
  workLineage: WorkLineage;
  complete: boolean;
}

function parseGlobalArtifactsResponse(body: unknown, requireComplete: boolean): GlobalArtifactsPayload {
  if (body === null || typeof body !== 'object') {
    return { artifacts: [], workLineage: 'unavailable', complete: false };
  }
  const record = body as Record<string, unknown>;
  return {
    artifacts: Array.isArray(record.artifacts) ? (record.artifacts as GlobalArtifactDTO[]) : [],
    workLineage: record.workLineage === 'resolved' ? 'resolved' : 'unavailable',
    complete: typeof record.complete === 'boolean' ? record.complete : !requireComplete,
  };
}

async function fetchGlobalArtifacts(
  path: string,
  signal: AbortSignal,
  requireComplete: boolean,
): Promise<GlobalArtifactsPayload> {
  const res = await apiFetch(path, { signal });
  if (!res.ok) throw new Error(`global artifacts fetch failed: ${res.status}`);
  return parseGlobalArtifactsResponse(await res.json(), requireComplete);
}

interface UseGlobalArtifactsResult {
  artifacts: GlobalArtifactDTO[];
  workLineage: WorkLineage;
  complete: boolean;
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

export interface GlobalArtifactsQuery {
  view: 'recent-works';
  limit: number;
}

export function useGlobalArtifacts(enabled: boolean, query?: GlobalArtifactsQuery): UseGlobalArtifactsResult {
  const [artifacts, setArtifacts] = useState<GlobalArtifactDTO[]>([]);
  const [workLineage, setWorkLineage] = useState<WorkLineage>('unavailable');
  const [complete, setComplete] = useState(true);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const enabledRef = useRef(enabled);

  const requireComplete = query !== undefined;
  const requestPath = query
    ? `/api/artifacts?view=${encodeURIComponent(query.view)}&limit=${encodeURIComponent(String(query.limit))}`
    : '/api/artifacts';

  const refetch = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setError(false);
    setWorkLineage('unavailable');
    try {
      const result = await fetchGlobalArtifacts(requestPath, ac.signal, requireComplete);
      if (!ac.signal.aborted) {
        setArtifacts(result.artifacts);
        setWorkLineage(result.workLineage);
        setComplete(result.complete);
      }
    } catch (err: unknown) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setError(true);
      setArtifacts([]);
      setWorkLineage('unavailable');
      setComplete(false);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [requestPath, requireComplete]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled) {
      refetch();
    } else {
      setArtifacts([]);
      setWorkLineage('unavailable');
      setComplete(true);
      setLoading(false);
      setError(false);
    }
    return () => abortRef.current?.abort();
  }, [enabled, refetch]);

  return { artifacts, workLineage, complete, loading: enabled && (loading || !enabledRef.current), error, refetch };
}
