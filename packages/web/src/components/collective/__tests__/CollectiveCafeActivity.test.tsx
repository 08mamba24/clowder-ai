import type { ComponentProps } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectiveCafeHost } from '../CollectiveCafeHost';
import type { ParticipationView } from '../use-collective-participation';

let view: ParticipationView;
vi.mock('../use-collective-participation', () => ({
  useCollectiveParticipation: () => ({ view }),
  useCollectiveAutoReconcile: vi.fn(),
}));
vi.mock('../use-collective-work-policy', () => ({ useCollectiveWorkPolicy: () => ({}) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span /> }));
const props = {
  connection: { connectionId: 'con_12345678', authorityStatus: 'connected' },
  context: { channelId: 'general', channelIds: ['general'], openCafe: false },
  onOpen: vi.fn(),
} as unknown as ComponentProps<typeof CollectiveCafeHost>;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(props.onOpen).mockReset();
  view = {
    revision: 1,
    published: true,
    reconcileRequired: false,
    cats: ['codex-astra', 'codex6-luna', 'codex61-sol'].map((id) => ({ id, displayName: id })),
    channelRoutes: { general: { participants: { 'codex-astra': {}, 'codex6-luna': {}, 'codex61-sol': {} } } },
    requests: [],
    tasks: [],
  } as unknown as ParticipationView;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const request = (privateThread?: ParticipationView['requests'][number]['privateThread']) =>
  ({
    event: { recipient: { kind: 'agent', agentId: 'codex6-luna' }, location: { channelId: 'general' } },
    messageId: 'msg_12345678',
    delivery: 'routed',
    execution: { stage: 'started' },
    privateThread,
  }) as ParticipationView['requests'][number];

it('links the latest named request to its exact owner thread instead of opening management', async () => {
  view.requests = [request({ id: 'thread /private', title: '私人请求' })];
  await act(async () => root.render(<CollectiveCafeHost {...props} />));
  const link = container.querySelector<HTMLAnchorElement>('section[aria-label="家里近况"] a');
  expect(link?.getAttribute('href')).toBe('/thread/thread%20%2Fprivate');
  expect(link?.textContent).toContain('在私人 Thread 查看');
  // Exercise the rendered action without asking jsdom to navigate.
  link?.addEventListener('click', (event) => event.preventDefault());
  await act(async () => link?.click());
  expect(props.onOpen).not.toHaveBeenCalled();
});

it('opens management explicitly when a request has no confirmed private thread', async () => {
  view.requests = [request()];
  await act(async () => root.render(<CollectiveCafeHost {...props} />));
  expect(container.querySelector('a')).toBeNull();
  expect(container.textContent).toContain('打开我的 Café');
  expect(container.textContent).not.toContain('点开查看');
  await act(async () => container.querySelector<HTMLButtonElement>('section button')?.click());
  expect(props.onOpen).toHaveBeenCalledOnce();
});

it('links a work activity to that task thread rather than another request or management', async () => {
  view.requests = [{ ...request(), event: { ...request().event, recipient: undefined } }];
  view.tasks = [
    {
      id: 'task_1',
      title: '原请求工作',
      threadId: 'work_private',
      status: 'doing',
      revision: 1,
      closure: 'open',
      sourceRefs: ['message:msg_12345678'],
    },
  ];
  await act(async () => root.render(<CollectiveCafeHost {...props} />));
  expect(container.querySelector('section a')?.getAttribute('href')).toBe('/thread/work_private');
  expect(container.textContent).toContain('查看私人工作');
});

it('distinguishes the two-cat preview from the full current channel participation count', async () => {
  await act(async () => root.render(<CollectiveCafeHost {...props} />));
  expect(container.querySelectorAll('section button')).toHaveLength(2);
  expect(container.textContent).toContain('本频道共 3 只猫可回应');
  expect(container.textContent).toContain('此处预览 2 只');
});
