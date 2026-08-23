/**
 * Read-only context capacity projections for config/Hub surfaces.
 * Runtime routing resolves an invocation-owned snapshot with the concrete carrier;
 * this module deliberately exposes no prompt-policy knobs.
 */

import { catRegistry } from '@cat-cafe/shared';
import { getAllCatIdsFromConfig } from './cat-config-loader.js';
import { getCatModel } from './cat-models.js';
import { type ResolvedContextCapacity, resolveContextCapacity } from './context-capacity.js';

export type CatCapacityProjection = Pick<
  ResolvedContextCapacity,
  'windowTokens' | 'inputCeilingTokens' | 'source' | 'actionable' | 'provenance'
>;

/**
 * Origin helper-cat empty-UI floor (2/5 of the 1M-class window).
 * Auto catalog/carrier still wins when it resolves; this only replaces
 * unresolved (the old GLOBAL_FALLBACK 100k path) for glm/deepseek/minimax.
 */
const HELPER_CAT_EMPTY_UI_WINDOW_TOKENS: Record<string, number> = {
  glm: 400_000,
  deepseek: 400_000,
  minimax: 400_000,
};

const HELPER_CAT_OUTPUT_RESERVE = 16_000;

export function getCatCapacity(catName: string): CatCapacityProjection {
  const config = catRegistry.tryGet(catName)?.config;
  const resolved = resolveContextCapacity({
    catId: catName,
    model: config ? getCatModel(catName) : undefined,
  });
  if (resolved.source !== 'unresolved') return resolved;

  const helperWindow = HELPER_CAT_EMPTY_UI_WINDOW_TOKENS[catName];
  if (!helperWindow) return resolved;

  return {
    windowTokens: helperWindow,
    inputCeilingTokens: Math.max(0, helperWindow - HELPER_CAT_OUTPUT_RESERVE),
    source: 'catalog',
    actionable: true,
    provenance: `Helper-cat empty-UI default → ${helperWindow.toLocaleString()} tokens`,
  };
}

export function getAllCatCapacities(): Record<string, CatCapacityProjection> {
  const result: Record<string, CatCapacityProjection> = {};
  const registryIds = catRegistry.getAllIds();
  const allIds = registryIds.length > 0 ? registryIds.map(String) : getAllCatIdsFromConfig();
  for (const catName of allIds) result[catName] = getCatCapacity(catName);
  return result;
}

export function clearBudgetCache(): void {
  // Compatibility test seam: capacity is derived on demand and has no cache.
}
