import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Lease handoff to the guarded gh read carrier, scoped to one member process.
 *
 * ZCode member processes retire with their lease (AcpServiceFactory sets
 * retireAfterLease), so the process and its attempt are one lifecycle. The
 * adapter writes the attempt's GitHub read lease next to the process's own
 * generated provider input (same 0600 runtime directory, removed with the
 * process), and the guarded gh wrapper reads it back from that directory via
 * ZCODE_PERSONAL_PROVIDER_CONFIG_FILE. Overlapping invocations therefore hold
 * disjoint lease files and can never spend each other's capability; a shared
 * file under the isolated HOME must not be reintroduced.
 */
export function zcodeGhReadLeaseFileForProviderConfig(providerConfigPath: string): string {
  return join(dirname(providerConfigPath), 'gh-read-lease.json');
}

export function writeZcodeGhReadLeaseFile(path: string, lease: { url: string; token: string }): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.tmp`;
  writeFileSync(staging, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
  chmodSync(staging, 0o600);
  renameSync(staging, path);
  chmodSync(path, 0o600);
}

/** Adapter-side cleanup when the process rewrites or drops its lease. */
export function clearZcodeGhReadLeaseFile(path: string): void {
  try {
    rmSync(path, { force: true });
    rmSync(`${path}.tmp`, { force: true });
  } catch {
    // Absent or unreadable: nothing to clear.
  }
}
