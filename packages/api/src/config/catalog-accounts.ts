/**
 * clowder-ai#340 — Accounts read/write layer
 *
 * Storage: {projectRoot}/.cat-cafe/accounts.json (project-local by default).
 * Override: CAT_CAFE_GLOBAL_CONFIG_ROOT env → uses that root instead.
 *
 * Migrations (once per process per source):
 *   1. Legacy provider-profiles.json → accounts.json
 *   2. Project cat-catalog.json.accounts → accounts.json
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AccountConfig } from '@cat-cafe/shared';
import { resolveAccountStoreRoot } from './account-store-root.js';
import { assertSafeTestConfigRead, assertSafeTestConfigRoot } from './test-config-write-guard.js';

const CONFIG_SUBDIR = '.cat-cafe';
const ACCOUNTS_FILENAME = 'accounts.json';
const CREDENTIALS_FILENAME = 'credentials.json';
/** Durable migration-completion marker (cross-process evidence), stored in the workspace store. */
const RUNTIME_MIGRATION_MARKER = 'runtime-migration.json';
const BUILTIN_ACCOUNT_REFS = new Set([
  'claude',
  'codex',
  'gemini',
  'kimi',
  'opencode',
  'anthropic',
  'openai',
  'google',
  'builtin_anthropic',
  'builtin_openai',
  'builtin_google',
  'builtin_kimi',
  'builtin_opencode',
]);
const INSTALLER_ACCOUNT_REFS = new Set([
  'installer-anthropic',
  'installer-openai',
  'installer-google',
  'installer-kimi',
  'installer-opencode',
  'installer-managed',
]);

function assertSafeCatalogWrite(projectRoot: string | undefined, source: string): void {
  assertSafeTestConfigRoot(resolveAccountStoreRoot({ projectRoot }), source);
}

/** P1-8: resolving the store is enough of a boundary crossing — reads count too. */
function assertSafeCatalogRead(projectRoot: string | undefined, source: string): void {
  assertSafeTestConfigRead(resolveAccountStoreRoot({ projectRoot }), source);
}

/**
 * P1-9: guard a migration's SOURCE or TARGET root before it opens anything.
 *
 * Guarding the public reader was guarding the wrong end. readCatalogAccounts()
 * runs ensureMigrated() first, and those migrations open $HOME's
 * credentials.json, legacy provider-profiles files and the project catalog —
 * then COPY what they find into the caller's own store, where reading it back is
 * entirely legal. By the time readAllGlobal()'s guard ran, the crossing had
 * already happened and the credential was sitting inside the fixture. So every
 * migration root is checked here, before its first existsSync/readFileSync.
 *
 * The argument is a PHYSICAL directory, not a store root: do not route it
 * through resolveAccountStoreRoot(), which would redirect a source to the very
 * target we are trying to keep it out of.
 *
 * P1-11: an earlier draft placed only three of these, arguing that
 * ensureMigrated()'s fixed order made any further guard unreachable — an
 * earlier guard on the same root would always refuse first, so the extra line
 * could not be killed by any mutation. That reasoning holds for ONE call in ONE
 * state, and the state does not hold still: the completion caches
 * (migratedProjectLegacy, migratedProjects, …) survive for the life of the
 * process, while CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT and
 * CAT_CAFE_SKIP_HOMEDIR_MIGRATION are re-read on every call. So a first call
 * under an explicit opt-out can cache away the guard that a second call, with
 * protection restored, was relying on — and the reader downstream still opens
 * the file. It is also asymmetric: migrateProjectLegacyProviderProfiles()
 * caches even when its source is absent, migrateProjectAccountsToGlobal()
 * returns from inside its try without caching.
 *
 * Hence the rule, which is LOCAL and therefore independent of call order and
 * cache state: every function that itself opens a caller-supplied root guards
 * that root before its own first existsSync/readFileSync. A guard that no
 * mutation can kill means the reaching test has not been written yet — it does
 * not mean the line is decoration.
 */
function assertSafeMigrationRead(root: string, source: string): void {
  assertSafeTestConfigRead(root, source);
}

export function resolveAccountsPath(projectRoot?: string): string {
  return resolve(resolveAccountStoreRoot({ projectRoot }), CONFIG_SUBDIR, ACCOUNTS_FILENAME);
}

function writeFileAtomic(filePath: string, content: string, mode?: number): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, content, { encoding: 'utf-8', mode: mode ?? 0o644 });
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}

function readAllGlobal(projectRoot?: string): Record<string, AccountConfig> {
  // Before existsSync, not after: whether the boundary holds must not depend on
  // whether the operator happens to have a store file there (P1-8).
  assertSafeCatalogRead(projectRoot, 'catalog-accounts.readAllGlobal');
  const accountsPath = resolveAccountsPath(projectRoot);
  if (!existsSync(accountsPath)) return {};
  const raw = readFileSync(accountsPath, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, AccountConfig>;
  } catch {
    // Fix P1-3: corrupt file → backup + warn, not silent swallow
    const backupPath = `${accountsPath}.bak`;
    try {
      assertSafeCatalogWrite(projectRoot, 'catalog-accounts.readAllGlobal.backup');
      copyFileSync(accountsPath, backupPath);
    } catch {
      /* best-effort backup */
    }
    console.error(`[catalog-accounts] corrupt ${accountsPath} — backed up to .bak, treating as empty`);
    return {};
  }
}

function writeAllGlobal(accounts: Record<string, AccountConfig>, projectRoot?: string): void {
  assertSafeCatalogWrite(projectRoot, 'catalog-accounts.writeAllGlobal');
  const accountsPath = resolveAccountsPath(projectRoot);
  mkdirSync(resolve(resolveAccountStoreRoot({ projectRoot }), CONFIG_SUBDIR), { recursive: true });
  writeFileAtomic(accountsPath, `${JSON.stringify(accounts, null, 2)}\n`);
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}

function normalizeDisplayName(displayName: string | undefined): string | undefined {
  const trimmed = displayName?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeModels(models: readonly string[] | undefined): string[] | undefined {
  if (!Array.isArray(models)) return undefined;
  const normalized = Array.from(
    new Set(models.map((value) => String(value).trim()).filter((value) => value.length > 0)),
  );
  return normalized.length > 0 ? normalized.sort() : undefined;
}

function normalizeModelAliases(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const normalized = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, upstreamId]) => [key.trim(), upstreamId.trim()] as const)
    .filter(([key, upstreamId]) => key.length > 0 && upstreamId.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return normalized.length > 0 ? Object.fromEntries(normalized) : undefined;
}

