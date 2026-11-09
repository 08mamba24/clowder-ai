import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { CatConfig, RoutingAccountCapacityV1, RoutingCapacityFactsV1 } from '@cat-cafe/shared';
import { z } from 'zod';
import type { RoutingExecutionBindingProof } from '../../config/account-routing-capacity.js';
import { resolveAccountStoreTopology } from '../../config/account-store-topology.js';
import { assertSafeTestConfigRead } from '../../config/test-config-write-guard.js';

export const USAGE_MONITOR_MAX_AGE_MS = 120_000;
const identifier = z.string().trim().min(1).max(200);
export const usageMonitorBindingSchema = z
  .object({
    catId: identifier,
    providerId: identifier,
    clientId: identifier,
    modelId: identifier,
    accountRef: identifier.optional(),
    accountRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    accountKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    windows: z.array(z.string().trim().min(1).max(80)).min(1).max(16),
  })
  .strict();
export const usageMonitorConfigSchema = z
  .object({
    version: z.literal(1),
    cachePath: z.string().max(4096).refine(isAbsolute).optional(),
    bindings: z.array(usageMonitorBindingSchema).max(64),
  })
  .strict()
  .refine(
    (config) => new Set(config.bindings.map((binding) => binding.catId)).size === config.bindings.length,
    'Each cat must have exactly one source binding',
  );

const windowSchema = z.object({
  label: z.string().trim().min(1).max(80),
  pct: z.number().finite().min(0).max(100),
  usedPercent: z.number().finite().min(0).max(100).optional(),
  resetAt: z.number().int().nonnegative().optional(),
});
const rowSchema = z.object({
  id: identifier,
  ok: z.boolean(),
  quotaEnforced: z.boolean().default(true),
  observedAt: z.number().int().nonnegative().optional(),
  accountKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  wins: z.array(windowSchema).max(64).default([]),
  quotaWindows: z.array(windowSchema).max(64).optional(),
});
const cacheSchema = z.object({
  schemaVersion: z.number().optional(),
  providers: z.array(z.unknown()).max(64),
});

