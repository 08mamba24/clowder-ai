import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AGENT_KEY_TOOLS,
  buildLimbTools,
  parseToolsetEnv,
  READONLY_ALLOWED_TOOLS,
  registerFullToolset,
  type ToolsetEnv,
} from '../src/server-toolsets.js';

/**
 * #1494 formal-review regressions:
 *  - P1-2: agent-key availability is credential USABILITY (mirrors the
 *    callback auth resolution semantics), not env-var presence. A `'{}'`
 *    variant map, bad JSON, an empty secret, or a path to a missing sidecar
 *    must all count as "no credentials" for the readonly+agent-key union.
 *  - P2: registerFullToolset must honor the injected ToolsetEnv end to end
 *    (parse once) — an invalid ambient CAT_CAFE_MCP_PROFILE must not throw
 *    when an explicit env was provided.
 */

let tmpDir: string | undefined;

function sidecar(content = 'agent-key-material'): string {
  tmpDir ??= mkdtempSync(join(tmpdir(), 'agent-key-usability-test-'));
  const filePath = join(tmpDir, `key-${Math.random().toString(36).slice(2)}.secret`);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function registeredNames(env?: ToolsetEnv): Set<string> {
  const server = new McpServer({ name: 'agent-key-usability-test', version: '0.0.1' });
  registerFullToolset(server, env);
  const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return new Set(Object.keys(registry));
}

// limb family is deliberately unfiltered by readonly (F061 antigravity contract).
function limbNames(env?: ToolsetEnv): string[] {
  return buildLimbTools(env).map((tool) => tool.name);
}

function strictExpected(env?: ToolsetEnv): Set<string> {
  return new Set([...READONLY_ALLOWED_TOOLS, ...limbNames(env)]);
}

describe('parseToolsetEnv — hasAgentKey is credential usability, not env presence', () => {
  it('non-empty SECRET is usable; blank SECRET is not', () => {
    assert.equal(parseToolsetEnv({ CAT_CAFE_AGENT_KEY_SECRET: 'material' }).hasAgentKey, true);
    assert.equal(parseToolsetEnv({ CAT_CAFE_AGENT_KEY_SECRET: '   ' }).hasAgentKey, false);
  });

  it('single FILE counts only when the sidecar exists and reads non-empty', () => {
    const filePath = sidecar();
    assert.equal(parseToolsetEnv({ CAT_CAFE_AGENT_KEY_FILE: filePath }).hasAgentKey, true);
    assert.equal(
      parseToolsetEnv({ CAT_CAFE_AGENT_KEY_FILE: '/nonexistent/agent-key.secret' }).hasAgentKey,
      false,
      'a path to a missing sidecar is not a credential',
    );
    assert.equal(parseToolsetEnv({ CAT_CAFE_AGENT_KEY_FILE: '   ' }).hasAgentKey, false);
  });

  it('variant map: {} / bad JSON / all-missing sidecars → no credentials', () => {
    assert.equal(parseToolsetEnv({ CAT_CAFE_AGENT_KEY_FILES: '{}' }).hasAgentKey, false);
    assert.equal(parseToolsetEnv({ CAT_CAFE_AGENT_KEY_FILES: 'not-json' }).hasAgentKey, false);
    assert.equal(
      parseToolsetEnv({ CAT_CAFE_AGENT_KEY_FILES: '{"a":"/nonexistent/agent-key.secret"}' }).hasAgentKey,
      false,
    );
  });

  it('variant map with at least one readable sidecar → credentials', () => {
    const filePath = sidecar();
    const env = { CAT_CAFE_AGENT_KEY_FILES: `{"a":"/nonexistent/x.secret","antigravity":"${filePath}"}` };
    assert.equal(parseToolsetEnv(env).hasAgentKey, true);
  });

  it('non-empty FILES disables fallback: {} map + ambient SECRET → no credentials', () => {
    const env = { CAT_CAFE_AGENT_KEY_FILES: '{}', CAT_CAFE_AGENT_KEY_SECRET: 'material' };
    assert.equal(
      parseToolsetEnv(env).hasAgentKey,
      false,
      'a present variant map is the only source; SECRET/FILE fallback is disabled',
    );
  });
});

describe('mount surface — maintainer acceptance baseline (#1494)', () => {
  it('strict ambient-secret mount (no opt-in) → exactly READONLY ∪ limb', () => {
    const env = parseToolsetEnv({ CAT_CAFE_READONLY: 'true', CAT_CAFE_AGENT_KEY_SECRET: 'ambient-secret' });
    const names = registeredNames(env);
    assert.deepEqual([...names].sort(), [...strictExpected(env)].sort());
    assert.equal(names.has('cat_cafe_cross_post_message'), false, 'write tool must stay out without opt-in');
  });

  it('explicit opt-in with a usable sidecar → READONLY ∪ AGENT_KEY ∪ limb', () => {
    const env = parseToolsetEnv({
      CAT_CAFE_READONLY: 'true',
      CAT_CAFE_READONLY_AGENT_KEY_UNION: 'true',
      CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ antigravity: sidecar() }),
    });
    const names = registeredNames(env);
    const expected = new Set([...READONLY_ALLOWED_TOOLS, ...AGENT_KEY_TOOLS, ...limbNames(env)]);
    assert.deepEqual([...names].sort(), [...expected].sort());
    assert.equal(names.has('cat_cafe_cross_post_message'), true, 'legit opt-in keeps the union');
  });

  it('explicit opt-in + FILES="{}" → strict surface (no fallback to ambient creds)', () => {
    const env = parseToolsetEnv({
      CAT_CAFE_READONLY: 'true',
      CAT_CAFE_READONLY_AGENT_KEY_UNION: 'true',
      CAT_CAFE_AGENT_KEY_FILES: '{}',
      CAT_CAFE_AGENT_KEY_SECRET: 'ambient-secret',
    });
    const names = registeredNames(env);
    assert.deepEqual([...names].sort(), [...strictExpected(env)].sort());
    assert.equal(
      names.has('cat_cafe_cross_post_message'),
      false,
      'an empty variant map yields zero resolvable keys — the union must not fire',
    );
  });
});

describe('parse-once threading (#1494 P2)', () => {
  it('registerFullToolset with an injected env never re-reads ambient process.env', () => {
    const original = process.env.CAT_CAFE_MCP_PROFILE;
    process.env.CAT_CAFE_MCP_PROFILE = 'bogus-profile';
    try {
      const names = registeredNames({ readonly: true });
      assert.deepEqual([...names].sort(), [...strictExpected({ readonly: true })].sort());
    } finally {
      if (original === undefined) delete process.env.CAT_CAFE_MCP_PROFILE;
      else process.env.CAT_CAFE_MCP_PROFILE = original;
    }
  });
});