/**
 * Canonical view of one persisted field: a usable value, or an opaque digest of
 * content that is not a legal persisted shape.
 *
 * P1-14, P1-15 and P1-16 are ONE bug with five spellings. Every function above
 * is a WRITE-side normaliser — it exists to clean up what a caller hands in, so
 * every one of them LOSES information: `?.trim()` short-circuits on null, a
 * blank result becomes undefined, `String()` coerces, filters drop entries,
 * Object.fromEntries() keeps only the last of several keys that collide after
 * trimming, and `{ ...envVars }` turns an array into index keys. Feed that
 * output straight into the equivalence view and "this account holds content I
 * cannot interpret" becomes "this account holds nothing": a stored
 * `models: null` compares equal to an account with no models, so the
 * runtime→workspace migration stops refusing, binds a stale runtime credential
 * to the workspace account, and writes the completion marker that skips the
 * preflight from then on. Strict JSON parsing does not catch it — the migration
 * asserts the parsed object into AccountConfig without ever running the route
 * schema, so AccountConfig-illegal content genuinely reaches the comparison.
 *
 * The rule, stated once instead of patched per field:
 *
 *   A FIELD MAY BE NORMALISED ONLY AFTER ITS PERSISTED SHAPE IS VALIDATED,
 *   and each validation covers exactly what that field's own normaliser can
 *   lose. Anything outside the legal shape canonicalises to a digest of the raw
 *   value: identical unusable content stays equal to itself, different content
 *   stays different, and the value itself never reaches a diagnostic.
 *
 * Its corollary is why this stays small: a field with NO normaliser is compared
 * RAW, which cannot lose anything and therefore needs no schema. authType,
 * clientId and every future AccountConfig addition are already fail-closed.
 *
 * The value is TAGGED because that is what makes the two forms uncomparable by
 * construction — an alias map may hold any key and a model list any string, so
 * a plain sentinel could collide with real persisted data.
 */
type CanonicalField = readonly ['value', unknown] | readonly ['invalid', string];

function usable(value: unknown): CanonicalField {
  return ['value', value] as const;
}

/** Unusable content: compared by digest, so the raw value never reaches a diagnostic. */
function opaque(raw: unknown): CanonicalField {
  return ['invalid', sha256Hex(canonicalJson(raw))] as const;
}

/**
 * baseUrl — normalizeBaseUrl() trims and drops trailing slashes. Both are
 * legitimate: the route persists the string unchanged, so padding and a
 * trailing slash are the same endpoint. What it also does is turn `null` and
 * every non-string into `undefined` (`?.` short-circuits), and collapse a
 * blank-once-trimmed string into absence.
 */
function canonicalBaseUrl(raw: unknown): CanonicalField | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return opaque(raw);
  const normalized = raw.trim().replace(/\/+$/, '');
  return normalized ? usable(normalized) : opaque(raw);
}

/** displayName — same shape of loss as baseUrl, minus the slash rule. */
function canonicalDisplayName(raw: unknown): CanonicalField | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return opaque(raw);
  const trimmed = raw.trim();
  return trimmed ? usable(trimmed) : opaque(raw);
}

/**
 * models — normalizeModels() trims each entry and drops trailing slashes (both
 * match the route schema's own transform, so both are legal), but it also
 * String()-coerces non-strings, drops entries that are blank once trimmed,
 * de-duplicates, and SORTS.
 *
 * Sorting is not order-preserving normalisation, it is a rewrite of observable
 * semantics: invoke-single-cat.ts reads models[0] as the fallback model
 * override and reports models[0] as the model in use, so ['b','a'] and ['a','b']
 * name different default models and must stay a difference. De-duplication
 * keeps the FIRST occurrence, which can never move models[0] and drops nothing
 * a reader could observe.
 */
function canonicalModels(raw: unknown): CanonicalField | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return opaque(raw);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return opaque(raw);
    const model = entry.trim().replace(/\/+$/, '');
    if (!model) return opaque(raw);
    if (seen.has(model)) continue;
    seen.add(model);
    normalized.push(model);
  }
  // An empty list carries nothing the normaliser could lose, and no reader can
  // tell it from an absent field: accountToView() renders both as [], and every
  // models[0]/models.length reader takes the same branch for both.
  return normalized.length > 0 ? usable(normalized) : undefined;
}

/**
 * modelAliases — a well-formed map keeps padding and key order equivalent
 * (upstream #1233's point). `null` is content, not absence: the route's
 * modelAliasesSchema is optional, not nullable, so no normal write path
 * produces a stored null (P1-15). It is folded in with the other unusable
 * shapes rather than short-circuited above because `typeof null === 'object'`
 * has to be excluded before Object.entries() either way.
 */
function canonicalModelAliases(raw: unknown): CanonicalField | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return opaque(raw);

  const entries = Object.entries(raw as Record<string, unknown>);
  // An empty map is "no aliases", which is what an absent field means too.
  if (entries.length === 0) return undefined;

  const trimmedKeys = new Set<string>();
  for (const [key, value] of entries) {
    if (typeof value !== 'string') return opaque(raw);
    const trimmedKey = key.trim();
    const trimmedValue = value.trim();
    if (!trimmedKey || !trimmedValue) return opaque(raw);
    if (trimmedKeys.has(trimmedKey)) return opaque(raw);
    trimmedKeys.add(trimmedKey);
  }

  const normalized = normalizeModelAliases(raw);
  return normalized ? usable(normalized) : opaque(raw);
}

/**
 * envVars — the normaliser it replaces was an identity copy of a plain object
 * (`{ ...envVars }`), so VALUES lose nothing and stay raw-compared; validating
 * them here would only invent conflicts on legacy data. Only the CONTAINER can
 * be lost:
 * `{ ...['X'] }` becomes `{ '0': 'X' }` and collides with that literal object,
 * `{ ...'ab' }` spreads a string into index keys, and null/numbers fall into
 * the `Object.keys(x).length === 0` branch and vanish into absence.
 */
function canonicalEnvVars(raw: unknown): CanonicalField | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return opaque(raw);
  const entries = Object.entries(raw as Record<string, unknown>);
  // An empty map is "no env vars" — the same absence, and the route never
  // persists one.
  if (entries.length === 0) return undefined;
  return usable(Object.fromEntries(entries));
}

