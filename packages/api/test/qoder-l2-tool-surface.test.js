/**
 * F317 L2 cross-package drift gate.
 *
 * Qoder's init gate must pin the exact surface the split readonly memory
 * server advertises on the Qoder mount. The API cannot import the MCP server
 * package at runtime, so it consumes a generated static artifact; this test
 * makes that artifact fail closed when the canonical registry drifts.
 *
 * The mount capability matters: the Qoder shim receives identity vars only and
 * never callback credentials, so tools whose only authorization path is a
 * callback (recall metrics, meeting artifacts) are not advertised there. The
 * projection is therefore compared against
 * buildMemoryTools({ readonly: true, callbackCredentials: false }), not the
 * broader default readonly surface.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const api = await import(
  join(here, '..', 'dist', 'domains', 'cats', 'services', 'agents', 'providers', 'QoderAgentService.js')
);
const mcp = await import(join(here, '..', '..', 'mcp-server', 'dist', 'server-toolsets.js'));

const namesOf = (tools) => tools.map((tool) => tool.name).sort();

test('F317 L2: qoder readonly-memory allowlist equals the canonical projection for its real capability', () => {
  const qoderSurface = namesOf(
    mcp.buildMemoryTools({ readonly: true, callbackCredentials: false, hasAgentKey: false, agentKeyUnion: false }),
  );
  assert.deepEqual([...api.QODER_READONLY_MEMORY_TOOLS].sort(), qoderSurface);

  // The capability bit must actually narrow the surface: the default readonly
  // mount advertises callback-only tools the Qoder mount cannot call. Compare
  // sets, never a pinned literal count.
  const defaultReadonly = namesOf(mcp.buildMemoryTools({ readonly: true, hasAgentKey: false, agentKeyUnion: false }));
  const withheld = defaultReadonly.filter((name) => !qoderSurface.includes(name));
  assert.ok(
    withheld.length > 0,
    'callbackCredentials=false must withhold at least one callback-only tool from the Qoder mount',
  );
  assert.deepEqual(
    withheld.filter((name) => name !== 'cat_cafe_get_recall_metrics'),
    [],
    `only callback-only tools may be withheld; unexpected withheld set: ${JSON.stringify(withheld)}`,
  );
});

test('F317 L2: the generated artifact is fresh against the canonical registry', () => {
  execFileSync(process.execPath, [join(repoRoot, 'scripts', 'generate-fork-memory-projection.mjs'), '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
});
