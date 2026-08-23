import { extractUserEnvTemplates, hasSupportedEnvTemplate, resolveEnvMap } from '../env-map.js';

export interface AcpProcessEnvAccount {
  id: string;
  authType: 'oauth' | 'api_key';
  apiKey?: string;
  baseUrl?: string;
  envVars?: Record<string, string>;
}

export interface PrepareAcpProcessEnvOptions {
  clientId: string;
  provider?: string | null;
  baseModel?: string;
  account?: AcpProcessEnvAccount | null;
}

export type TryPrepareAcpProcessEnvResult =
  | { ok: true; env: Record<string, string> | undefined }
  | { ok: false; error: Error };

export function prepareAcpProcessEnv(options: PrepareAcpProcessEnvOptions): Record<string, string> | undefined {
  const account = options.account ?? null;
  const resolved: Record<string, string> = {};

  if (account?.authType === 'api_key') {
    if (!account.apiKey) {
      throw new Error(
        `account "${account.id}" is configured as api_key but has no API key set — ` +
          'add the key in Hub > account settings',
      );
    }
    const userEnvTemplates = account.envVars ? extractUserEnvTemplates(account.envVars) : undefined;
    // F161 AC-A5 / KD-1: generic ACP (clientId='acp') is a transport, not a provider identity.
    // Stale pack/catalog providers (anthropic/openai/...) must not select BUILTIN_ENV_MAPS.
    // Harness members (Grok Build / DeepSeek Harness) still need their native API-key env
    // when the variant's declared provider is that harness family.
    const envMapProvider =
      options.clientId === 'acp' ? acpHarnessProviderEnv(options.provider) : (options.provider ?? undefined);
    Object.assign(
      resolved,
      resolveEnvMap(
        options.clientId,
        envMapProvider,
        { apiKey: account.apiKey, baseUrl: account.baseUrl, baseModel: options.baseModel },
        userEnvTemplates,
      ),
    );
  }

  const validEnvKey = /^[A-Z_][A-Za-z0-9_]*$/;
  if (account?.envVars) {
    for (const [key, value] of Object.entries(account.envVars)) {
      if (!validEnvKey.test(key) || key.startsWith('CAT_CAFE_')) continue;
      if (hasSupportedEnvTemplate(value)) continue;
      resolved[key] = value;
    }
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

const ACP_HARNESS_PROVIDER_ENV = new Set(['xai', 'deepseek']);

function acpHarnessProviderEnv(provider: string | null | undefined): string | undefined {
  const trimmed = provider?.trim();
  if (!trimmed) return undefined;
  return ACP_HARNESS_PROVIDER_ENV.has(trimmed) ? trimmed : undefined;
}

export function tryPrepareAcpProcessEnv(options: PrepareAcpProcessEnvOptions): TryPrepareAcpProcessEnvResult {
  try {
    return { ok: true, env: prepareAcpProcessEnv(options) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
