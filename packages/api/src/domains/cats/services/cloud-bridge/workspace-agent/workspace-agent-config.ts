/**
 * F247 Workspace Agent (slice 2b): server-side config custody + refreshable
 * adapter resolution.
 *
 * The Workspace Agent access token lives ONLY here: a mode-0600 JSON file
 * under the runtime `.cat-cafe/` state dir (atomic tmp+rename writes), with
 * env vars (CAT_CAFE_WORKSPACE_AGENT_*) as a bootstrap fallback. Projections
 * never return the token — Settings and logs see a presence bit only.
 *
 * Resolution is read-per-use so Settings changes (authorize / re-auth /
 * disable) take effect on the next dispatch without an API restart,
 * mirroring createRefreshablePersonalChromeHostAdapter semantics.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  WorkspaceAgentTriggerHttpAdapter,
  WorkspaceAgentTriggerError,
  type IWorkspaceAgentTriggerAdapter,
} from './workspace-agent-trigger-adapter.js';

const CONFIG_FILENAME = 'workspace-agent.json';
const ENV_TRIGGER_ID = 'CAT_CAFE_WORKSPACE_AGENT_TRIGGER_ID';
const ENV_WORKSPACE_ID = 'CAT_CAFE_WORKSPACE_AGENT_WORKSPACE_ID';
const ENV_TOKEN = 'CAT_CAFE_WORKSPACE_AGENT_TOKEN';

export interface WorkspaceAgentResolvedConfig {
  readonly triggerId: string;
  readonly workspaceId: string;
  readonly token: string;
  /** Where the active config came from — for owner-facing status only. */
  readonly source: 'settings' | 'env';
}

export interface WorkspaceAgentConfigProjection {
  readonly enabled: boolean;
  readonly triggerId: string | null;
  readonly workspaceId: string | null;
  readonly tokenConfigured: boolean;
  readonly source: 'settings' | 'env' | null;
}

export interface WorkspaceAgentConfigStore {
  /** Active config, or null when disabled/unconfigured. Token never logged. */
  resolve(): WorkspaceAgentResolvedConfig | null;
  /** Owner-facing projection — never includes the token value. */
  project(): WorkspaceAgentConfigProjection;
  /** Persist config (Settings). Atomic; preserves token when omitted. */
  save(input: {
    triggerId?: string;
    workspaceId?: string;
    token?: string;
    enabled?: boolean;
  }): WorkspaceAgentConfigProjection;
  /** Disable without losing the stored token (re-enable path). */
  disable(): WorkspaceAgentConfigProjection;
  readonly configPath: string;
}

interface PersistedWorkspaceAgentConfig {
  triggerId: string;
  workspaceId: string;
  token: string;
  enabled: boolean;
  updatedAt: string;
}

export interface WorkspaceAgentConfigDeps {
  readonly projectRoot: string;
  readonly env?: Record<string, string | undefined>;
  readonly logger?: { warn(ctx: object, msg: string): void; info(ctx: object, msg: string): void };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readPersisted(path: string): PersistedWorkspaceAgentConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    if (!isNonEmpty(raw.triggerId) || !isNonEmpty(raw.workspaceId) || !isNonEmpty(raw.token)) return null;
    return {
      triggerId: raw.triggerId,
      workspaceId: raw.workspaceId,
      token: raw.token,
      enabled: raw.enabled !== false,
      updatedAt: isNonEmpty(raw.updatedAt) ? raw.updatedAt : '',
    };
  } catch {
    return null;
  }
}

function atomicWrite(path: string, value: PersistedWorkspaceAgentConfig, logger: WorkspaceAgentConfigDeps['logger']): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  logger?.info({ configPath: path }, 'F247 workspace-agent config persisted (token not logged)');
}

