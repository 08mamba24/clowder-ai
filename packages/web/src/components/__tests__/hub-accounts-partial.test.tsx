import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { HubAccountsTab } from '../HubAccountsTab';
import type { ProfileItem } from '../hub-accounts.types';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () =>
    Response.json({
      projectPath: '/fixture',
      providers: [
        {
          id: 'codex',
          displayName: 'Codex (OAuth)',
          name: 'Codex',
          clientId: 'openai',
          authType: 'oauth',
          kind: 'oauth',
          builtin: true,
          hasApiKey: false,
        },
        {
          id: 'new-codex',
          displayName: '私人',
          name: '私人',
          clientId: 'openai',
          authType: 'oauth',
          kind: 'oauth',
          builtin: false,
          hasApiKey: false,
          codex: {
            kind: 'managed',
            layoutVersion: 1,
            prepared: true,
            credentialHome: '/fixture/private',
            stateRoot: '/fixture/shared',
            sqliteHome: '/fixture/shared',
            status: 'not_logged_in',
          },
        },
        {
          id: 'good',
          name: 'Good account',
          displayName: 'Good account',
          authType: 'api_key',
          kind: 'api_key',
          builtin: false,
          mode: 'api_key',
          models: [],
          hasApiKey: true,
        },
      ],
      unavailableAccounts: [
        {
          accountRef: 'claude',
          state: 'rejected',
          reason: 'account "claude" is divergent between workspace/runtime stores; reconcile before use',
        },
      ],
    }),
  ),
}));
vi.mock('../UnifiedAuthModal', () => ({
  UnifiedAuthModal: ({
    open,
    onCreated,
  }: {
    open: boolean;
    onCreated: (id: string, error: string, profile: ProfileItem) => void;
  }) => (open ? <button onClick={() => onCreated(created.id, '网络请求超时', created)}>fixture create</button> : null),
}));
vi.mock('@/components/useConfirm', () => ({ useConfirm: () => vi.fn() }));
it('shows healthy accounts alongside unavailable account diagnostics', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HubAccountsTab />));
    expect(container.textContent).toContain('Good account');
    expect(container.textContent).toContain('尚未登录');
    expect(container.textContent).not.toContain('查询此账号额度');
    expect(
      [...container.querySelectorAll('button')].filter((b) =>
        /添加账号|新增账户认证|添加 Codex 账号/.test(b.textContent ?? ''),
      ),
    ).toHaveLength(1);
    const list = container.querySelector('[aria-label="Account List"]');
    expect(list?.textContent).toContain('Codex (OAuth)');
    expect(list?.textContent).toContain('私人');
    expect(container.textContent).toContain('claude');
    expect(container.textContent).toContain('divergent');
    expect(container.querySelector('[aria-label="Unavailable Accounts"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Unavailable Accounts"]')?.querySelector('button')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

const created: ProfileItem = {
  id: 'retry',
  name: '私人',
  displayName: '私人',
  clientId: 'openai',
  authType: 'oauth',
  kind: 'oauth',
  builtin: false,
  hasApiKey: false,
  mode: 'subscription',
  createdAt: '',
  updatedAt: '',
  codex: {
    kind: 'managed',
    layoutVersion: 1,
    prepared: true,
    credentialHome: '/fixture/private',
    stateRoot: '/fixture/shared',
    sqliteHome: '/fixture/shared',
    status: 'not_logged_in',
  },
};
it('retry and cancel project mutation results into the list, clear the scoped error and drive polling with hung GETs', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const attempt = {
    id: 'attempt',
    revision: 1,
    ownerBootId: 'boot',
    ownerPid: 1,
    ownerStartedAt: 'fixture',
    credentialHome: '/fixture/attempt',
    createdAt: 1,
    updatedAt: 1,
    state: 'waiting' as const,
  };
  const waiting = { ...created, codex: { ...created.codex!, attempt } };
  const canceled = { ...created, codex: { ...created.codex!, attempt: { ...attempt, state: 'canceled' as const } } };
  const api = vi.mocked(apiFetch);
  api.mockResolvedValueOnce(Response.json({ projectPath: '/fixture', providers: [] }));
  let stale!: (value: Response) => void;
  api.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        stale = resolve;
      }),
  );
  api.mockImplementation(async (path) => {
    if (String(path).endsWith('/start'))
      return Response.json({ accountRef: created.id, codex: waiting.codex, profiles: [waiting] });
    if (String(path).endsWith('/cancel'))
      return Response.json({ accountRef: created.id, codex: canceled.codex, profiles: [canceled] });
    return new Promise<Response>(() => {});
  });
  const polling = vi.spyOn(globalThis, 'setInterval');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const click = async (label: string) =>
    act(async () => {
      const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
      expect(button).toBeTruthy();
      button!.click();
    });
  try {
    await act(async () => root.render(<HubAccountsTab />));
    await click('添加账号');
    await click('fixture create');
    expect(container.textContent).toContain('登录请求未能确认');
    await click('开始官方登录');
    expect(container.textContent).toContain('终端已打开');
    expect(container.textContent).not.toContain('登录请求未能确认');
    expect(container.textContent).not.toContain('开始官方登录');
    expect(polling).toHaveBeenCalledWith(expect.any(Function), 2000);
    await act(async () => stale(Response.json({ projectPath: '/fixture', providers: [created] })));
    expect(container.textContent).toContain('终端已打开');
    await click('取消本次登录');
    expect(container.textContent).toContain('已取消');
    expect(container.textContent).toContain('开始官方登录');
    expect(container.textContent).not.toContain('取消本次登录');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    polling.mockRestore();
    vi.unstubAllGlobals();
  }
});

