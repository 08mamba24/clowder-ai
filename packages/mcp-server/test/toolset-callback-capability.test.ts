/**
 * Mount-capability projection (F317 follow-up).
 *
 * A launcher can declare that its MCP mount has no invocation/agent-key
 * callback credentials (`CAT_CAFE_MCP_CALLBACK_CREDENTIALS=false`). The
 * canonical projection must then withhold tools whose only authorization path
 * is a callback, while leaving every other mount's surface unchanged.
 *
 * This is a declaration, never a probe: no getCallbackConfig() call is allowed
 * to decide the advertised surface.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { applyReadonlyFilter, buildMemoryTools, parseToolsetEnv, type ToolsetEnv } from '../src/server-toolsets.js';

const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name).sort();

const READONLY_WITHOUT_CALLBACK: ToolsetEnv = {
  readonly: true,
  callbackCredentials: false,
  hasAgentKey: false,
  agentKeyUnion: false,
};

describe('callback capability projection', () => {
  it('defaults to the historical surface when the capability bit is absent', () => {
    const env = parseToolsetEnv({ CAT_CAFE_READONLY: 'true' } as NodeJS.ProcessEnv);
    assert.equal(env.callbackCredentials, undefined);
    const surface = names(buildMemoryTools(env));
    assert.ok(surface.includes('cat_cafe_get_recall_metrics'), 'default readonly mount still advertises metrics');
    assert.ok(surface.includes('cat_cafe_read_meeting_artifact'), 'default readonly mount still advertises meeting');
  });

  it('only an explicit false narrows; truthy-looking values keep the default', () => {
    for (const value of ['true', '0', '', undefined]) {
      const env = parseToolsetEnv({
        CAT_CAFE_READONLY: 'true',
        ...(value === undefined ? {} : { CAT_CAFE_MCP_CALLBACK_CREDENTIALS: value }),
      } as NodeJS.ProcessEnv);
      assert.notEqual(env.callbackCredentials, false, `value ${JSON.stringify(value)} must not narrow`);
    }
    assert.equal(
      parseToolsetEnv({
        CAT_CAFE_READONLY: 'true',
        CAT_CAFE_MCP_CALLBACK_CREDENTIALS: 'false',
      } as NodeJS.ProcessEnv).callbackCredentials,
      false,
    );
  });

  it('withholds callback-only tools from a mount without callback credentials', () => {
    const surface = names(buildMemoryTools(READONLY_WITHOUT_CALLBACK));
    for (const withheld of ['cat_cafe_get_recall_metrics', 'cat_cafe_read_meeting_artifact']) {
      assert.ok(!surface.includes(withheld), `${withheld} must not be advertised without callback credentials`);
    }
    for (const kept of [
      'cat_cafe_search_evidence',
      'cat_cafe_list_external_runtime_sessions',
      'cat_cafe_read_external_runtime_session',
      'cat_cafe_list_session_chain',
      'cat_cafe_graph_resolve',
    ]) {
      assert.ok(surface.includes(kept), `${kept} has a local-process path and must stay advertised`);
    }
  });

  it('applies the same narrowing through applyReadonlyFilter', () => {
    const tools = buildMemoryTools({ readonly: true, hasAgentKey: false, agentKeyUnion: false }).map((tool) => ({
      name: tool.name,
    }));
    const filtered = applyReadonlyFilter(tools, READONLY_WITHOUT_CALLBACK).map((tool) => tool.name);
    assert.ok(!filtered.includes('cat_cafe_get_recall_metrics'));
    assert.ok(!filtered.includes('cat_cafe_read_meeting_artifact'));
    assert.ok(filtered.includes('cat_cafe_search_evidence'));
    assert.deepEqual(filtered, names(buildMemoryTools(READONLY_WITHOUT_CALLBACK)));
  });
});
