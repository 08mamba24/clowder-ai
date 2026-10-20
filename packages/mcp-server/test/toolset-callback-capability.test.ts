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

  it('does not widen a no-callback mount through incidental agent-key or union flags', () => {
    const tools = [{ name: 'cat_cafe_cross_post_message' }, { name: 'cat_cafe_search_evidence' }];
    // With the union enabled, an agent-key-only tool would normally be added.
    assert.deepEqual(names(applyReadonlyFilter(tools, { readonly: true, hasAgentKey: true, agentKeyUnion: true })), [
      'cat_cafe_cross_post_message',
      'cat_cafe_search_evidence',
    ]);
    // The explicit capability false wins: incidental identity vars cannot make
    // a callback-only tool callable, so it must not be advertised.
    assert.deepEqual(
      names(
        applyReadonlyFilter(tools, {
          readonly: true,
          hasAgentKey: true,
          agentKeyUnion: true,
          callbackCredentials: false,
        }),
      ),
      ['cat_cafe_search_evidence'],
    );
    const env = parseToolsetEnv({
      CAT_CAFE_READONLY: 'true',
      CAT_CAFE_READONLY_AGENT_KEY_UNION: 'true',
      CAT_CAFE_AGENT_KEY_SECRET: 'incidental-agent-key',
      CAT_CAFE_MCP_CALLBACK_CREDENTIALS: 'false',
    } as NodeJS.ProcessEnv);
    assert.equal(env.hasAgentKey, true);
    assert.equal(env.agentKeyUnion, true);
    assert.equal(env.callbackCredentials, false);
    const surface = names(buildMemoryTools(env));
    assert.ok(surface.includes('cat_cafe_search_evidence'), 'local document search stays available');
    assert.ok(!surface.includes('cat_cafe_get_recall_metrics'), 'callback-only metrics stay withheld');
    assert.ok(!surface.includes('cat_cafe_read_meeting_artifact'), 'callback-only meeting reads stay withheld');
  });

  it('reports the message-mode limitation without issuing a callback request', async () => {
    const previousEnv = { ...process.env };
    const previousFetch = globalThis.fetch;
    let requests = 0;
    process.env.CAT_CAFE_MCP_CALLBACK_CREDENTIALS = 'false';
    // Credentials may be inherited incidentally; the declaration still wins.
    process.env.CAT_CAFE_INVOCATION_ID = 'capability-test-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'capability-test-token';
    globalThis.fetch = async () => {
      requests += 1;
      throw new Error('message mode must not reach the callback transport');
    };
    try {
      const { handleSearchEvidence } = await import('../src/tools/evidence-tools.js');
      const result = await handleSearchEvidence({ query: 'piano', resultUnit: 'message' });
      assert.equal(requests, 0, 'a no-callback mount must not attempt a callback request');
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /resultUnit=message requires invocation or agent-key credentials/);
      assert.match(result.content[0].text, /Retry with resultUnit="document"/);
    } finally {
      globalThis.fetch = previousFetch;
      for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
      Object.assign(process.env, previousEnv);
    }
  });
});
