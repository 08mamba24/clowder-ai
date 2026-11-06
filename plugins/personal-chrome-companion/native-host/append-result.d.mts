interface Revisions { helper: string; extension: string; pageAdapter: string; }
export function appendRevisionError(
  expected: Revisions,
  result: { status: string; errorCode?: string; observedRevisions?: Revisions },
): string | undefined;
