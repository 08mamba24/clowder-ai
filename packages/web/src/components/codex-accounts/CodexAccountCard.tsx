'use client';
import { useState } from 'react';
import type { ProfileItem } from '../hub-accounts.types';
import { SettingsPrimaryButton, SettingsSecondaryButton, SettingsStatusStrip } from '../settings/primitives';
import { useConfirm } from '../useConfirm';
import { accountRequest } from './account-request';
import { CodexBindingControl } from './CodexBindingControl';
import { CodexQuotaControl } from './CodexQuotaControl';

const stateLabel: Record<string, string> = {
  preparing: '正在准备官方登录…',
  queued: '等待前一个登录结束',
  waiting: '终端已打开，请完成官方登录',
  review: '请确认登录身份',
  success: '登录成功',
  reused: '已选择已有账号，未创建重复登录',
  canceled: '已取消',
  interrupted: '登录因服务重启中断',
  failed: '登录未完成',
  timeout: '登录已超时',
  superseded: '已开始新的登录',
};
export function CodexAccountCard({
  account,
  accounts = [],
  reload,
  onUpdated,
}: {
  account: ProfileItem;
  accounts?: ProfileItem[];
  reload: () => Promise<void>;
  onUpdated: (profiles: ProfileItem[], removedRefs?: string[]) => void;
}) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(account.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const metadata = account.codex;
  if (!metadata) return null;
  const attempt = metadata.attempt;
  const duplicate = accounts.find((item) => item.id === attempt?.duplicateAccountRef);
  const reuseAvailable =
    !!attempt?.duplicateAccountRef &&
    (duplicate?.codex ? duplicate.codex.status === 'ready' : duplicate?.codexLoginStatus === 'ready');
  const active = !!attempt && ['preparing', 'queued', 'waiting', 'review'].includes(attempt.state);
  function refresh() {
    void reload().catch(() => setError((current) => current || '列表刷新失败，可以继续重试或取消登录'));
  }
  async function action(name: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      const result = await accountRequest<{ profiles: ProfileItem[] }>(
        `/api/accounts/${account.id}/codex/login/${name}`,
        { attemptId: attempt?.id, ...extra },
      );
      onUpdated(result.profiles);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
      refresh();
    } finally {
      setBusy(false);
    }
  }
  async function rename() {
    setBusy(true);
    setError('');
    try {
      const result = await accountRequest<{ profile: ProfileItem }>(
        `/api/accounts/${account.id}`,
        { displayName: note },
        'PATCH',
      );
      onUpdated([result.profile]);
      setEditing(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '修改失败');
    } finally {
      setBusy(false);
    }
  }
  const identity = metadata.identity;
  const changedIdentity =
    attempt?.identity &&
    identity &&
    (identity.userId !== attempt.identity.userId || identity.workspaceId !== attempt.identity.workspaceId);
  return (
    <article
      className="space-y-3 rounded-lg border border-[var(--console-border-soft)] p-3"
      data-account-id={account.id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
            className="flex gap-2"
          >
            <input
              aria-label="修改账号备注"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={200}
              className="rounded border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-2"
            />
            <SettingsPrimaryButton disabled={busy} type="submit">
              保存
            </SettingsPrimaryButton>
            <SettingsSecondaryButton onClick={() => setEditing(false)}>取消</SettingsSecondaryButton>
          </form>
        ) : (
          <div>
            <h4 className="font-medium">{account.displayName}</h4>
            <small className="text-cafe-muted">Codex · 账号登录</small>
          </div>
        )}
        {!editing && (
          <SettingsSecondaryButton
            onClick={() => {
              setNote(account.displayName);
              setEditing(true);
            }}
          >
            修改备注
          </SettingsSecondaryButton>
        )}
      </div>
      <p className="text-sm text-[var(--cafe-text-muted)]">
        {identity
          ? `${identity.email ?? '已确认官方身份'} · ${identity.planType ?? '订阅类型待查询'} · 工作区 ${identity.workspaceId}`
          : '尚未登录'}{' '}
        ·{' '}
        {metadata.status === 'ready'
          ? '可使用'
          : metadata.status === 'identity_changed'
            ? '登录身份发生变化，请重新确认'
            : '未就绪'}
      </p>
      {error && <SettingsStatusStrip tone="error">{error}</SettingsStatusStrip>}
      {attempt && (
        <div className="space-y-2" role="status">
          <p>
            {stateLabel[attempt.state]}
            {attempt.error
              ? `：${attempt.error === '另一个官方登录正在进行，完成后请重试' ? '上次登录未能启动，请重新打开终端重试' : attempt.error}`
              : ''}
          </p>
          {attempt.state === 'review' && (
            <>
              <p className="text-sm">
                本次登录：{attempt.identity?.email ?? '官方账号'} · 工作区 {attempt.identity?.workspaceId}。
                {attempt.duplicateAccountRef
                  ? `已有相同身份的账号「${duplicate?.displayName ?? attempt.duplicateAccountRef}」，确认后使用已有账号，不新增副本。`
                  : changedIdentity
                    ? '与原账号不同，原账号和绑定保持原样。'
                    : '请确认使用此身份。'}
              </p>
              <SettingsPrimaryButton
                disabled={busy}
                onClick={() =>
                  void action(
                    changedIdentity && !attempt.duplicateAccountRef ? 'create-new' : 'confirm',
                    changedIdentity && !attempt.duplicateAccountRef
                      ? { displayName: `${account.displayName}（新账号）` }
                      : {},
                  )
                }
              >
                {attempt.duplicateAccountRef ? '使用已有账号' : changedIdentity ? '保存为新账号' : '确认身份'}
              </SettingsPrimaryButton>
            </>
          )}
          {active && (
            <SettingsSecondaryButton disabled={busy} onClick={() => void action('cancel')}>
              取消本次登录
            </SettingsSecondaryButton>
          )}
        </div>
      )}
      {attempt?.state === 'reused' && reuseAvailable && attempt.duplicateAccountRef && (
        <div className="space-y-2">
          <p>
            使用已有账号「{duplicate?.displayName ?? attempt.duplicateAccountRef}
            」。原账号和绑定保持原样；如需换绑，请核对影响后确认。
          </p>
          <CodexBindingControl accountRef={attempt.duplicateAccountRef} reload={reload} />
        </div>
      )}
      {attempt?.state === 'reused' && !reuseAvailable && !attempt.error && (
        <p className="text-sm">此前复用的账号已不可用，请重新登录或选择其他账号。</p>
      )}
      {!active && (
        <SettingsSecondaryButton disabled={busy} onClick={() => void action('start')}>
          {identity ? '重新登录此账号' : '开始官方登录'}
        </SettingsSecondaryButton>
      )}
      {metadata.status === 'ready' && (
        <CodexQuotaControl accountRef={account.id} observation={account.quota} reload={reload} />
      )}
      {metadata.status === 'ready' && <CodexBindingControl accountRef={account.id} reload={reload} />}
      <SettingsSecondaryButton
        disabled={busy}
        onClick={async () => {
          if (
            !(await confirm({
              title: '删除账号条目',
              variant: 'danger',
              confirmLabel: '确认删除',
              message: `确认删除账号「${account.displayName}」的条目？只删除账号登记，文件和登录仍保留，不会注销官方账号。`,
            }))
          )
            return;
          setBusy(true);
          setError('');
          try {
            await accountRequest(`/api/accounts/${account.id}`, {}, 'DELETE');
            onUpdated([], [account.id]);
            refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : '删除失败');
          } finally {
            setBusy(false);
          }
        }}
      >
        删除账号条目
      </SettingsSecondaryButton>
    </article>
  );
}