/**
 * The only fields that are normalised before comparison — i.e. the only fields
 * that need a shape gate. Everything else is compared raw (see CanonicalField).
 *
 * A Map, not an object literal, and the canonical view below is a Map too.
 * Persisted field NAMES come from JSON, where TypeScript's field list does not
 * apply and `Object.prototype`'s members are perfectly legal keys — so an
 * object-keyed table turns a lookup into a prototype walk (R18 P1):
 *
 *   table['toString']    → Object.prototype.toString  — callable, and returns
 *                          '[object Undefined]' for EVERY input, so two
 *                          different persisted toString values canonicalise to
 *                          the same string and the migration copies the stale
 *                          credential.
 *   table['constructor'] → Object — Object(1) and Object(true) both canonical-
 *                          ise to {}. Same leak, different inherited member.
 *   table['__proto__']   → Object.prototype — not callable, so the migration
 *                          died on a TypeError instead of refusing.
 *
 * Writing the result into an object literal is the same hazard twice over:
 * `canonical['__proto__'] = raw` invokes the prototype SETTER instead of
 * creating an own property, so the field vanishes from the comparison, and
 * `'toString' in canonical` is true for every account ever built.
 *
 * Map keys are data. There is no key an attacker or a legacy file can choose
 * that turns a lookup into inheritance, so the whole class is gone by
 * construction rather than by a deny-list someone has to maintain.
 */
const PERSISTED_FIELD_CANONICALIZERS = new Map<string, (raw: unknown) => CanonicalField | undefined>([
  ['baseUrl', canonicalBaseUrl],
  ['displayName', canonicalDisplayName],
  ['models', canonicalModels],
  ['modelAliases', canonicalModelAliases],
  ['envVars', canonicalEnvVars],
]);

/**
 * Canonical view of EVERY persisted account field.
 *
 * Iterating the account rather than destructuring known names is what keeps the
 * guarantee automatic: a future AccountConfig field arrives here with no
 * canonicaliser and is therefore carried through RAW — the strictest possible
 * comparison — instead of silently sitting outside the equivalence check (R3
 * P1-2: clientId/envVars divergence was once skipped as "equivalent").
 *
 * Object.entries() is own-enumerable only, which is what makes it a safe way to
 * read a JSON-parsed account: JSON.parse creates `__proto__` as an ordinary own
 * property, so it arrives here as data and stays data.
 */
function canonicalizeAccount(account: AccountConfig): Map<string, unknown> {
  const canonical = new Map<string, unknown>();
  for (const [field, raw] of Object.entries(account) as Array<[string, unknown]>) {
    const canonicalize = PERSISTED_FIELD_CANONICALIZERS.get(field);
    if (!canonicalize) {
      canonical.set(field, raw);
      continue;
    }
    const value = canonicalize(raw);
    if (value !== undefined) canonical.set(field, value);
  }
  return canonical;
}

/** Fields whose VALUES are safe to print in conflict diagnostics. envVars and
 *  unknown future fields fail closed on the diff but never print values. A
 *  well-formed alias map is safe to print (upstream #1233 already did); an
 *  UNUSABLE value of any field never is, which the invalid tag handles below
 *  ahead of this set (P1-14/P1-16). */
const CONFLICT_VALUE_SAFE_FIELDS = new Set([
  'authType',
  'clientId',
  'baseUrl',
  'displayName',
  'models',
  'modelAliases',
]);

/** Both of these are only ever called for CANONICALISED fields, so a raw field
 *  that happens to be an array cannot be mistaken for a tag. */
function isInvalidCanonicalField(value: unknown): boolean {
  return Array.isArray(value) && value[0] === 'invalid';
}

/** Strip the CanonicalField tag for display. */
function untagCanonicalField(value: unknown): unknown {
  return Array.isArray(value) ? value[1] : undefined;
}

function describeAccountConflict(existing: AccountConfig, incoming: AccountConfig): string {
  const current = canonicalizeAccount(existing);
  const next = canonicalizeAccount(incoming);
  const diffs: string[] = [];

  // Map.has/get throughout: `field in obj` walks the prototype, so every
  // account would have reported a `toString` it never had (R18 P1).
  for (const field of [...new Set([...current.keys(), ...next.keys()])].sort()) {
    const a = current.has(field) ? canonicalJson(current.get(field)) : undefined;
    const b = next.has(field) ? canonicalJson(next.get(field)) : undefined;
    if (a === b) continue;

    const canonicalised = PERSISTED_FIELD_CANONICALIZERS.has(field);
    // P1-14/P1-16: content that failed its shape gate is reported as a
    // difference without ever echoing what made it unusable.
    if (canonicalised && (isInvalidCanonicalField(current.get(field)) || isInvalidCanonicalField(next.get(field)))) {
      diffs.push(`${field} invalid (values not shown)`);
      continue;
    }
    const currentValue = canonicalised ? untagCanonicalField(current.get(field)) : current.get(field);
    const nextValue = canonicalised ? untagCanonicalField(next.get(field)) : next.get(field);

    if (field === 'envVars') {
      const currentVars = (currentValue ?? {}) as Record<string, string>;
      const nextVars = (nextValue ?? {}) as Record<string, string>;
      // Own-property semantics here too: envVars keys are persisted JSON, so
      // `nextVars.toString` would otherwise compare an inherited function.
      const varOf = (vars: Record<string, string>, key: string) => (Object.hasOwn(vars, key) ? vars[key] : undefined);
      const keys = [...new Set([...Object.keys(currentVars), ...Object.keys(nextVars)])]
        .filter((key) => varOf(currentVars, key) !== varOf(nextVars, key))
        .sort();
      diffs.push(`envVars keys [${keys.join(', ')}] differ (values not shown)`);
    } else if (CONFLICT_VALUE_SAFE_FIELDS.has(field)) {
      const show = (present: boolean, value: unknown) => (present ? canonicalJson(value) : '(none)');
      diffs.push(`${field} ${show(current.has(field), currentValue)} vs ${show(next.has(field), nextValue)}`);
    } else {
      diffs.push(`${field} differs (values not shown)`);
    }
  }
  // Upstream #1233 appended a standalone modelAliases comparison here because
  // its describeAccountConflict() checked fields one by one. The generic loop
  // above now covers every canonical field, modelAliases included, so keeping
  // the block would report the same difference twice.

  return diffs.join('; ');
}