export function createWorkspaceAgentTriggerConfig(deps: WorkspaceAgentConfigDeps): WorkspaceAgentConfigStore {
  const configPath = join(deps.projectRoot, '.cat-cafe', CONFIG_FILENAME);
  const env = deps.env ?? {};
  let cached: PersistedWorkspaceAgentConfig | null | undefined;

  const load = (): PersistedWorkspaceAgentConfig | null => {
    if (cached === undefined) cached = readPersisted(configPath);
    return cached;
  };

  const resolve = (): WorkspaceAgentResolvedConfig | null => {
    const persisted = load();
    if (persisted) {
      // Explicit Settings state owns the outcome: enabled uses the file,
      // disabled suppresses even the env bootstrap (explicit off beats
      // implicit env), and the stored token survives for re-enable.
      if (!persisted.enabled) return null;
      return {
        triggerId: persisted.triggerId,
        workspaceId: persisted.workspaceId,
        token: persisted.token,
        source: 'settings',
      };
    }
    const envTriggerId = env[ENV_TRIGGER_ID];
    const envWorkspaceId = env[ENV_WORKSPACE_ID];
    const envToken = env[ENV_TOKEN];
    if (isNonEmpty(envTriggerId) && isNonEmpty(envWorkspaceId) && isNonEmpty(envToken)) {
      return { triggerId: envTriggerId, workspaceId: envWorkspaceId, token: envToken, source: 'env' };
    }
    return null;
  };

  return {
    configPath,
    resolve,
    project(): WorkspaceAgentConfigProjection {
      const active = resolve();
      if (active) {
        return {
          enabled: true,
          triggerId: active.triggerId,
          workspaceId: active.workspaceId,
          tokenConfigured: true,
          source: active.source,
        };
      }
      const persisted = load();
      return {
        enabled: false,
        triggerId: persisted?.triggerId ?? (isNonEmpty(env[ENV_TRIGGER_ID]) ? env[ENV_TRIGGER_ID]! : null),
        workspaceId: persisted?.workspaceId ?? (isNonEmpty(env[ENV_WORKSPACE_ID]) ? env[ENV_WORKSPACE_ID]! : null),
        tokenConfigured: Boolean(persisted?.token) || isNonEmpty(env[ENV_TOKEN]),
        source: persisted ? 'settings' : isNonEmpty(env[ENV_TOKEN]) ? 'env' : null,
      };
    },
    save(input) {
      const current = load();
      const triggerId = input.triggerId !== undefined ? input.triggerId : current?.triggerId;
      const workspaceId = input.workspaceId !== undefined ? input.workspaceId : current?.workspaceId;
      const token = input.token !== undefined ? input.token : current?.token;
      const enabled = input.enabled !== undefined ? input.enabled : (current?.enabled ?? true);
      if (!isNonEmpty(triggerId) || !isNonEmpty(workspaceId) || !isNonEmpty(token)) {
        throw new WorkspaceAgentTriggerError(
          'WORKSPACE_AGENT_INVALID_CONFIG',
          'triggerId, workspaceId, and token are all required to enable the workspace-agent path',
        );
      }
      const persisted: PersistedWorkspaceAgentConfig = {
        triggerId: triggerId!,
        workspaceId: workspaceId!,
        token: token!,
        enabled,
        updatedAt: new Date().toISOString(),
      };
      atomicWrite(configPath, persisted, deps.logger);
      cached = persisted;
      return this.project();
    },
    disable() {
      const current = load();
      if (!current) return this.project();
      const persisted: PersistedWorkspaceAgentConfig = { ...current, enabled: false, updatedAt: new Date().toISOString() };
      atomicWrite(configPath, persisted, deps.logger);
      cached = persisted;
      return this.project();
    },
  };
}

/**
 * One stable adapter object that re-resolves config on every trigger call —
 * Settings authorize/re-auth/disable apply to the next dispatch immediately.
 */
export function createRefreshableWorkspaceAgentTriggerAdapter(
  config: WorkspaceAgentConfigStore,
): IWorkspaceAgentTriggerAdapter {
  return {
    get triggerId() {
      return config.resolve()?.triggerId ?? '';
    },
    async trigger(args) {
      const current = config.resolve();
      if (!current) {
        throw new WorkspaceAgentTriggerError(
          'WORKSPACE_AGENT_INVALID_CONFIG',
          'Workspace Agent transport is not configured (authorize in Settings or set the env triple)',
        );
      }
      const adapter = new WorkspaceAgentTriggerHttpAdapter({
        triggerId: current.triggerId,
        tokenProvider: () => current.token,
      });
      return adapter.trigger(args);
    },
  };
}

/** Per-dispatch resolver shape consumed by the cloud invoke bridge. */
export type WorkspaceAgentTransportResolver = () => {
  readonly adapter: IWorkspaceAgentTriggerAdapter;
  readonly workspaceId: string;
} | null;
