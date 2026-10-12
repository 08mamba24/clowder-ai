import { type AccountConfig, builtinAccountFamilyForRef } from '@cat-cafe/shared';
import { resolveByAccountRef } from '../config/account-resolver.js';
import { codexManagedStatus, readCodexAccountIdentity } from '../config/codex-account-identity.js';
import { resolveCodexAccountLaunch } from '../config/codex-account-launch.js';
// clowder-ai#340: Derive client identity from well-known account IDs, not stored protocol.
/** Synthesize a ProviderProfileView-compatible object from AccountConfig. */
export function accountToView(id: string, account: AccountConfig, apiKeyPresent: boolean, projectRoot?: string) {
  const isBuiltin = account.authType === 'oauth' && !!builtinAccountFamilyForRef(id);
  const builtinClient = builtinAccountFamilyForRef(id);
  const clientId = account.clientId ?? (isBuiltin ? builtinClient : undefined);
  const defaultCodex =
    projectRoot && clientId === 'openai' && account.authType === 'oauth' && !account.codex
      ? resolveByAccountRef(projectRoot, id)
      : null;
  const codexLoginStatus =
    defaultCodex && projectRoot
      ? readCodexAccountIdentity(resolveCodexAccountLaunch(defaultCodex, { cwd: projectRoot }).credentialHome)
        ? ('ready' as const)
        : ('not_logged_in' as const)
      : undefined;
  return {
    id,
    ...(codexLoginStatus ? { codexLoginStatus } : {}),
    name: account.displayName ?? id,
    displayName: account.displayName ?? id,
    authType: account.authType,
    builtin: isBuiltin,
    ...(account.quota ? { quota: account.quota } : {}),
    kind: isBuiltin ? 'builtin' : account.authType,
    ...(account.codex ? { codex: { ...account.codex, status: codexManagedStatus(account.codex) } } : {}),
    ...(clientId ? { clientId } : {}),
    ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
    models: account.models ? [...account.models] : [],
    ...(account.modelAliases && Object.keys(account.modelAliases).length > 0
      ? { modelAliases: { ...account.modelAliases } }
      : {}),
    hasApiKey: apiKeyPresent,
    mode: account.authType === 'api_key' ? ('api_key' as const) : ('subscription' as const),
    ...(account.envVars && Object.keys(account.envVars).length > 0 ? { envVars: { ...account.envVars } } : {}),
    createdAt: '',
    updatedAt: '',
  };
}

/** Derive a slug-like ID from display name, avoiding collisions with existing accounts. */
export function deriveAccountId(displayName: string, existingIds: Set<string>, customApiKey: boolean): string {
  let seed =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `account-${Date.now()}`;
  if (customApiKey && builtinAccountFamilyForRef(seed)) seed = `custom-${seed}`;
  if (!existingIds.has(seed)) return seed;
  let counter = 2;
  while (existingIds.has(`${seed}-${counter}`)) counter += 1;
  return `${seed}-${counter}`;
}
