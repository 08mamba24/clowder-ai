import { createHash } from 'node:crypto';
import { builtinAccountIdForClient, type CatCafeConfig } from '@cat-cafe/shared';
import { resolveByAccountRef, validateRuntimeProviderBinding } from './account-resolver.js';
import { toAllCatConfigs } from './cat-config-loader.js';
import { resolveCodexAccountLaunch } from './codex-account-launch.js';
import { assertCodexSharedStateRoots } from './codex-shared-state.js';

export interface CodexBindingSelection {
  accountRef: string;
  catId: string;
  scope: 'cat' | 'family';
}
export function planCodexAccountBinding(projectRoot: string, catalog: CatCafeConfig, selection: CodexBindingSelection) {
  const cats = toAllCatConfigs(catalog);
  const chosen = cats[selection.catId];
  const local = (id: string) => id !== 'gpt-pro' && cats[id]?.clientId === 'openai' && !!cats[id]?.cli;
  if (!chosen || !local(selection.catId)) throw new Error('Only local Codex members can switch accounts');
  const family = (id: string) =>
    catalog.version === 2 ? (catalog.roster[id]?.family ?? cats[id].breedId) : cats[id].breedId;
  const targets = Object.keys(cats)
    .filter(
      (id) =>
        local(id) && (selection.scope === 'cat' ? id === selection.catId : family(id) === family(selection.catId)),
    )
    .sort();
  const profile = resolveByAccountRef(projectRoot, selection.accountRef);
  if (!profile) throw new Error('Codex account not found');
  for (const id of targets) {
    const error = validateRuntimeProviderBinding('openai', profile, cats[id].defaultModel);
    if (error) throw new Error(error);
  }
  const launch = resolveCodexAccountLaunch(profile, { cwd: projectRoot });
  if (launch.managed || launch.accountRef === 'codex') assertCodexSharedStateRoots(projectRoot, { launch });
  const previewToken = createHash('sha256')
    .update(JSON.stringify({ catalog, targets, accountRevision: launch.accountRevision }))
    .digest('hex');
  return {
    previewToken,
    accountRef: selection.accountRef,
    targets: targets.map((id) => ({
      catId: id,
      name: cats[id].nickname || cats[id].displayName,
      previousAccountRef: cats[id].accountRef ?? builtinAccountIdForClient('openai'),
    })),
    nextRequestOnly: true,
  };
}