function accountsEquivalent(existing: AccountConfig, incoming: AccountConfig): boolean {
  return describeAccountConflict(existing, incoming).length === 0;
}

function normalizeLegacyAuthType(value: unknown): AccountConfig['authType'] | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === 'api_key') return 'api_key';
  if (normalized === 'oauth' || normalized === 'subscription' || normalized === 'builtin') return 'oauth';
  return undefined;
}

function inferLegacyAuthType(profile: Record<string, unknown>): AccountConfig['authType'] {
  return (
    normalizeLegacyAuthType(profile.authType) ??
    normalizeLegacyAuthType(profile.mode) ??
    normalizeLegacyAuthType(profile.kind) ??
    'oauth'
  );
}

function collectAccountRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectAccountRefs(item, refs);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'accountRef' || key === 'providerProfileId') && typeof nested === 'string' && nested.trim()) {
      refs.add(nested.trim());
    } else collectAccountRefs(nested, refs);
  }
}

function collectRootCatalogAccountKeys(value: unknown, refs: Set<string>): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const accounts = (value as Record<string, unknown>).accounts;
  if (typeof accounts !== 'object' || accounts === null || Array.isArray(accounts)) return;
  for (const ref of Object.keys(accounts)) {
    const normalized = ref.trim();
    if (normalized) refs.add(normalized);
  }
}

function readProjectAccountRefs(projectRoot: string): Set<string> {
  // P1-11: this opens the project catalog itself, so it checks the project root
  // itself. Its callers' completion caches are not the same as its own.
  assertSafeMigrationRead(projectRoot, 'catalog-accounts.readProjectAccountRefs.source');
  const refs = new Set<string>();
  const catalogPath = resolve(projectRoot, CONFIG_SUBDIR, 'cat-catalog.json');
  if (!existsSync(catalogPath)) return refs;
  try {
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    collectAccountRefs(catalog, refs);
    collectRootCatalogAccountKeys(catalog, refs);
  } catch {
    return refs;
  }
  return refs;
}

function isInstallerAccountRef(ref: string): boolean {
  return INSTALLER_ACCOUNT_REFS.has(ref);
}

// Cross-root homedir legacy import is an upgrade rescue path, not global account sync.
// Keep installer/builtin compatibility and project-bound custom accounts, but do not
// copy old experimental profiles into every project-local runtime.
function shouldImportCrossRootHomedirAccount(ref: string, referencedRefs: Set<string>): boolean {
  return BUILTIN_ACCOUNT_REFS.has(ref) || isInstallerAccountRef(ref) || referencedRefs.has(ref);
}

/** Merge source accounts into global, preserving existing keys. */
function mergeIntoGlobal(
  source: Record<string, AccountConfig>,
  projectRoot?: string,
  opts?: { skipConflicts?: boolean },
): { merged: string[]; skipped: string[] } {
  const global = readAllGlobal(projectRoot);
  const merged: string[] = [];
  const skipped: string[] = [];
  for (const [ref, account] of Object.entries(source)) {
    if (ref in global) {
      if (!accountsEquivalent(global[ref], account)) {
        if (opts?.skipConflicts) {
          console.error(
            `[catalog-accounts] conflict for "${ref}" — global wins: ${describeAccountConflict(global[ref], account)}`,
          );
          skipped.push(ref);
          continue;
        }
        throw new Error(`Account conflict for "${ref}": ${describeAccountConflict(global[ref], account)}`);
      }
      skipped.push(ref);
    } else {
      global[ref] = account;
      merged.push(ref);
    }
  }
  if (merged.length > 0) writeAllGlobal(global, projectRoot);
  return { merged, skipped };
}

// ── Legacy provider-profiles.json → accounts.json migration ──

