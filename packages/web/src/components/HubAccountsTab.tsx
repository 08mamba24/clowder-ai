'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { CodexAccountCard } from './codex-accounts/CodexAccountCard';
import { CodexQuotaControl } from './codex-accounts/CodexQuotaControl';
import { HubAccountItem } from './HubAccountItem';
import type { AccountsResponse, ProfileItem } from './hub-accounts.types';
import { normalizeBuiltinClientIds, resolveAccountActionId } from './hub-accounts.view';
import { SettingsPrimaryButton, SettingsStatusStrip } from './settings/primitives';
import { type UnifiedAuthEditData, UnifiedAuthModal } from './UnifiedAuthModal';

export function HubAccountsTab() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ accountRef: string; message: string } | null>(null);
  const generation = useRef(0);
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [editTarget, setEditTarget] = useState<UnifiedAuthEditData | undefined>(undefined);

  const fetchAccounts = useCallback(async () => {
    setError(null);
    const observedGeneration = generation.current;
    try {
      const res = await apiFetch('/api/accounts', undefined, { afterCurrentGet: true });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (generation.current === observedGeneration) setError((body.error as string) ?? '加载失败');
        return;
      }
      const body = (await res.json()) as AccountsResponse;
      if (generation.current !== observedGeneration) return;
      setData(body);
      setError(null);
    } catch (error) {
      if (generation.current === observedGeneration) setError(error instanceof Error ? error.message : '网络错误');
    } finally {
      if (generation.current === observedGeneration) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchAccounts();
  }, [fetchAccounts]);

  const callApi = useCallback(async (path: string, init: RequestInit) => {
    const res = await apiFetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error((body.error as string) ?? `请求失败 (${res.status})`);
    }
    return body;
  }, []);

  const handleAuthCreated = useCallback(
    (id: string, loginError?: string, profile?: ProfileItem) => {
      setShowAuthModal(false);
      setEditTarget(undefined);
      generation.current++;
      setActionError(
        loginError
          ? { accountRef: id, message: `账号已创建，登录请求未能确认：${loginError}。请在该条目重试、取消或删除。` }
          : null,
      );
      if (profile)
        setData((current) =>
          current
            ? { ...current, providers: [...current.providers.filter((item) => item.id !== profile.id), profile] }
            : current,
        );
      void fetchAccounts();
      window.dispatchEvent(new CustomEvent('accounts-changed'));
    },
    [fetchAccounts],
  );

  const updateAccounts = useCallback((profiles: ProfileItem[], removedRefs: string[] = []) => {
    generation.current++;
    setData((current) =>
      current
        ? {
            ...current,
            providers: [
              ...current.providers.filter(
                (item) => !removedRefs.includes(item.id) && !profiles.some((profile) => profile.id === item.id),
              ),
              ...profiles,
            ],
          }
        : current,
    );
    setActionError((current) =>
      current &&
      (removedRefs.includes(current.accountRef) || profiles.some((profile) => profile.id === current.accountRef))
        ? null
        : current,
    );
  }, []);
  useEffect(() => {
    if (!actionError) return;
    const account = data?.providers.find((profile) => profile.id === actionError.accountRef);
    if (
      account?.codex?.status === 'ready' ||
      ['waiting', 'success', 'canceled', 'reused'].includes(account?.codex?.attempt?.state ?? '')
    )
      setActionError(null);
  }, [actionError, data]);

  const handleEdit = useCallback((profile: ProfileItem) => {
    setEditTarget({
      id: resolveAccountActionId(profile),
      displayName: profile.displayName,
      baseUrl: profile.baseUrl,
      clientId: profile.clientId,
      authType: profile.authType,
      models: profile.models,
      envVars: profile.envVars,
    });
    setShowAuthModal(true);
  }, []);

  const deleteAccount = useCallback(
    async (accountId: string) => {
      setBusyId(accountId);
      setError(null);
      try {
        await callApi(`/api/accounts/${accountId}`, { method: 'DELETE' });
        void fetchAccounts();
        window.dispatchEvent(new CustomEvent('accounts-changed'));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [callApi, fetchAccounts],
  );

  const displayAccounts = useMemo(() => normalizeBuiltinClientIds(data?.providers ?? []), [data?.providers]);
  const builtinAccounts = useMemo(() => displayAccounts.filter((a) => a.builtin), [displayAccounts]);
  const customAccounts = useMemo(() => displayAccounts.filter((a) => !a.builtin), [displayAccounts]);
  const displayCards = useMemo(() => [...builtinAccounts, ...customAccounts], [builtinAccounts, customAccounts]);

  const waiting = displayAccounts.some(
    (account) => account.codex?.attempt && ['preparing', 'queued', 'waiting'].includes(account.codex.attempt.state),
  );
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void fetchAccounts();
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting, fetchAccounts]);

  if (loading) return <SettingsStatusStrip tone="muted">加载中...</SettingsStatusStrip>;
  if (!data) return <SettingsStatusStrip tone="muted">暂无数据</SettingsStatusStrip>;

  return (
    <div className="space-y-4">
      {error && <SettingsStatusStrip tone="error">{error}</SettingsStatusStrip>}
      {actionError && <SettingsStatusStrip tone="error">{actionError.message}</SettingsStatusStrip>}

      {(data.unavailableAccounts?.length ?? 0) > 0 && (
        <div role="group" aria-label="Unavailable Accounts" className="space-y-2">
          <SettingsStatusStrip tone="error">
            以下账户暂不可用，请核对并收敛账户配置后重试。其他账户仍可使用。
          </SettingsStatusStrip>
          {data.unavailableAccounts?.map((account) => (
            <SettingsStatusStrip key={account.accountRef} tone="error">
              <strong>{account.accountRef}</strong>：{account.reason}
            </SettingsStatusStrip>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        <SettingsPrimaryButton
          data-guide-id="accounts.create-form"
          onClick={() => {
            setEditTarget(undefined);
            setActionError(null);
            setShowAuthModal(true);
          }}
        >
          + 添加账号
        </SettingsPrimaryButton>
      </div>

      <div role="group" aria-label="Account List" className="space-y-4" data-guide-id="accounts.account-list">
        {displayCards.map((account) => (
          <div key={account.id} className="space-y-2">
            {account.id === 'codex' && account.builtin && <p className="text-sm text-cafe-muted">原默认 Codex 账号</p>}
            {account.codex ? (
              <CodexAccountCard
                account={account}
                accounts={displayAccounts}
                reload={fetchAccounts}
                onUpdated={updateAccounts}
              />
            ) : (
              <HubAccountItem
                key={account.id}
                profile={account}
                busy={busyId === resolveAccountActionId(account)}
                onDelete={() => deleteAccount(resolveAccountActionId(account))}
                onEdit={handleEdit}
              />
            )}
            {account.clientId === 'openai' && account.authType === 'oauth' && !account.codex && (
              <p className="text-sm text-cafe-muted">
                {account.codexLoginStatus === 'ready' ? '已登录 · 可使用' : '尚未登录 · 未就绪'}
              </p>
            )}
            {account.clientId === 'openai' &&
              !account.codex &&
              (account.authType === 'api_key' || account.codexLoginStatus === 'ready') && (
                <CodexQuotaControl accountRef={account.id} observation={account.quota} reload={fetchAccounts} />
              )}
          </div>
        ))}
      </div>

      <SettingsStatusStrip tone="muted">
        添加账号不会自动改变猫的绑定；保存或登录完成后，再选择需要换绑的成员。
      </SettingsStatusStrip>

      <UnifiedAuthModal
        key={editTarget?.id ?? 'create'}
        open={showAuthModal}
        onClose={() => {
          setShowAuthModal(false);
          setEditTarget(undefined);
        }}
        onCreated={handleAuthCreated}
        editProfile={editTarget}
      />
    </div>
  );
}