for (const oldFailure of ['rejected', '503'] as const) {
  it(`a stale ${oldFailure} cannot overwrite a successful retry and fresh reconcile; a current 503 remains visible`, async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const attempt = {
      id: 'new-attempt',
      revision: 2,
      ownerBootId: 'boot',
      ownerPid: 1,
      ownerStartedAt: 'fixture',
      credentialHome: '/fixture/attempt',
      createdAt: 2,
      updatedAt: 2,
      state: 'waiting' as const,
    };
    const waiting = { ...created, codex: { ...created.codex!, attempt } };
    const api = vi.mocked(apiFetch);
    api.mockReset();
    const initial = Response.json({ projectPath: '/fixture', providers: [] });
    let failOld!: () => void;
    const old = new Promise<Response>((resolve, reject) => {
      failOld = () =>
        oldFailure === '503'
          ? resolve(Response.json({ error: 'stale list failed' }, { status: 503 }))
          : reject(new Error('stale list failed'));
    });
    api.mockResolvedValueOnce(initial).mockReturnValueOnce(old);
    let currentFails = false;
    api.mockImplementation(async (path) =>
      String(path).endsWith('/start')
        ? Response.json({ accountRef: created.id, codex: waiting.codex, profiles: [waiting] })
        : currentFails
          ? Response.json({ error: 'current list unavailable' }, { status: 503 })
          : Response.json({ projectPath: '/fixture', providers: [waiting] }),
    );
    const interval = vi.spyOn(globalThis, 'setInterval');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const click = async (label: string) =>
      act(async () => {
        const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
        expect(button).toBeTruthy();
        button!.click();
      });
    try {
      await act(async () => root.render(<HubAccountsTab />));
      await click('添加账号');
      await click('fixture create');
      await click('开始官方登录');
      expect(container.textContent).toContain('终端已打开');
      await act(async () => failOld());
      expect(container.textContent).not.toContain('stale list failed');
      currentFails = true;
      const polling = interval.mock.calls.findLast((call) => call[1] === 2000)?.[0];
      expect(typeof polling).toBe('function');
      if (typeof polling !== 'function') throw new Error('Missing account polling callback');
      await act(async () => polling());
      expect(container.textContent).toContain('current list unavailable');
      currentFails = false;
      await act(async () => polling());
      expect(container.textContent).not.toContain('current list unavailable');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      interval.mockRestore();
      vi.unstubAllGlobals();
    }
  });
}
