/**
 * F317 L2 cross-package drift gate.
 *
 * Qoder's init gate must pin the exact surface exposed by the split readonly
 * memory server. The API cannot import the MCP server package at runtime, so
 * this test makes the intentional duplicated projection fail closed in CI.
 */

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const api = await import(
  join(here, '..', 'dist', 'domains', 'cats', 'services', 'agents', 'providers', 'QoderAgentService.js')
);
const mcp = await import(join(here, '..', '..', 'mcp-server', 'dist', 'server-toolsets.js'));

test('F317 L2: qoder readonly-memory allowlist equals the canonical split memory projection', () => {
  const canonical = mcp
    .buildMemoryTools({ readonly: true, hasAgentKey: true, agentKeyUnion: false })
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual([...api.QODER_READONLY_MEMORY_TOOLS].sort(), canonical);
  assert.equal(canonical.length, 12);
});
