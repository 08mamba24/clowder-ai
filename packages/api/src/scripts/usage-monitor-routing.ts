/** Local operator CLI: inspect sanitized quota or generate an explicit binding; never runs the collector. */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAccountStoreTopology } from '../config/account-store-topology.js';
import { loadCatConfig, toAllCatConfigs } from '../config/cat-config-loader.js';
import { freezeExecutionAccountBinding } from '../domains/cats/services/agents/invocation/execution-account-binding.js';
import {
  readMonitorJson,
  usageMonitorBindingSchema,
  usageMonitorConfigSchema,
} from '../domains/routing-context/UsageMonitorRoutingSource.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';

export function usageMonitorRoutingCommand(args: string[]) {
  if (args.includes('--help'))
    return {
      usage:
        'usage-monitor-routing [--cache /absolute/usage.json] [--cat ID --provider ID --windows label,label [--write]]',
      note: 'Without --cat: inspect. Without --write: preview. Bind only the source account and windows used by this cat.',
    };
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const cachePath = resolve(flag('--cache') ?? join(homedir(), '.config', 'usage-monitor', 'usage.json'));
  const file = readMonitorJson(cachePath);
  const raw = file.value as { schemaVersion?: number; providers?: Array<Record<string, unknown>> };
  if (!Array.isArray(raw.providers)) throw new Error('Invalid usage-monitor cache');
  const catId = flag('--cat');
  if (!catId)
    return {
      cachePath,
      schemaVersion: raw.schemaVersion ?? 1,
      providers: raw.providers.map((row) => ({
        id: row.id,
        ok: row.ok,
        observedAt: row.observedAt ?? file.modifiedAt,
        hasAccountKey: typeof row.accountKey === 'string',
        windows: row.quotaWindows ?? row.wins,
      })),
    };
  const providerId = flag('--provider');
  const windows = flag('--windows')
    ?.split(',')
    .map((window) => window.trim())
    .filter(Boolean);
  if (!providerId || !windows?.length) throw new Error('Use --cat ID --provider ID --windows label,label');
  const rows = raw.providers.filter((row) => row.id === providerId);
  if (rows.length !== 1 || rows[0].ok !== true) throw new Error('Provider must have one successful observation');
  const root = resolveAccountStoreTopology(resolveActiveProjectRoot()).primaryRoot;
  const configs = toAllCatConfigs(loadCatConfig());
  const catConfig = configs[catId];
  if (!catConfig) throw new Error('Unknown cat');
  const frozen = freezeExecutionAccountBinding({
    catId,
    catConfig,
    workspace: { usesDefaultWorkspace: true, workingProjectRoot: root },
  });
  const binding = usageMonitorBindingSchema.parse({
    catId,
    providerId,
    windows,
    clientId: catConfig.clientId,
    modelId: catConfig.defaultModel,
    ...(catConfig.accountRef ? { accountRef: catConfig.accountRef } : {}),
    ...(frozen.executionAccount ? { accountRevision: frozen.executionAccount.accountRevision } : {}),
    ...(typeof rows[0].accountKey === 'string' ? { accountKey: rows[0].accountKey } : {}),
  });
  const available = (rows[0].quotaWindows ?? rows[0].wins) as Array<{ label?: string }> | undefined;
  if (!available || windows.some((label) => !available.some((window) => window.label === label)))
    throw new Error('Every selected window must exist in the source observation');
  const configPath = join(root, '.cat-cafe', 'usage-monitor-routing.json');
  let previous: ReturnType<typeof usageMonitorConfigSchema.parse> = { version: 1, bindings: [] };
  try {
    previous = usageMonitorConfigSchema.parse(readMonitorJson(configPath).value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const config = usageMonitorConfigSchema.parse({
    version: 1,
    cachePath,
    bindings: [...previous.bindings.filter((item) => item.catId !== catId), binding],
  });
  if (!args.includes('--write')) return config;
  mkdirSync(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, configPath);
  return {
    configPath,
    catId,
    source: providerId,
    mode: frozen.principalVerified && binding.accountKey ? 'execution_checked' : 'advisory',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(usageMonitorRoutingCommand(process.argv.slice(2)), null, 2) + '\n');
  } catch {
    process.stderr.write('Usage-monitor binding failed; check source, cat, account and window labels.\n');
    process.exitCode = 1;
  }
}
