/** A missing page observation is not evidence of an obsolete adapter or of an unsent message. */
export function appendRevisionError(expected, result) {
  if (result.status === 'failed' && result.errorCode?.startsWith('STALE_')) return result.errorCode;
  const observed = result.observedRevisions;
  // Native admission failures precede extension contact and carry no revisions.
  if (!observed) return result.status === 'failed' ? undefined : 'STALE_ADAPTER';
  if (observed.helper !== expected.helper || observed.extension !== expected.extension) return 'STALE_ADAPTER';
  if (observed.pageAdapter === expected.pageAdapter) return undefined;
  if (observed.pageAdapter === 'unobserved' && result.status === 'failed') return undefined;
  return 'STALE_ADAPTER';
}