/** Migrate legacy provider-profiles.json + secrets from a given root into global accounts. */
function migrateLegacyFrom(
  root: string,
  projectRoot?: string,
  opts?: { shouldImportAccount?: (ref: string, account: AccountConfig) => boolean },
): void {
  // P1-9: `root` is whichever legacy location this call was pointed at — the
  // store root, the project dir, or $HOME. Its profiles and its
  // provider-profiles.secrets.local.json are both read below.
  assertSafeMigrationRead(root, 'catalog-accounts.migrateLegacyFrom.source');
  const metaPath = resolve(root, CONFIG_SUBDIR, 'provider-profiles.json');
  if (!existsSync(metaPath)) return;
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  // v2/v3: flat array of profiles.  v1: nested { providers: { <client>: { profiles: [...] } } }.
  const rawProviders = meta?.providers ?? meta?.profiles;
  let providers: Array<Record<string, unknown>>;
  if (Array.isArray(rawProviders)) {
    providers = rawProviders;
  } else if (rawProviders != null && typeof rawProviders === 'object') {
    providers = [];
    for (const [, val] of Object.entries(rawProviders as Record<string, unknown>)) {
      if (typeof val !== 'object' || val === null) continue;
      const obj = val as Record<string, unknown>;
      if (Array.isArray(obj.profiles)) {
        // v1 nested: { anthropic: { profiles: [{ id, ... }, ...] } }
        for (const p of obj.profiles) {
          if (typeof p === 'object' && p !== null) providers.push(p as Record<string, unknown>);
        }
      } else {
        // Simple object: treat as single provider entry
        providers.push(obj);
      }
    }
  } else {
    providers = [];
  }
  if (providers.length === 0) return;

  const accounts: Record<string, AccountConfig> = {};
  for (const p of providers) {
    const id = String(p.id ?? '').trim();
    if (!id) continue;
    const displayName = normalizeDisplayName(typeof p.displayName === 'string' ? p.displayName : undefined);
    const baseUrl = normalizeBaseUrl(typeof p.baseUrl === 'string' ? p.baseUrl : undefined);
    const models = normalizeModels(Array.isArray(p.models) ? p.models.map(String) : undefined);
    const modelAliases = normalizeModelAliases(p.modelAliases);
    // clowder-ai#340: protocol not migrated — derived at runtime from well-known account IDs.
    const account: AccountConfig = {
      authType: inferLegacyAuthType(p),
      ...(displayName ? { displayName } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(models ? { models } : {}),
      ...(modelAliases ? { modelAliases } : {}),
    };
    if (opts?.shouldImportAccount && !opts.shouldImportAccount(id, account)) continue;
    accounts[id] = account;
  }
  const { merged } = mergeIntoGlobal(accounts, projectRoot, { skipConflicts: true });
  const mergedSet = new Set(merged);
  // Read global state after merge for retry-safe credential import
  const globalAfterMerge = readAllGlobal(projectRoot);

  const secretsPath = resolve(root, CONFIG_SUBDIR, 'provider-profiles.secrets.local.json');
  if (!existsSync(secretsPath)) return;
  const secretsMeta = JSON.parse(readFileSync(secretsPath, 'utf-8'));
  // v2/v3: flat { profiles: { <id>: { apiKey } } }.
  // v1: nested { providers: { <client>: { <id>: { apiKey } } } }.
  let profileSecrets: Record<string, Record<string, unknown>> = {};
  if (secretsMeta?.profiles && typeof secretsMeta.profiles === 'object') {
    profileSecrets = secretsMeta.profiles;
  } else if (secretsMeta?.providers && typeof secretsMeta.providers === 'object') {
    for (const clientSecrets of Object.values(secretsMeta.providers as Record<string, unknown>)) {
      if (typeof clientSecrets === 'object' && clientSecrets !== null) {
        Object.assign(profileSecrets, clientSecrets as Record<string, Record<string, unknown>>);
      }
    }
  }
  const globalRoot = resolveAccountStoreRoot({ projectRoot });
  const credPath = resolve(globalRoot, CONFIG_SUBDIR, 'credentials.json');
  const existing = existsSync(credPath)
    ? (() => {
        try {
          return JSON.parse(readFileSync(credPath, 'utf-8'));
        } catch {
          return {};
        }
      })()
    : {};
  let credCount = 0;
  for (const [id, secret] of Object.entries(profileSecrets)) {
    if (!(id in accounts) || id in existing || !secret?.apiKey) continue;
    if (mergedSet.has(id)) {
      // First run: account was just merged — safe to import its secret.
      existing[id] = { apiKey: String(secret.apiKey) };
      credCount++;
    } else {
      // Retry path: account already existed in global (skipped by merge).
      // Only import if the global account's fields match what we'd migrate —
      // proves it came from a previous run of this same migration source,
      // not a collision with a different-origin account sharing the same ID.
      const g = globalAfterMerge[id];
      const l = accounts[id];
      if (g && accountsEquivalent(g, l)) {
        existing[id] = { apiKey: String(secret.apiKey) };
        credCount++;
      }
    }
  }
  if (credCount > 0) {
    assertSafeCatalogWrite(projectRoot, 'catalog-accounts.migrateLegacyFrom.credentials');
    mkdirSync(resolve(globalRoot, CONFIG_SUBDIR), { recursive: true });
    writeFileAtomic(credPath, `${JSON.stringify(existing, null, 2)}\n`, 0o600);
  }
}

let legacyMigrationDone = false;

function migrateLegacyProviderProfiles(projectRoot?: string): void {
  if (legacyMigrationDone) return;
  try {
    migrateLegacyFrom(resolveAccountStoreRoot({ projectRoot }), projectRoot);
    legacyMigrationDone = true;
  } catch (err) {
    console.error('[catalog-accounts] legacy→global migration failed:', err);
    throw err;
  }
}

const migratedProjectLegacy = new Set<string>();

function migrateProjectLegacyProviderProfiles(projectRoot: string): void {
  const key = resolve(projectRoot);
  if (migratedProjectLegacy.has(key)) return;
  try {
    migrateLegacyFrom(key, projectRoot);
    migratedProjectLegacy.add(key);
  } catch (err) {
    console.error(`[catalog-accounts] project legacy→global migration failed for ${key}:`, err);
    throw err;
  }
}

// ── Project catalog.accounts → global accounts.json migration ──

const migratedProjects = new Set<string>();

function migrateProjectAccountsToGlobal(projectRoot: string): void {
  const key = resolve(projectRoot);
  if (migratedProjects.has(key)) return;
  // P1-11: this reader has its own cache and its own file open, so it needs its
  // own guard — migrateProjectLegacyProviderProfiles() having already run for
  // this root under a different opt-out state is not a safety property.
  //
  // Deliberately OUTSIDE the try below: that catch swallows every error and
  // marks the project migrated, which would turn a sandbox refusal into a
  // silent pass — the one failure mode this whole boundary exists to prevent.
  assertSafeMigrationRead(key, 'catalog-accounts.migrateProjectAccountsToGlobal.source');
  try {
    const catalogPath = resolve(projectRoot, CONFIG_SUBDIR, 'cat-catalog.json');
    if (!existsSync(catalogPath)) return;
    const raw = readFileSync(catalogPath, 'utf-8');
    const catalog = JSON.parse(raw);
    const projectAccounts = catalog?.accounts;
    if (!projectAccounts || typeof projectAccounts !== 'object' || Object.keys(projectAccounts).length === 0) return;

    const { merged } = mergeIntoGlobal(projectAccounts as Record<string, AccountConfig>, projectRoot, {
      skipConflicts: true,
    });

    // clowder-ai#340: project catalog.accounts is intentionally left untouched.
    // Runtime only reads global accounts.json, so the project section is
    // inert — keeping it provides free rollback compatibility and avoids
    // unnecessary writes to the project catalog file.
    if (merged.length > 0) {
      console.error(`[catalog-accounts] project ${key}: ${merged.length} account(s) merged into global`);
    }
    migratedProjects.add(key);
  } catch (err) {
    // Best-effort: log and mark done to avoid retry loops on persistent
    // errors (corrupt catalog JSON, permission issues, etc.).
    console.error(`[catalog-accounts] project→global migration failed for ${key}:`, err);
    migratedProjects.add(key);
  }
}

// ── Homedir legacy migration (picks up secrets written by pre-clowder-ai#340 installer without --project-dir) ──

const migratedHomedirLegacy = new Set<string>();

function projectScopedMigrationKey(resolvedTarget: string, projectRoot?: string): string {
  return `${resolvedTarget}\0${projectRoot ? resolve(projectRoot) : ''}`;
}

function migrateHomedirLegacyProviderProfiles(projectRoot?: string): void {
  const globalRoot = resolveAccountStoreRoot({ projectRoot });
  const resolvedTarget = resolve(globalRoot);
  const migrationKey = projectScopedMigrationKey(resolvedTarget, projectRoot);
  if (migratedHomedirLegacy.has(migrationKey)) return;
  const home = homedir();
  if (resolvedTarget === resolve(home)) {
    // Global root IS homedir — already covered by migrateLegacyProviderProfiles.
    migratedHomedirLegacy.add(migrationKey);
    return;
  }
  // P1-9, before the try: its catch swallows corrupt-source errors, and a
  // sandbox refusal must never be filed under "the operator's HOME was corrupt".
  try {
    const referencedRefs = projectRoot ? readProjectAccountRefs(projectRoot) : new Set<string>();
    migrateLegacyFrom(home, projectRoot, {
      shouldImportAccount: (ref) => shouldImportCrossRootHomedirAccount(ref, referencedRefs),
    });
    migratedHomedirLegacy.add(migrationKey);
  } catch (err) {
    // Only swallow parse/read errors (corrupt homedir files). Re-throw account
    // conflicts and other migration errors so callers get a fail-fast signal.
    if (err instanceof SyntaxError || (err instanceof Error && err.message.includes('ENOENT'))) {
      console.error('[catalog-accounts] homedir legacy→global migration failed (corrupt source, skipped):', err);
      migratedHomedirLegacy.add(migrationKey);
    } else {
      throw err;
    }
  }
}

// ── Homedir credentials.json migration (pre-clowder-ai#340 credentials written directly to homedir) ──

const migratedHomedirCredentials = new Set<string>();

function migrateHomedirCredentials(projectRoot?: string): void {
  const globalRoot = resolveAccountStoreRoot({ projectRoot });
  const resolvedTarget = resolve(globalRoot);
  const migrationKey = projectScopedMigrationKey(resolvedTarget, projectRoot);
  if (migratedHomedirCredentials.has(migrationKey)) return;
  const home = homedir();
  if (resolvedTarget === resolve(home)) {
    migratedHomedirCredentials.add(migrationKey);
    return;
  }
  // P1-9: this is the path 砚砚's repro walked. Both roots, before the first
  // existsSync — the source because a protected HOME's credentials.json is
  // parsed a few lines down, the target because it is read and rewritten. The
  // guards sit ahead of the try for the same reason as above.
  assertSafeMigrationRead(home, 'catalog-accounts.migrateHomedirCredentials.source');
  assertSafeMigrationRead(globalRoot, 'catalog-accounts.migrateHomedirCredentials.target');
  const homeCredPath = resolve(home, CONFIG_SUBDIR, 'credentials.json');
  if (!existsSync(homeCredPath)) {
    migratedHomedirCredentials.add(migrationKey);
    return;
  }
  try {
    const homeCreds = JSON.parse(readFileSync(homeCredPath, 'utf-8'));
    if (typeof homeCreds !== 'object' || homeCreds === null || Array.isArray(homeCreds)) {
      migratedHomedirCredentials.add(migrationKey);
      return;
    }
    const targetCredPath = resolve(globalRoot, CONFIG_SUBDIR, 'credentials.json');
    let targetCreds: Record<string, unknown> = {};
    if (existsSync(targetCredPath)) {
      try {
        const parsed = JSON.parse(readFileSync(targetCredPath, 'utf-8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          targetCreds = parsed;
        }
      } catch {
        targetCreds = {};
      }
    }
    let imported = 0;
    const referencedRefs = projectRoot ? readProjectAccountRefs(projectRoot) : new Set<string>();
    const targetAccounts = readAllGlobal(projectRoot);
    for (const [ref, entry] of Object.entries(homeCreds)) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        !(ref in targetCreds) &&
        (ref in targetAccounts || shouldImportCrossRootHomedirAccount(ref, referencedRefs))
      ) {
        targetCreds[ref] = entry;
        imported++;
      }
    }
    if (imported > 0) {
      assertSafeCatalogWrite(projectRoot, 'catalog-accounts.migrateHomedirCredentials');
      mkdirSync(resolve(globalRoot, CONFIG_SUBDIR), { recursive: true });
      writeFileAtomic(targetCredPath, `${JSON.stringify(targetCreds, null, 2)}\n`, 0o600);
      console.error(
        `[catalog-accounts] homedir credentials.json: ${imported} credential(s) merged into ${resolvedTarget}`,
      );
    }
    migratedHomedirCredentials.add(migrationKey);
  } catch (err) {
    if (err instanceof SyntaxError || (err instanceof Error && err.message.includes('ENOENT'))) {
      console.error('[catalog-accounts] homedir credentials.json migration failed (corrupt source, skipped):', err);
      migratedHomedirCredentials.add(migrationKey);
    } else {
      throw err;
    }
  }
}