/** Bounded regular-file reads only: a bad monitor path must not stall a dispatch on a FIFO/device. */
export function readMonitorJson(path: string): { value: unknown; modifiedAt: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('usage_monitor_invalid_file');
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > 1024 * 1024) throw new Error('usage_monitor_file_too_large');
    return { value: JSON.parse(buffer.subarray(0, length).toString('utf8')), modifiedAt: stat.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

const opaque = (scope: string, value: unknown) =>
  `${scope}:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const unknown = (reason: RoutingAccountCapacityV1['reason']): RoutingCapacityFactsV1 => ({
  v: 1,
  current: { state: 'unknown', source: 'usage_monitor', reason, windows: [] },
  switchRequired: [],
});
const windowKind = (label: string) =>
  label === '5h'
    ? ('five_hour' as const)
    : ['7d', 'wk'].includes(label)
      ? ('seven_day' as const)
      : label === 'mo'
        ? ('monthly' as const)
        : ('unknown' as const);

/** The operator attests which source account/pools apply; a dispatch must additionally match its frozen account/model. */
export function readUsageMonitorRouting(input: {
  projectRoot: string;
  configs: Record<string, CatConfig>;
  observedAt: number;
  executionBindings?: readonly RoutingExecutionBindingProof[];
}): Map<string, RoutingCapacityFactsV1> {
  const result = new Map<string, RoutingCapacityFactsV1>();
  const root = resolveAccountStoreTopology(input.projectRoot).primaryRoot;
  assertSafeTestConfigRead(root, 'usage-monitor-routing.read');
  let config: z.infer<typeof usageMonitorConfigSchema>;
  try {
    config = usageMonitorConfigSchema.parse(
      readMonitorJson(join(root, '.cat-cafe', 'usage-monitor-routing.json')).value,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      for (const catId of Object.keys(input.configs)) result.set(catId, unknown('source_unavailable'));
    return result;
  }
  let cache: z.infer<typeof cacheSchema>;
  let modifiedAt: number;
  try {
    const file = readMonitorJson(config.cachePath ?? join(homedir(), '.config', 'usage-monitor', 'usage.json'));
    cache = cacheSchema.parse(file.value);
    modifiedAt = file.modifiedAt;
  } catch {
    for (const binding of config.bindings) result.set(binding.catId, unknown('source_unavailable'));
    return result;
  }
  for (const binding of config.bindings) {
    const cat = input.configs[binding.catId];
    if (!cat) continue;
    result.set(binding.catId, unknown('execution_binding_changed'));
    if (
      cat.clientId !== binding.clientId ||
      cat.defaultModel !== binding.modelId ||
      cat.accountRef !== binding.accountRef
    )
      continue;
    const execution = input.executionBindings?.find((proof) => proof.catId === binding.catId);
    if (
      execution &&
      (execution.providerId !== (cat.provider?.trim() || cat.clientId) ||
        execution.modelId !== binding.modelId ||
        (binding.accountRevision !== undefined && execution.accountRevision !== binding.accountRevision))
    )
      continue;
    const matching = cache.providers.filter(
      (value) => typeof value === 'object' && value !== null && 'id' in value && value.id === binding.providerId,
    );
    const parsed = matching.length === 1 ? rowSchema.safeParse(matching[0]) : undefined;
    if (!parsed?.success) {
      result.set(binding.catId, unknown('no_supported_pool'));
      continue;
    }
    const row = parsed.data;
    if (!row.ok) {
      result.set(binding.catId, unknown('refresh_failed'));
      continue;
    }
    if (row.accountKey && binding.accountKey && row.accountKey !== binding.accountKey) {
      result.set(binding.catId, unknown('principal_unverified'));
      continue;
    }
    const observedAt = cache.schemaVersion === 2 ? row.observedAt : Math.floor(modifiedAt);
    if (observedAt === undefined || observedAt > input.observedAt) {
      result.set(binding.catId, unknown('observation_stale'));
      continue;
    }
    const allWindows = row.quotaWindows ?? row.wins;
    if (
      new Set(allWindows.map((window) => window.label)).size !== allWindows.length ||
      new Set(binding.windows).size !== binding.windows.length
    ) {
      result.set(binding.catId, unknown('no_supported_pool'));
      continue;
    }
    const selected = allWindows.filter((window) => binding.windows.includes(window.label));
    if (selected.length !== binding.windows.length) {
      result.set(binding.catId, unknown('no_supported_pool'));
      continue;
    }
    const validUntil = Math.min(
      observedAt + USAGE_MONITOR_MAX_AGE_MS,
      ...selected.map((window) => window.resetAt ?? Infinity),
    );
    const fresh = input.observedAt < validUntil;
    const bound =
      cache.schemaVersion === 2 &&
      row.accountKey !== undefined &&
      row.accountKey === binding.accountKey &&
      binding.accountRevision !== undefined &&
      execution?.accountRevision === binding.accountRevision &&
      row.quotaEnforced &&
      selected.every((window) => window.usedPercent !== undefined);
    const evidenceRef = opaque('usage-monitor', [binding, row, observedAt]);
    result.set(binding.catId, {
      v: 1,
      current: {
        source: 'usage_monitor',
        state: fresh ? 'fresh' : 'stale',
        ...(!fresh ? { reason: 'observation_stale' as const } : {}),
        evidenceRef,
        observedAt,
        validUntil,
        ...(bound ? { bindingRevision: binding.accountRevision } : {}),
        windows: selected.map((window) => ({
          poolId: opaque('monitor-pool', [binding.providerId, row.accountKey ?? 'unverified', window.label]),
          poolKind: 'unknown',
          label: window.label,
          kind: windowKind(window.label),
          applicability: bound ? 'operator_bound' : 'unknown',
          freshness: fresh ? 'fresh' : 'stale',
          remainingPercent: 100 - (window.usedPercent ?? window.pct),
          ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
        })),
      },
      switchRequired: [],
    });
  }
  return result;
}
