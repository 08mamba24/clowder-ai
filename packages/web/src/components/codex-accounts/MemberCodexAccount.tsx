'use client';
import { useEffect, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import type { ProfileItem } from '../hub-accounts.types';
import { CodexBindingControl } from './CodexBindingControl';

function accountChoiceLabel(account: ProfileItem, accounts: ProfileItem[]): string {
  if (!accounts.some((other) => other.id !== account.id && other.displayName === account.displayName))
    return account.displayName;
  const identity = account.codex?.identity;
  return identity
    ? `${account.displayName} · ${identity.email ?? '官方账号'} · 工作区 ${identity.workspaceId}`
    : `${account.displayName} · ${account.id}`;
}

export function MemberCodexAccount({ cat, accounts }: { cat: CatData; accounts: ProfileItem[] }) {
  const [open, setOpen] = useState(false);
  const current = accounts.find((account) => account.id === (cat.accountRef ?? 'codex'));
  const [selected, setSelected] = useState(cat.accountRef ?? 'codex');
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!open || !dirty) setSelected(cat.accountRef ?? 'codex');
  }, [cat.accountRef, open, dirty]);
  if (cat.id === 'gpt-pro') return <small>云端独立接入</small>;
  if (cat.clientId !== 'openai' || !cat.cli) return null;
  const available = accounts.filter(
    (account) =>
      account.clientId === 'openai' &&
      (account.authType === 'api_key' ||
        (account.codex ? account.codex.status === 'ready' : account.codexLoginStatus === 'ready')),
  );
  return (
    <fieldset
      className="mt-2 text-sm"
      data-testid={`member-account-${cat.id}`}
      aria-label={`${cat.nickname || cat.displayName}账号绑定`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="member-button"
        onClick={() => {
          setDirty(false);
          setOpen(!open);
        }}
      >
        当前绑定：{current ? accountChoiceLabel(current, accounts) : (cat.accountRef ?? '默认 Codex')} · 换账号
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <select
            aria-label={`${cat.nickname || cat.displayName}使用账号`}
            value={selected}
            onChange={(e) => {
              setDirty(true);
              setSelected(e.target.value);
            }}
            className="rounded border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-2"
          >
            {available.map((account) => (
              <option key={account.id} value={account.id}>
                {accountChoiceLabel(account, available)}
              </option>
            ))}
          </select>
          {available.some((account) => account.id === selected) && (
            <CodexBindingControl
              accountRef={selected}
              fixedCatId={cat.id}
              reload={async () => {
                setOpen(false);
              }}
            />
          )}
        </div>
      )}
    </fieldset>
  );
}
