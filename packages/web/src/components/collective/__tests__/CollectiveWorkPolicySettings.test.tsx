import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectiveWorkPolicySettings } from '../CollectiveWorkPolicySettings';
import type { ParticipationView } from '../use-collective-participation';
import { useCollectiveWorkPolicy } from '../use-collective-work-policy';
import type { CollectiveWorkPolicyBridge } from '../use-collective-work-policy-bridge';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';

const policy = {
  revision: 2,
  ownerHumanId: 'human_12345678',
  decisionMode: 'manual',
  history: [],
  grants: [
    {
      grantRef: 'private-ref',
      grantRevision: 1,
      status: 'active',
      catIds: ['codex-sol'],
      channelIds: ['general'],
      requestingHumanIds: 'channel_members',
      requestKinds: ['guide'],
      expiresAt: null,
      decisionMode: 'automatic',
    },
  ],
};
const view = {
  cats: [{ id: 'codex-sol', displayName: '砚砚', configured: true, eligible: true, supported: true }],
  channelRoutes: { general: { participants: { 'codex-sol': {} } } },
} as unknown as ParticipationView;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
function Harness({ bridge }: { bridge?: CollectiveWorkPolicyBridge }) {
  const state = useCollectiveWorkPolicy('con_12345678', bridge);
  return <CollectiveWorkPolicySettings state={state} view={view} channelId="general" enabled />;
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const local = {
  revision: 2,
  decisionMode: 'manual',
  pendingRevocations: [],
  grants: [{ grantRef: 'private-ref', grantRevision: 1, state: 'active', decisionMode: 'automatic' }],
};
it('shows registered pending adoption distinctly from effective class rules without exposing implementation fields', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      String(url).endsWith('/listening')
        ? { attentionRevision: 0, channelListening: {} }
        : { policy, localAdoption: null },
    ),
  );
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toContain('Service 已登记，等待本机采用');
  expect(container.textContent).toContain('允许此类工作自动接下');
  expect(container.textContent).not.toContain('private-ref');
  expect(container.textContent).not.toMatch(/grant|scope|JSON|Thread/);
  expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('保存'))).toBe(false);
});
it('keeps the prior state while updating and never declares a failed local adoption effective', async () => {
  let resolve: (value: { policyRevision: number }) => void = () => {};
  const command = vi.fn(
    () =>
      new Promise<{ policyRevision: number }>((done) => {
        resolve = done;
      }),
  );
  const acknowledge = vi.fn();
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/adopt')) return response({ code: 'WORK_POLICY_REVISION_CONFLICT' }, 409);
    return response(
      String(url).endsWith('/listening')
        ? { attentionRevision: 0, channelListening: {} }
        : { policy, localAdoption: null },
    );
  });
  await act(async () =>
    root.render(<Harness bridge={{ command, acknowledge } as unknown as CollectiveWorkPolicyBridge} />),
  );
  const radios = container.querySelectorAll<HTMLInputElement>('input[name="collective-work-decision"]');
  await act(async () => radios[0]?.click());
  expect(command).toHaveBeenCalledWith({ kind: 'set_mode', decisionMode: 'automatic' });
  expect(radios[1]?.checked).toBe(true);
  expect(container.textContent).toContain('更新中');
  await act(async () => resolve({ policyRevision: 3 }));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('旧规则已失效');
  expect(acknowledge).not.toHaveBeenCalled();
  expect(container.textContent).toContain('等待本机采用');
});
it('changes only current channel listening and leaves work permissions alone', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      String(url).endsWith('/listening')
        ? { attentionRevision: 4, channelListening: {} }
        : { policy, localAdoption: local },
    ),
  );
  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelectorAll<HTMLInputElement>('input[name="collective-listening"]')[1]?.click());
  const call = vi
    .mocked(apiFetch)
    .mock.calls.find(([url, init]) => String(url).endsWith('/listening') && init?.method === 'POST');
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    channelId: 'general',
    mode: 'all',
    expectedAttentionRevision: 4,
    dutyCatId: 'codex-sol',
  });
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(([url, init]) => String(url).includes('work-policy') && init?.method === 'POST'),
  ).toBe(false);
});

it.each([
  'poll',
  'retry',
] as const)('clears a failed initial read after a successful %s without changing authority', async (via) => {
  let unavailable = true;
  let refresh = () => {};
  vi.spyOn(window, 'setInterval').mockImplementation((callback) => {
    refresh = callback as () => void;
    return 123 as unknown as ReturnType<typeof window.setInterval>;
  });
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    unavailable
      ? response({ code: 'CONNECTOR_OWNER_MISMATCH' }, 403)
      : response(
          String(url).endsWith('/listening')
            ? { attentionRevision: 0, channelListening: {} }
            : { policy: null, localAdoption: null },
        ),
  );
  await act(async () => root.render(<Harness />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('暂时无法读取授权设置');
  unavailable = false;
  await act(async () => {
    if (via === 'poll') refresh();
    else container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
  });
  expect(container.textContent).toContain('尚无授权规则');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('keeps the read error until both policy and listening recover', async () => {
  let listeningUnavailable = true;
  let refresh = () => {};
  vi.spyOn(window, 'setInterval').mockImplementation((callback) => {
    refresh = callback as () => void;
    return 123 as unknown as ReturnType<typeof window.setInterval>;
  });
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).endsWith('/listening')
      ? listeningUnavailable
        ? response({}, 403)
        : response({ attentionRevision: 0, channelListening: {} })
      : response({ policy: null, localAdoption: null }),
  );
  await act(async () => root.render(<Harness />));
  await act(async () => refresh());
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  listeningUnavailable = false;
  await act(async () => refresh());
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('recovers a snapshot failure after a confirmed setting change without claiming that the change failed', async () => {
  let unavailable = false;
  let refresh = () => {};
  vi.spyOn(window, 'setInterval').mockImplementation((callback) => {
    refresh = callback as () => void;
    return 123 as unknown as ReturnType<typeof window.setInterval>;
  });
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    return unavailable
      ? response({}, 503)
      : response(
          String(url).endsWith('/listening')
            ? { attentionRevision: 0, channelListening: {} }
            : { policy, localAdoption: local },
        );
  });
  await act(async () => root.render(<Harness />));
  // Directly exercise a successful mutation whose following reads are unavailable.
  const listening = container.querySelectorAll<HTMLInputElement>('input[name="collective-listening"]');
  vi.mocked(apiFetch).mockImplementationOnce(async () => {
    unavailable = true;
    return response({ attentionRevision: 1, channelListening: { general: { mode: 'all', dutyCatId: 'codex-sol' } } });
  });
  await act(async () => listening[1]?.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('暂时无法读取授权设置');
  unavailable = false;
  await act(async () => refresh());
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
