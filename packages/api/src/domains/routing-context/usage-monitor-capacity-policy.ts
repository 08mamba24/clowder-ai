import type { RoutingCandidateBindingV1, RoutingReasonV1 } from '@cat-cafe/shared';

/** Quota observations never recover a health/manual failure. Unverified observations can only advise. */
export function usageMonitorCapacityPolicy(candidate: RoutingCandidateBindingV1, now: number) {
  const capacity = candidate.capacityFacts?.current;
  if (capacity?.source !== 'usage_monitor') return undefined;
  const sourceRefs = [capacity.evidenceRef ?? 'usage-monitor:unavailable'];
  const reason = (code: string, summary: string): RoutingReasonV1 => ({ code, summary, sourceRefs });
  if (
    capacity.state !== 'fresh' ||
    capacity.validUntil === undefined ||
    now >= capacity.validUntil ||
    capacity.windows.length === 0 ||
    capacity.windows.some((window) => window.freshness !== 'fresh')
  )
    return {
      availability: 'unknown' as const,
      freshness: 'stale' as const,
      reasons: [
        reason(
          'usage_monitor_unknown',
          `Quota observation unavailable or stale (${capacity.reason ?? 'expired'}); model availability is unknown`,
        ),
      ],
    };
  const exhausted = capacity.windows.filter((window) => window.remainingPercent === 0);
  if (exhausted.some((window) => window.applicability === 'operator_bound'))
    return {
      availability: 'unavailable' as const,
      freshness: 'fresh' as const,
      reasons: [
        reason('usage_monitor_quota_exhausted', 'An operator-bound quota window for this exact execution is exhausted'),
      ],
      dispatch: { ownerAttemptAllowed: true, automaticRetryAt: capacity.validUntil },
    };
  if (capacity.windows.some((window) => (window.remainingPercent ?? 100) <= 10))
    return {
      availability: 'scarce' as const,
      freshness: 'fresh' as const,
      reasons: [
        reason(
          'usage_monitor_quota_low',
          'A monitored quota window has at most 10% remaining; unverified account/model bindings are advisory',
        ),
      ],
    };
  if (capacity.windows.some((window) => window.applicability === 'unknown'))
    return {
      availability: 'unknown' as const,
      freshness: 'fresh' as const,
      reasons: [
        reason(
          'usage_monitor_binding_unverified',
          'Quota is observed, but the account/model binding for this execution is unverified',
        ),
      ],
    };
  return undefined;
}
