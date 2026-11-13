import type { RoutingContextReadModelV1, RoutingSubjectRefV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { reduceRoutingContext } from '../../../../../api/src/domains/routing-context/routing-context-reducer';
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
    const model = exhaustedWithConstraint('unavailable');
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

function exhaustedWithConstraint(state: 'unavailable' | 'degraded' | 'scarce', until = now + 10_000) {
  const { model, capacity } = quotaModel();
  capacity.windows[0].applicability = 'operator_bound';
  model.signalEvents = [
    {
      v: 1,
      eventId: 'independent',
      commandId: 'independent',
      ownerId: base.ownerId,
      subjectRef: { type: 'cat', catId: cat.id },
      source: state === 'unavailable' ? 'manual_cvo' : 'health_probe',
      eventType: 'asserted',
      state,
      reasonCode: 'provider_timeout',
      note: `independent ${state}`,
      observedAt: now - 100,
      validUntil: until,
      evidenceRef: 'fixture:independent',
    },
  ];
  return reproject(model);
}

function reproject(model: RoutingContextReadModelV1, hideSignalReasons = false) {
  if (model.resolution.state !== 'fresh') throw new Error('fresh fixture');
  const binding = model.resolution.snapshot.candidates[0].binding;
  model.resolution = {
    state: 'fresh',
    inputRevisionRef: 'fixture:combined',
    sourceRefs: { signalEventIds: ['independent'], preferenceRevisionIds: [], dossierRevisions: [] },
    snapshot: reduceRoutingContext({
      ownerId: base.ownerId,
      observedAt: now,
      catalogRevision: base.catalogRevision,
      candidates: [binding],
      profiles: [],
      profileDiagnostics: hideSignalReasons
        ? Array.from({ length: 32 }, (_, index) => ({
            catId: cat.id,
            reason: {
              code: 'capability_profile_invalid',
              summary: `diagnostic ${index}`,
              sourceRefs: [`fixture:diagnostic:${index}`],
            },
          }))
        : [],
      signalEvents: model.signalEvents,
      preferenceRevisions: [],
    }),
  };
  return model;
}

describe('quota expiry removes only the quota contribution from the real reducer projection', () => {
  it.each([
    ['degraded', '不稳定'],
    ['scarce', '额度紧张'],
  ] as const)('returns to the still-live %s constraint at the exact quota deadline', (state, label) => {
    const model = exhaustedWithConstraint(state);
    expect(memberStatus(cat, model, null, now + 999).label).toBe('不可用');
    const expired = memberStatus(cat, model, null, now + 1000);
    expect(expired.label).toBe(label);
    expect(expired.source).toBe('健康检查');
    expect(expired.detail).toBe(`independent ${state}`);
  });

  it('does not revive an independent constraint whose own deadline has passed', () => {
    const model = exhaustedWithConstraint('degraded', now + 500);
    expect(memberStatus(cat, model, null, now + 1000).label).toBe('未确认');
  });

  it.each([
    ['degraded', '不稳定'],
    ['scarce', '额度紧张'],
    ['unavailable', '不可用'],
  ] as const)('preserves %s when real reducer diagnostics consume the entire reasons budget', (state, label) => {
    const model = reproject(exhaustedWithConstraint(state), true);
    if (model.resolution.state !== 'fresh') throw new Error('fresh fixture');
    const candidate = model.resolution.snapshot.candidates[0];
    expect(candidate.availability).toBe('unavailable');
    expect(candidate.reasons).toHaveLength(32);
    expect(candidate.reasons.flatMap((reason) => reason.sourceRefs)).not.toContain('independent');
    expect(memberStatus(cat, model, null, now + 1000)).toMatchObject({
      label,
      detail: `independent ${state}`,
      source: state === 'unavailable' ? '你手动设置' : '健康检查',
    });
    expect(memberStatus(cat, model, null, now + 10_000).label).toBe('未确认');
  });

  it.each<RoutingSubjectRefV1>([
    { type: 'provider', providerId: 'openai' },
    { type: 'quota_pool', poolId: 'proven-pool' },
  ])('keeps an unreferenced matching $type assertion independently of the reasons summary', (subjectRef) => {
    const model = exhaustedWithConstraint('degraded');
    model.signalEvents[0].subjectRef = subjectRef;
    if (model.resolution.state !== 'fresh') throw new Error('fresh fixture');
    model.resolution.snapshot.candidates[0].binding.provenQuotaPools = [
      { poolId: 'proven-pool', evidenceRef: 'fixture:pool-proof' },
    ];
    reproject(model, true);
    expect(memberStatus(cat, model, null, now + 1000).label).toBe('不稳定');
  });

  it.each<RoutingSubjectRefV1>([
    { type: 'cat', catId: 'other-cat' },
    { type: 'provider', providerId: 'anthropic' },
    { type: 'quota_pool', poolId: 'unproven-pool' },
  ])('does not borrow a $type assertion without an exact binding match', (subjectRef) => {
    const model = exhaustedWithConstraint('unavailable');
    model.signalEvents[0].subjectRef = subjectRef;
    reproject(model, true);
    expect(memberStatus(cat, model, null, now + 1000).label).toBe('未确认');
  });

  it.each(['foreign owner', 'future observation'])('excludes an unreferenced assertion with %s', (invalid) => {
    const model = exhaustedWithConstraint('unavailable');
    if (invalid === 'foreign owner') model.signalEvents[0].ownerId = 'other-owner';
    else model.signalEvents[0].observedAt = now + 2000;
    reproject(model, true);
    expect(memberStatus(cat, model, null, now + 1000).label).toBe('未确认');
  });

  it.each(['retracted', 'recovered'] as const)('does not revive a %s assertion omitted from reasons', (eventType) => {
    const model = exhaustedWithConstraint('degraded');
    model.signalEvents.push({
      v: 1,
      eventId: 'closer',
      commandId: 'closer',
      ownerId: model.ownerId,
      subjectRef: { type: 'cat', catId: cat.id },
      source: 'manual_cvo',
      ...(eventType === 'recovered' ? { eventType, state: 'available' as const } : { eventType }),
      reasonCode: 'closed',
      closesSignalIds: ['independent'],
      observedAt: now,
      evidenceRef: 'fixture:closer',
    });
    reproject(model, true);
    expect(memberStatus(cat, model, null, now + 1000).label).toBe('未确认');
  });

  it('does not apply a future close before its observation time', () => {
    const model = exhaustedWithConstraint('degraded');
    model.signalEvents.push({
      v: 1,
      eventId: 'future-closer',
      commandId: 'future-closer',
      ownerId: model.ownerId,
      subjectRef: { type: 'cat', catId: cat.id },
      source: 'manual_cvo',
      eventType: 'retracted',
      reasonCode: 'closed',
      closesSignalIds: ['independent'],
      observedAt: now + 2000,
      evidenceRef: 'fixture:future-closer',
    });
    reproject(model, true);
    expect(memberStatus(cat, model, null, now + 1000).label).toBe('不稳定');
    expect(memberStatus(cat, model, null, now + 2000).label).toBe('未确认');
  });
});
