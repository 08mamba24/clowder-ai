'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsPrimaryButton, SettingsSecondaryButton, SettingsStatusStrip } from '../settings/primitives';
import { accountRequest } from './account-request';

interface Member {
  id: string;
  name: string;
  accountRef: string;
}
interface Preview {
  previewToken: string;
  targets: Array<{ catId: string; name: string; previousAccountRef: string }>;
}
export function CodexBindingControl({
  accountRef,
  reload,
  fixedCatId,
}: {
  accountRef: string;
  reload: () => Promise<void>;
  fixedCatId?: string;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [catId, setCatId] = useState(fixedCatId ?? '');
  const [scope, setScope] = useState('cat');
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    void apiFetch('/api/accounts/codex/members')
      .then(async (response) => {
        if (!response.ok) throw new Error('无法读取成员');
        const data = await response.json();
        if (current) {
          setMembers(data.members);
          if (!fixedCatId) setCatId(data.members[0]?.id ?? '');
        }
      })
      .catch(() => {
        if (current) setError('暂时无法读取成员，请重新打开账号页');
      });
    return () => {
      current = false;
    };
  }, [fixedCatId]);
  async function send(commit: boolean) {
    setBusy(true);
    setError('');
    try {
      const result = await accountRequest<Preview>(
        `/api/accounts/${accountRef}/codex/binding/${commit ? 'commit' : 'preview'}`,
        { catId, scope, ...(commit ? { previewToken: preview?.previewToken } : {}) },
      );
      if (commit) {
        const changed = new Set((result.targets as Preview['targets']).map((target) => target.catId));
        setMembers((current) => current.map((member) => (changed.has(member.id) ? { ...member, accountRef } : member)));
        setPreview(undefined);
        await reload();
        window.dispatchEvent(new CustomEvent('accounts-changed'));
        window.dispatchEvent(new CustomEvent('cat-config-changed'));
      } else setPreview(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : '换绑失败');
      setPreview(undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 border-t border-[var(--console-border-soft)] pt-3">
      {error && <SettingsStatusStrip tone="error">{error}</SettingsStatusStrip>}
      <p className="text-sm text-[var(--cafe-text-muted)]">
        正在使用：
        {members
          .filter((member) => member.accountRef === accountRef)
          .map((member) => member.name)
          .join('、') || '暂无成员'}
      </p>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="换绑成员"
          disabled={busy || !!fixedCatId}
          value={catId}
          onChange={(e) => {
            setCatId(e.target.value);
            setPreview(undefined);
          }}
          className="rounded border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-2"
        >
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
        <select
          aria-label="换绑范围"
          disabled={busy}
          value={scope}
          onChange={(e) => {
            setScope(e.target.value);
            setPreview(undefined);
          }}
          className="rounded border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-2"
        >
          <option value="cat">只换这只猫</option>
          <option value="family">同一本地家族</option>
        </select>
        <SettingsSecondaryButton disabled={busy || !catId} onClick={() => void send(false)}>
          预览换绑
        </SettingsSecondaryButton>
      </div>
      {preview && (
        <div role="status" className="space-y-2 rounded-lg bg-[var(--console-hover-bg)] p-3">
          <p>以下成员下一次调用将使用此账号：</p>
          <ul>
            {preview.targets.map((target) => (
              <li key={target.catId}>
                {target.name} · 原账号 {target.previousAccountRef}
              </li>
            ))}
          </ul>
          <p className="text-sm">
            正在执行的调用和当前实时通话继续使用原账号；原会话和历史记录保留。云端 Pro 不在换绑范围。
          </p>
          <SettingsPrimaryButton disabled={busy} onClick={() => void send(true)}>
            确认换绑
          </SettingsPrimaryButton>
          <SettingsSecondaryButton disabled={busy} onClick={() => setPreview(undefined)}>
            取消
          </SettingsSecondaryButton>
        </div>
      )}
    </div>
  );
}
