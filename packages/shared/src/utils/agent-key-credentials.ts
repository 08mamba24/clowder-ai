import { readFileSync } from 'node:fs';

/**
 * Agent-key credential availability — the single semantic baseline shared by
 * the MCP server toolset gate, the api-side union synthesizers (antigravity
 * McpToolExecutor + mcp-config adapters), and callback routing.
 *
 * Ported from the mcp-server callback auth path (resolveAgentKeySecret):
 * a present env var is NOT a usable credential. Resolution precedence:
 *   1. CAT_CAFE_AGENT_KEY_FILES (non-empty) → the variant map is the ONLY
 *      source; no fallback to SECRET / single FILE.
 *   2. CAT_CAFE_AGENT_KEY_SECRET (non-empty after trim).
 *   3. CAT_CAFE_AGENT_KEY_FILE → usable only when the file reads non-empty.
 */

/** Read a sidecar key file; missing/unreadable/empty → undefined. */
export function readAgentKeyFileSync(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const content = readFileSync(path, 'utf-8').trim();
    return content || undefined;
  } catch {
    // sidecar missing = no agent-key (not an error)
    return undefined;
  }
}

/**
 * Parse the CAT_CAFE_AGENT_KEY_FILES JSON map. Bad JSON, non-objects, arrays,
 * and entries whose path is empty after trim are dropped; a fully invalid
 * payload yields {} (never throws).
 */
export function parseAgentKeyFileMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const files: Record<string, string> = {};
    for (const [catId, filePath] of Object.entries(parsed)) {
      if (typeof filePath === 'string' && filePath.trim()) {
        files[catId] = filePath.trim();
      }
    }
    return files;
  } catch {
    return {};
  }
}

/** A sidecar path counts as a credential only when it reads non-empty. */
export function agentKeyFileUsable(path: string | undefined): boolean {
  return readAgentKeyFileSync(path) !== undefined;
}

/**
 * Whether `env` carries at least one USABLE agent-key credential, mirroring
 * the runtime auth resolution semantics. Union synthesizers and the readonly
 * toolset gate must both consult this — a `'{}'` map, a bad-JSON map, an
 * empty secret, or a path to a missing sidecar are all "no credentials".
 *
 * Accepts any string-valued env mapping (NodeJS.ProcessEnv, Record<string,string>).
 */
export function hasUsableAgentKeyCredentials(env: Readonly<Record<string, string | undefined>>): boolean {
  const files = env.CAT_CAFE_AGENT_KEY_FILES?.trim();
  if (files) {
    return Object.values(parseAgentKeyFileMap(files)).some((path) => agentKeyFileUsable(path));
  }
  if (env.CAT_CAFE_AGENT_KEY_SECRET?.trim()) return true;
  return agentKeyFileUsable(env.CAT_CAFE_AGENT_KEY_FILE?.trim());
}
