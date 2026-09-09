/** Shared pure format boundary for read-only account snapshots and explicit legacy migration. */
import type { AccountConfig, CredentialEntry } from '@cat-cafe/shared';
import { z } from 'zod';

export class AccountStoreVerdictError extends Error {}

export function malformedAccountStore(source: string): never {
  throw new AccountStoreVerdictError(`Invalid/malformed account store (${source}); repair it before use`);
}

const stringRecord = z.record(z.string());
const accountSchema = z
  .object({
    authType: z.enum(['oauth', 'api_key']),
    clientId: z.string().trim().min(1).optional(),
    baseUrl: z.string().optional(),
    displayName: z.string().optional(),
    models: z.array(z.string()).optional(),
    modelAliases: stringRecord.optional(),
    envVars: stringRecord.optional(),
  })
  .passthrough();
const credentialSchema = z
  .object({
    apiKey: z.string().optional(),
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().finite().optional(),
  })
  .passthrough();

export function objectMap(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) malformedAccountStore(source);
  return value as Record<string, unknown>;
}

export function normalizeLegacyAuthType(value: unknown): AccountConfig['authType'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'api_key') return 'api_key';
  if (['oauth', 'subscription', 'builtin'].includes(normalized)) return 'oauth';
  return undefined;
}

export function parseStoredAccount(value: unknown, source: string): AccountConfig {
  const raw = objectMap(value, source);
  const parsed = accountSchema.safeParse({ ...raw, authType: normalizeLegacyAuthType(raw.authType) });
  if (!parsed.success) malformedAccountStore(source);
  return parsed.data;
}

export function parseStoredCredential(value: unknown, source: string): CredentialEntry {
  const parsed = credentialSchema.safeParse(value);
  if (!parsed.success) malformedAccountStore(source);
  return parsed.data;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : entry,
  );
}

/**
 * Normalize account fields for dual-root equality without rewriting observable
 * semantics. models[0] is a live default — never sort. Alias trim-collisions and
 * blank-after-trim entries are unusable persisted content: fail closed instead of
 * silently dropping them into equivalence with a cleaner peer store.
 */
export function canonicalizeAccount(account: AccountConfig) {
  const models = canonicalizeModels(account.models);
  const aliases = canonicalizeModelAliases(account.modelAliases);
  const baseUrl = canonicalizeOptionalText(account.baseUrl, 'baseUrl');
  const displayName = canonicalizeOptionalText(account.displayName, 'displayName');
  return {
    authType: normalizeLegacyAuthType(account.authType) ?? malformedAccountStore('account authType'),
    ...(account.clientId ? { clientId: account.clientId.trim() } : {}),
    ...(baseUrl ? { baseUrl: baseUrl.replace(/\/+$/, '') } : {}),
    ...(displayName ? { displayName } : {}),
    ...(models.length ? { models } : {}),
    ...(Object.keys(aliases).length ? { modelAliases: aliases } : {}),
    ...(Object.keys(account.envVars ?? {}).length ? { envVars: account.envVars } : {}),
  };
}

function invalidAccountField(field: string): never {
  // Values stay out of the message: callers may be comparing stores that also
  // carry credentials, and unusable content must not leak through diagnostics.
  throw new AccountStoreVerdictError(`${field} invalid (values not shown)`);
}

function canonicalizeOptionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) invalidAccountField(field);
  return trimmed;
}

function canonicalizeModels(models: readonly string[] | undefined): string[] {
  if (models == null) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const trimmed = model.trim();
    if (!trimmed) invalidAccountField('models');
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function canonicalizeModelAliases(aliases: Record<string, string> | undefined): Record<string, string> {
  if (aliases == null) return {};
  const normalized: Record<string, string> = {};
  for (const [alias, model] of Object.entries(aliases)) {
    const key = alias.trim();
    const value = model.trim();
    if (!key || !value) invalidAccountField('modelAliases');
    if (Object.hasOwn(normalized, key)) invalidAccountField('modelAliases');
    normalized[key] = value;
  }
  return normalized;
}

/** v1 nested provider families and v2/v3 flat providers/profiles share this decoder. */
export function parseLegacyProviderProfiles(value: unknown): Record<string, AccountConfig>;
export function parseLegacyProviderProfiles(
  value: unknown,
  deferEntryErrors: true,
): Record<string, AccountConfig | AccountStoreVerdictError>;
export function parseLegacyProviderProfiles(
  value: unknown,
  deferEntryErrors = false,
): Record<string, AccountConfig | AccountStoreVerdictError> {
  const meta = objectMap(value, 'provider-profiles.json');
  const raw = meta.providers === undefined ? meta.profiles : meta.providers;
  if (raw === undefined) return Object.create(null) as Record<string, AccountConfig | AccountStoreVerdictError>;
  const entries = Array.isArray(raw)
    ? raw
    : Object.values(objectMap(raw, 'provider-profiles.json')).flatMap((entry) => {
        const group = objectMap(entry, 'provider-profiles.json');
        if (group.profiles === undefined) return [group];
        if (!Array.isArray(group.profiles)) malformedAccountStore('provider-profiles.json profiles');
        return group.profiles;
      });
  const accounts = Object.create(null) as Record<string, AccountConfig | AccountStoreVerdictError>;
  for (const entry of entries) {
    const profile = objectMap(entry, 'provider-profiles.json profile');
    if (typeof profile.id !== 'string' || !profile.id.trim()) malformedAccountStore('provider-profiles.json id');
    const auth = profile.authType ?? profile.mode ?? profile.kind ?? 'oauth';
    // Identifiable malformed entries can be listed as rejected without hiding other refs.
    const normalized = decodeLegacyEntry(
      () =>
        canonicalizeAccount(
          parseStoredAccount({ ...profile, authType: auth }, `provider-profiles.json account ${profile.id}`),
        ),
      deferEntryErrors,
    );
    Object.defineProperty(accounts, profile.id.trim(), {
      value: normalized,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return accounts;
}

export function parseLegacyProviderSecrets(value: unknown): Record<string, CredentialEntry>;
export function parseLegacyProviderSecrets(
  value: unknown,
  deferEntryErrors: true,
): Record<string, CredentialEntry | AccountStoreVerdictError>;
export function parseLegacyProviderSecrets(
  value: unknown,
  deferEntryErrors = false,
): Record<string, CredentialEntry | AccountStoreVerdictError> {
  const meta = objectMap(value, 'provider-profiles.secrets.local.json');
  const entries =
    meta.profiles !== undefined
      ? Object.entries(objectMap(meta.profiles, 'provider-profiles.secrets.local.json profiles'))
      : Object.values(
          objectMap(
            meta.providers === undefined ? {} : meta.providers,
            'provider-profiles.secrets.local.json providers',
          ),
        ).flatMap((group) => Object.entries(objectMap(group, 'provider-profiles.secrets.local.json family')));
  // Avoid Object.fromEntries: a legacy ref named "__proto__" would corrupt [[Prototype]].
  const secrets = Object.create(null) as Record<string, CredentialEntry | AccountStoreVerdictError>;
  for (const [ref, secret] of entries) {
    Object.defineProperty(secrets, ref, {
      value: decodeLegacyEntry(
        () => parseStoredCredential(secret, `provider-profiles.secrets.local.json credential ${ref}`),
        deferEntryErrors,
      ),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return secrets;
}

function decodeLegacyEntry<T>(decode: () => T, deferErrors: boolean): T | AccountStoreVerdictError {
  try {
    return decode();
  } catch (error) {
    if (!deferErrors || !(error instanceof AccountStoreVerdictError)) throw error;
    return error;
  }
}
