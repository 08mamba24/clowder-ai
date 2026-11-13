import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { model as base } from '../../routing-context/__tests__/team-panel-fixtures';
import { memberStatus } from '../member-projection';
import { useMemberClock } from '../useMemberClock';

it('removes a quota warning exactly at collection expiry while the HTTP snapshot stays unchanged', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.setSystemTime(base.observedAt);
  const model = structuredClone(base) as RoutingContextReadModelV1;
  if (model.resolution.state !== 'fresh') throw Error('fresh fixture');
  const candidate = model.resolution.snapshot.candidates[0];
  candidate.reasons = [{ code: 'usage_monitor_quota_low', summary: 'quota low', sourceRefs: [] }];
  candidate.binding.capacityFacts = {
    v: 1,
    current: {
      source: 'usage_monitor',
      state: 'fresh',
      observedAt: base.observedAt - 119_000,
      validUntil: base.observedAt + 1000,
      windows: [
        {
          poolId: 'quota',
          poolKind: 'unknown',
          applicability: 'unknown',
          kind: 'five_hour',
          remainingPercent: 0,
          freshness: 'fresh',
        },
      ],
    },
    switchRequired: [],
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  function Status() {
    return <span>{memberStatus({ id: 'codex-sol' } as CatData, model, null, useMemberClock(model)).label}</span>;
  }
  try {
    act(() => root.render(<Status />));
    expect(container.textContent).toBe('额度紧张');
    act(() => vi.advanceTimersByTime(999));
    expect(container.textContent).toBe('额度紧张');
    act(() => vi.advanceTimersByTime(1));
    expect(container.textContent).toBe('未确认');
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it('uses current time when a slow owner snapshot arrives, then ticks at its deadline', () => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const container = document.createElement('div');
  const root = createRoot(container);
  type Model = Parameters<typeof useMemberClock>[0];
  function Clock({ model }: { model: Model }) {
    return <span>{useMemberClock(model)}</span>;
  }
  try {
    act(() => root.render(<Clock model={null} />));
    expect(container.textContent).toBe('1000');
    vi.setSystemTime(5000);
    const model: Model = {
      signalEvents: [
        {
          v: 1,
          eventId: 'signal',
          commandId: 'command',
          ownerId: 'owner',
          subjectRef: { type: 'cat', catId: 'member' },
          reasonCode: 'weekly_quota_low',
          source: 'quota_probe',
          observedAt: 4000,
          evidenceRef: 'evidence',
          eventType: 'asserted',
          state: 'scarce',
          validUntil: 6000,
        },
      ],
    };
    act(() => root.render(<Clock model={model} />));
    expect(container.textContent).toBe('5000');
    act(() => vi.advanceTimersByTime(1000));
    expect(container.textContent).toBe('6000');
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
  }
});

it('updates a due preference at the actual review deadline without an owner write', () => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const rootNode = document.createElement('div');
  const root = createRoot(rootNode);
  const model = {
    signalEvents: [],
    preferenceRevisions: [
      {
        v: 1 as const,
        ownerId: 'owner',
        preferenceId: 'preference',
        revisionId: 'revision',
        commandId: 'command',
        appliesWhen: {},
        prefer: [{ type: 'cat' as const, catId: 'a' }],
        over: [{ type: 'cat' as const, catId: 'b' }],
        rationale: 'Owner reason',
        evidenceRefs: ['owner-evidence'],
        version: 1,
        validFrom: 100,
        lifecycle: 'active' as const,
        reviewAfter: 2000,
      },
    ],
  };
  function ReviewDue() {
    return <span>{useMemberClock(model) >= 2000 ? 'Review due' : 'Current'}</span>;
  }
  try {
    act(() => root.render(<ReviewDue />));
    expect(rootNode.textContent).toBe('Current');
    act(() => vi.advanceTimersByTime(1000));
    expect(rootNode.textContent).toBe('Review due');
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
