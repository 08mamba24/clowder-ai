import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GhReadLease } from '../../../../../../../infrastructure/github/agent-github-read-types.js';

/**
 * Per-attempt handoff of the GitHub read lease to the pooled ZCode member
 * process. The member process outlives attempts, so the lease cannot ride its
 * spawn environment; instead the carrier wrapper reads this file on every gh
 * invocation. The file holds only the loopback query URL and the ephemeral,
 * revocable capability token — never a GitHub credential — and is removed when
 * the attempt releases its lease.
 */
export function zcodeGhReadLeaseFilePath(isolatedHome: string): string {
  return join(isolatedHome, '.cat-cafe-gh-read-lease.json');
}

export function writeZcodeGhReadLeaseFile(isolatedHome: string, lease: GhReadLease): string {
  const path = zcodeGhReadLeaseFilePath(isolatedHome);
  const staging = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(staging, `${JSON.stringify({ url: lease.queryUrl, token: lease.token })}\n`, { mode: 0o600 });
  chmodSync(staging, 0o600);
  renameSync(staging, path);
  chmodSync(path, 0o600);
  return path;
}

/** Remove only the lease this attempt wrote; a newer attempt's file stays. */
export function clearZcodeGhReadLeaseFile(isolatedHome: string, token?: string): void {
  const path = zcodeGhReadLeaseFilePath(isolatedHome);
  try {
    if (token === undefined) {
      rmSync(path, { force: true });
      return;
    }
    let current: unknown;
    try {
      current = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return;
    }
    if (current && typeof current === 'object' && (current as { token?: unknown }).token === token)
      rmSync(path, { force: true });
  } catch {
    // Absent or unreadable: nothing owned by this attempt to clear.
  }
}
