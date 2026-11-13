import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { model as base } from '../../routing-context/__tests__/team-panel-fixtures';
import { memberStatus } from '../member-projection';

const now = base.observedAt;
const cat = { id: 'codex-sol', roster: { available: true } } as CatData;
function quotaModel() {
  const model = structuredClone(base) as RoutingContextReadModelV1;
  if (model.resolution.state !== 'fresh') throw new Error('fresh fixture');
  const candidate = model.resolution.snapshot.candidates[0];
  candidate.binding.capacityFacts = {
    v: 1,
    current: {
      source: 'usage_monitor',
      state: 'fresh',
      observedAt: now - 119_000,
      validUntil: now + 1000,
      windows: [
        {
          poolId: 'quota',
          poolKind: 'unknown',
          label: '5h',
          kind: 'five_hour',
          remainingPercent: 0,
          freshness: 'fresh',
          applicability: 'unknown',
        },
      ],
    },
    switchRequired: [],
  };
  candidate.reasons = [{ code: 'usage_monitor_quota_low', summary: 'quota low', sourceRefs: ['monitor'] }];
  return { model, candidate, snapshot: model.resolution.snapshot, capacity: candidate.binding.capacityFacts.current };
}

describe('quota display uses collection age rather than HTTP arrival', () => {
  it('stops displaying a quota warning at its exact source expiry', () => {
    const { model } = quotaModel();
    expect(memberStatus(cat, model, null, now + 999).label).toBe('额度紧张');
    const result = memberStatus(cat, model, null, now + 1000);
    expect(result.label).toBe('未确认');
    expect(result.detail).toContain('过期');
  });

  it('does not make an old source fresh just because the HTTP snapshot was generated now', () => {
    const { model, snapshot, capacity } = quotaModel();
    model.observedAt = now + 60_000;
    snapshot.observedAt = now + 60_000;
    capacity.observedAt = now - 121_000;
    capacity.validUntil = now + 60_000;
    expect(memberStatus(cat, model, null, now).label).toBe('未确认');
  });

  it('does not let quota expiry hide an independently unavailable manual state', () => {
    const { model, candidate } = quotaModel();
    candidate.availability = 'unavailable';
    candidate.reasons.unshift({ code: 'routing_signal_unavailable', summary: 'owner paused', sourceRefs: ['owner'] });
    expect(memberStatus(cat, model, null, now + 1000).label).toBe('不可用');
  });

  it('expires quota even when profile diagnostics or an old recovery accompany its reason', () => {
    const { model, candidate } = quotaModel();
    candidate.reasons.unshift({ code: 'routing_signal_recovered', summary: 'earlier recovery', sourceRefs: [] });
    expect(memberStatus(cat, model, null, now + 1000).label).toBe('未确认');
  });

  it('does not present a healthy old quota sample as available after its reset boundary', () => {
    const { model, candidate, capacity } = quotaModel();
    candidate.availability = 'available';
    candidate.reasons = [];
    capacity.windows[0].resetAt = now + 500;
    expect(memberStatus(cat, model, null, now + 500).label).toBe('未确认');
  });

  it('keeps unavailable or future source observations unknown', () => {
    const { model, capacity } = quotaModel();
    capacity.observedAt = now + 1;
    expect(memberStatus(cat, model, null, now).label).toBe('未确认');
    capacity.state = 'unknown';
    expect(memberStatus(cat, model, null, now).label).toBe('未确认');
  });
});