function ensureMigrated(projectRoot: string): void {
  // #506 source-owned intake: keep legacy homedir migrations for upgrades,
  // but allow new installs / opensource profile to opt out explicitly.
  const skipHomedirMigration = process.env.CAT_CAFE_SKIP_HOMEDIR_MIGRATION === '1';
  if (!skipHomedirMigration) {
    // Keep the original "credentials first" ordering so skip-existing semantics
    // still prefer imported secrets before legacy profile migration runs.
    migrateHomedirCredentials(projectRoot);
  }
  migrateLegacyProviderProfiles(projectRoot);
  migrateProjectLegacyProviderProfiles(projectRoot);
  if (!skipHomedirMigration) {
    // Preserve the pre-intake ordering: homedir legacy profiles remain after
    // project-scoped legacy sources, only gated by the new skip flag.
    migrateHomedirLegacyProviderProfiles(projectRoot);
  }
  migrateProjectAccountsToGlobal(projectRoot);
  migrateRuntimeStaleAccountsToWorkspace();
}

// ── Runtime stale store → persistent workspace migration ──
//
// PR #1149 moved account/credential writes to the persistent workspace root,
// but pre-#1149 deployments may still hold accounts/credentials seeded inside the
// disposable runtime checkout. The store-root redirect (resolveAccountStoreRoot) makes
// readers/writers ignore that stale runtime store entirely — migrate it once so
// users do not lose accounts that predate the redirect.

const migratedRuntimeStale = new Set<string>();

interface RuntimeMigrationMarker {
  sourceFingerprints: Record<string, string>;
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** A source file that is absent — a legitimate, comparable fingerprint state. */
const FINGERPRINT_ABSENT = 'absent';
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Fingerprint a source file by its CANONICAL parsed content, not raw bytes —
 * a whitespace/key-order-only rewrite is not a rollback (R3 P2-1).
 *
 * Unparseable content returns null: an INCOMPARABLE state, not a sentinel
 * string. A sentinel would be forgeable — a corrupt/hostile marker could store
 * it and make a malformed source match, skipping strict preflight (R4 P1-4).
 * null never equals a stored value, so the caller always falls through to the
 * fail-closed path.
 */
function fingerprintSourceFile(path: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return sha256Hex(canonicalJson(parsed));
  } catch {
    return null;
  }
}

