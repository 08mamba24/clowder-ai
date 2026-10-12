'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface ChangedFile {
  status: string;
  path: string;
}

export interface ChangesDiffData {
  changedFiles: ChangedFile[];
  diff: string;
}

/** Stable error keys; each presentation maps them to its own copy. */
export type ChangesDiffError = 'fetch_failed' | 'network';

export function useChangesDiff(worktreeId: string | null) {
  const [data, setData] = useState<ChangesDiffData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ChangesDiffError | null>(null);

  const refresh = useCallback(async () => {
    if (!worktreeId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/diff?worktreeId=${encodeURIComponent(worktreeId)}`);
      if (!res.ok) {
        setError('fetch_failed');
        return;
      }
      setData(await res.json());
    } catch {
      setError('network');
    } finally {
      setLoading(false);
    }
  }, [worktreeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
