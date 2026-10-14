import { normalizeMcpToolName } from '../tool-usage/normalize-mcp-tool-name.js';

const READ_ONLY_NATIVE_TOOLS = new Set([
  'glob',
  'grep',
  'lsp',
  'ls',
  'read',
  'skill',
  'toolsearch',
  'webfetch',
  'websearch',
]);

const MAX_REPLAY_UNSAFE_TOOL_NAMES = 16;

/**
 * Blind replay is allowed only when every observed tool is reviewed read-only.
 * Unknown names fail closed because a provider may report success after a partial
 * external effect; the closure can still continue through explicit retry.
 */
export function findReplayUnsafeToolNames(toolNames: readonly string[]): string[] {
  const unsafe = new Set<string>();
  for (const rawName of toolNames) {
    const name = rawName.trim();
    if (!name) continue;
    if (isReadOnlyMcpTool(name) || isReadOnlyMcpTool(normalizeMcpToolName(name))) continue;
    if (READ_ONLY_NATIVE_TOOLS.has(name.toLowerCase())) continue;
    unsafe.add(name);
  }
  return [...unsafe].sort().slice(0, MAX_REPLAY_UNSAFE_TOOL_NAMES);
}

const READ_ONLY_MCP_TOOLS = new Set<string>([
  'grep_search',
  'list_dir',
  'read_file',
  'search_evidence',
  'cat_cafe_search_evidence',
  'graph_resolve',
  'cat_cafe_graph_resolve',
  'list_recent',
  'cat_cafe_list_recent',
  'view_file',
  'cat_cafe_get_rich_block_rules',
  'cat_cafe_list_session_chain',
  'cat_cafe_read_session_events',
  'cat_cafe_read_session_digest',
  'cat_cafe_read_invocation_detail',
  'cat_cafe_read_file_slice',
  'pull_request_read',
  // Safety depends on mcp-server/src/tools/shell-tools.ts enforcing a strict
  // read-only command whitelist; f254-tool-replay-safety.test.js guards both sides.
  'cat_cafe_shell_exec',
  'signal_list_inbox',
  'signal_get_article',
  'signal_search',
  'signal_list_studies',
  'get_thread_context',
  'cat_cafe_get_thread_context',
  'list_threads',
  'cat_cafe_list_threads',
]);

export function isReadOnlyMcpTool(toolName: string | undefined): boolean {
  const normalized = toolName?.trim().toLowerCase();
  if (!normalized) return false;
  for (const allowed of READ_ONLY_MCP_TOOLS) {
    if (normalized === allowed) return true;
    if (normalized.endsWith(`__${allowed}`)) return true;
  }
  return false;
}
