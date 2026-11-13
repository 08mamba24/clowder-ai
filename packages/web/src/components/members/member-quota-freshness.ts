import type { RoutingAccountCapacityV1 } from '@cat-cafe/shared';

const MAX_QUOTA_AGE_MS = 120_000;

/** Display deadline only; HTTP/read-model timestamps never renew a quota sample. */
export function quotaObservationDeadline(capacity: RoutingAccountCapacityV1): number {
  return Math.min(
    capacity.validUntil ?? Infinity,
    ...capacity.windows.map((window) => window.resetAt ?? Infinity),
    capacity.observedAt === undefined ? Infinity : capacity.observedAt + MAX_QUOTA_AGE_MS,
  );
}

export function memberQuotaFreshness(capacity: RoutingAccountCapacityV1 | undefined, now: number) {
  if (capacity?.source !== 'usage_monitor') return null;
  if (
    capacity.state === 'unknown' ||
    capacity.observedAt === undefined ||
    capacity.validUntil === undefined ||
    capacity.observedAt > now ||
    capacity.windows.length === 0
  )
    return 'unknown';
  if (capacity.windows.some((window) => window.freshness !== 'fresh')) return 'stale';
  return capacity.state === 'stale' || quotaObservationDeadline(capacity) <= now ? 'stale' : 'fresh';
}
