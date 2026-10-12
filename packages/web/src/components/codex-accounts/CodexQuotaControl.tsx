'use client';
import type { AccountQuotaObservation } from '@cat-cafe/shared';
import { useState } from 'react';
import { SettingsSecondaryButton } from '../settings/primitives';
import { accountRequest } from './account-request';

export function CodexQuotaControl({
  accountRef,
  observation,
  reload,
}: {
  accountRef: string;
  observation?: AccountQuotaObservation;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function query() {
    setBusy(true);
    setError('');
    try {
      await accountRequest(`/api/accounts/${accountRef}/codex/quota`, {});
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法查询额度');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong>账号额度</strong>
        <SettingsSecondaryButton disabled={busy} onClick={() => void query()}>
          {busy ? '正在查询…' : '查询此账号额度'}
        </SettingsSecondaryButton>
      </div>
      {observation?.status === 'ok' ? (
        <ul>
          {observation.items.map((item) => (
            <li key={`${item.poolId ?? ''}:${item.label}`}>
              {item.label}：剩余{' '}
              {Math.max(
                0,
                Math.min(100, item.percentKind === 'remaining' ? item.usedPercent : 100 - item.usedPercent),
              ).toFixed(0)}
              %
              {item.resetsAt
                ? ` · ${new Date(item.resetsAt).toLocaleString()} 重置`
                : item.resetsText
                  ? ` · ${item.resetsText}`
                  : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p>{observation?.error ?? '尚未查询，不代表额度为零'}</p>
      )}
      {observation && (
        <p className="text-[var(--cafe-text-muted)]">
          只读观测 · {new Date(observation.observedAt).toLocaleString()} 更新
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