/** Marker fingerprints are only ever a sha256 digest or the absent marker (R4 P1-4). */
function isValidStoredFingerprint(value: unknown): value is string {
  return typeof value === 'string' && (value === FINGERPRINT_ABSENT || SHA256_HEX.test(value));
}

/** Compare a computed fingerprint against stored evidence; null never matches. */
function fingerprintMatches(computed: string | null, stored: string | undefined): boolean {
  return computed !== null && stored !== undefined && computed === stored;
}

/** Read the durable completion marker from the workspace store (corrupt → null → re-preflight). */
function readRuntimeMigrationMarker(workspaceRoot: string): RuntimeMigrationMarker | null {
  const markerPath = resolve(workspaceRoot, CONFIG_SUBDIR, RUNTIME_MIGRATION_MARKER);
  if (!existsSync(markerPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    // Unknown schema version → the evidence semantics are not ours to trust;
    // fall back to full preflight (R3 P2-1).
    if ((parsed as { v?: unknown }).v !== 1) return null;
    const fingerprints = (parsed as { sourceFingerprints?: unknown }).sourceFingerprints;
    if (typeof fingerprints !== 'object' || fingerprints === null || Array.isArray(fingerprints)) return null;
    // Both required keys must be present AND in-domain (digest | absent).
    // Anything else is not completion evidence we wrote (R4 P1-4).
    const record = fingerprints as Record<string, unknown>;
    for (const key of [ACCOUNTS_FILENAME, CREDENTIALS_FILENAME]) {
      if (!isValidStoredFingerprint(record[key])) return null;
    }
    return { sourceFingerprints: record as Record<string, string> };
  } catch {
    // Corrupt marker → re-run preflight idempotently; never fail startup on marker parse.
    return null;
  }
}

/** Write the durable completion marker atomically (P1: cross-process evidence). */
function writeRuntimeMigrationMarker(workspaceRoot: string, sourceFingerprints: Record<string, string>): void {
  const markerPath = resolve(workspaceRoot, CONFIG_SUBDIR, RUNTIME_MIGRATION_MARKER);
  const payload = {
    v: 1,
    migratedAt: new Date().toISOString(),
    sourceFingerprints,
  };
  assertSafeCatalogWrite(workspaceRoot, 'catalog-accounts.runtimeMigrationMarker');
  mkdirSync(resolve(workspaceRoot, CONFIG_SUBDIR), { recursive: true });
  // 0600: the marker carries the sha256 of credentials.json content — a
  // world-readable copy would hand other local users an offline verifier for
  // guessed credential values (R3 P1-1).
  writeFileAtomic(markerPath, `${JSON.stringify(payload, null, 2)}\n`, 0o600);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function credEntriesEquivalent(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function readRuntimeJsonStrict(path: string, what: string): Record<string, unknown> {
  // Strict parse: malformed source must fail migration before any write (P1-3).
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid ${what} JSON at ${path}: expected object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Strict TARGET read for migration preflight (P1): a missing file is an empty
 * store, but a malformed file must fail closed — never "back up then treat as
 * empty", which would let the migration silently overwrite a damaged target.
 */
function readTargetJsonStrict(path: string, what: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return readRuntimeJsonStrict(path, what);
}

/** Merge stale runtime-checkout accounts/credentials into the workspace store. */
function migrateRuntimeStaleAccountsToWorkspace(): void {
  // INV-2: explicit store override wins — no runtime redirect, no stale import.
  if (process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT) return;
  const runtimeRootRaw = process.env.CAT_CAFE_RUNTIME_ROOT;
  const workspaceRootRaw = process.env.CAT_CAFE_WORKSPACE_ROOT;
  if (!runtimeRootRaw || !workspaceRootRaw) return;
  const runtimeRoot = resolve(runtimeRootRaw);
  const workspaceRoot = resolve(workspaceRootRaw);
  if (runtimeRoot === workspaceRoot) return;
  const key = runtimeRoot;
  if (migratedRuntimeStale.has(key)) return;

  // P1-8: everything below READS both stores — source fingerprints, the marker,
  // the full preflight — long before the first write guard runs. When the source
  // is empty or the marker already matches, no write guard ever runs at all, so
  // a bare test used to resolve the operator's real accounts and credentials and
  // exit 0. Refuse at the point the roots are known to be real and distinct.
  assertSafeTestConfigRead(runtimeRoot, 'catalog-accounts.runtimeMigration.source');
  assertSafeTestConfigRead(workspaceRoot, 'catalog-accounts.runtimeMigration.target');

  const runtimeAccountsPath = resolve(runtimeRoot, CONFIG_SUBDIR, ACCOUNTS_FILENAME);
  const runtimeCredPath = resolve(runtimeRoot, CONFIG_SUBDIR, CREDENTIALS_FILENAME);
  const hasRuntimeAccounts = existsSync(runtimeAccountsPath);
  const hasRuntimeCreds = existsSync(runtimeCredPath);
  // INV-4 / P1-4: a credential-only runtime source is still migrated; only a
  // fully absent source short-circuits.
  if (!hasRuntimeAccounts && !hasRuntimeCreds) {
    migratedRuntimeStale.add(key);
    return;
  }

  // ── Durable completion evidence (P1: cross-process) ──
  // The runtime source stays in place as a backup, so the NEXT process must
  // distinguish "already migrated" from "new/changed source". Fingerprint the
  // source files: an unchanged fingerprint skips re-preflight entirely —
  // otherwise a user's legitimate same-id target update would be misread as a
  // migration conflict on every subsequent start.
  const fingerprintAccounts = hasRuntimeAccounts ? fingerprintSourceFile(runtimeAccountsPath) : FINGERPRINT_ABSENT;
  const fingerprintCreds = hasRuntimeCreds ? fingerprintSourceFile(runtimeCredPath) : FINGERPRINT_ABSENT;
  const marker = readRuntimeMigrationMarker(workspaceRoot);
  if (
    marker &&
    fingerprintMatches(fingerprintAccounts, marker.sourceFingerprints[ACCOUNTS_FILENAME]) &&
    fingerprintMatches(fingerprintCreds, marker.sourceFingerprints[CREDENTIALS_FILENAME])
  ) {
    migratedRuntimeStale.add(key);
    return;
  }

  // ── Preflight: read + parse ALL sources and targets BEFORE any write (P1-3) ──
  // Targets are strict too (P1): a malformed workspace file must fail closed,
  // never be "backed up then treated as empty" and silently overwritten.
  const runtimeAccounts: Record<string, AccountConfig> = hasRuntimeAccounts
    ? (readRuntimeJsonStrict(runtimeAccountsPath, 'runtime accounts') as Record<string, AccountConfig>)
    : {};
  const runtimeCreds = hasRuntimeCreds ? readRuntimeJsonStrict(runtimeCredPath, 'runtime credentials') : {};

  const workspaceAccounts = readTargetJsonStrict(resolveAccountsPath(workspaceRoot), 'workspace accounts') as Record<
    string,
    AccountConfig
  >;
  const workspaceCredPath = resolve(workspaceRoot, CONFIG_SUBDIR, CREDENTIALS_FILENAME);
  const workspaceCreds = readTargetJsonStrict(workspaceCredPath, 'workspace credentials');

  // Detect EVERY conflict before modifying anything (INV-5, AC-3).
  const accountsToMerge: Array<[string, AccountConfig]> = [];
  for (const [ref, account] of Object.entries(runtimeAccounts)) {
    if (ref in workspaceAccounts) {
      if (!accountsEquivalent(workspaceAccounts[ref], account)) {
        throw new Error(
          `Runtime→workspace account migration conflict for "${ref}" ` +
            `(${runtimeAccountsPath} vs ${resolveAccountsPath(workspaceRoot)}): ` +
            describeAccountConflict(workspaceAccounts[ref], account),
        );
      }
      // Equivalent duplicate → already present; nothing to merge.
    } else {
      accountsToMerge.push([ref, account]);
    }
  }

  const credsToMerge: Array<[string, unknown]> = [];
  for (const [ref, entry] of Object.entries(runtimeCreds)) {
    if (ref in workspaceCreds) {
      if (!credEntriesEquivalent(workspaceCreds[ref], entry)) {
        // INV-6: never print credential values in errors.
        throw new Error(
          `Runtime→workspace credential migration conflict for "${ref}" ` +
            `(${runtimeCredPath} vs ${workspaceCredPath}); resolve manually. ` +
            `Credential values are not shown.`,
        );
      }
      // Equivalent → already present.
    } else {
      credsToMerge.push([ref, entry]);
    }
  }

  // ── Write phase: atomic per file, only after full preflight passed (INV-7) ──
  if (accountsToMerge.length > 0) {
    const next = { ...workspaceAccounts };
    for (const [ref, account] of accountsToMerge) next[ref] = account;
    writeAllGlobal(next, workspaceRoot);
    console.error(
      `[catalog-accounts] migrated ${accountsToMerge.length} stale runtime account(s) into workspace store`,
    );
  }
  if (credsToMerge.length > 0) {
    const next = { ...workspaceCreds };
    for (const [ref, entry] of credsToMerge) next[ref] = entry;
    assertSafeCatalogWrite(workspaceRoot, 'catalog-accounts.migrateRuntimeStaleAccounts.credentials');
    mkdirSync(resolve(resolveAccountStoreRoot({ projectRoot: workspaceRoot }), CONFIG_SUBDIR), { recursive: true });
    writeFileAtomic(workspaceCredPath, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    console.error(
      `[catalog-accounts] migrated ${credsToMerge.length} stale runtime credential(s) into workspace store`,
    );
  }

  // INV-7 / P1: durable completion evidence — written only after BOTH target
  // writes succeeded. Any throw above leaves the source unretired → next
  // startup re-runs preflight idempotently (unchanged source fingerprint → skip;
  // rollback-changed source → explicit conflict against the updated target).
  // Unparseable sources cannot reach here (strict preflight threw), so a null
  // fingerprint is a contract violation — never persist one as evidence (R4 P1-4).
  if (fingerprintAccounts === null || fingerprintCreds === null) {
    throw new Error(
      'Runtime→workspace migration completed with an unparseable source fingerprint — refusing to write completion evidence',
    );
  }
  writeRuntimeMigrationMarker(workspaceRoot, {
    [ACCOUNTS_FILENAME]: fingerprintAccounts,
    [CREDENTIALS_FILENAME]: fingerprintCreds,
  });
  migratedRuntimeStale.add(key);
}

/** Reset migration state (for tests). */
export function resetMigrationState(): void {
  legacyMigrationDone = false;
  migratedHomedirLegacy.clear();
  migratedHomedirCredentials.clear();
  migratedProjects.clear();
  migratedProjectLegacy.clear();
  migratedRuntimeStale.clear();
}

// ── Public API (signatures kept backward-compatible, projectRoot used for migration) ──

export function readCatalogAccounts(projectRoot: string): Record<string, AccountConfig> {
  ensureMigrated(projectRoot);
  return readAllGlobal(projectRoot);
}

export function writeCatalogAccount(projectRoot: string, ref: string, account: AccountConfig): void {
  ensureMigrated(projectRoot);
  const accounts = readAllGlobal(projectRoot);
  accounts[ref] = account;
  writeAllGlobal(accounts, projectRoot);
}

export function deleteCatalogAccount(projectRoot: string, ref: string): void {
  ensureMigrated(projectRoot);
  const accounts = readAllGlobal(projectRoot);
  if (!(ref in accounts)) return;
  delete accounts[ref];
  writeAllGlobal(accounts, projectRoot);
}

/** Check if legacy provider-profiles.json exists in any known location. */
export function hasLegacyProviderProfiles(projectRoot: string): boolean {
  // P1-11: an existence probe is still a read of that root, and this reader runs
  // no migration first — it is always its own first open, so an earlier guard
  // elsewhere can never be the one that refuses. Two roots, two guards, each
  // immediately before the open it protects.
  assertSafeCatalogRead(projectRoot, 'catalog-accounts.hasLegacyProviderProfiles.store');
  if (existsSync(resolve(resolveAccountStoreRoot({ projectRoot }), CONFIG_SUBDIR, 'provider-profiles.json')))
    return true;
  assertSafeMigrationRead(projectRoot, 'catalog-accounts.hasLegacyProviderProfiles.project');
  return existsSync(resolve(projectRoot, CONFIG_SUBDIR, 'provider-profiles.json'));
}
