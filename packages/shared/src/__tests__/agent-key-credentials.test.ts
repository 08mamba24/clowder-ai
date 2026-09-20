import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentKeyFileUsable,
  hasUsableAgentKeyCredentials,
  parseAgentKeyFileMap,
  readAgentKeyFileSync,
} from '../utils/agent-key-credentials.js';

let tmpDir: string | undefined;

function sidecar(content = 'agent-key-material'): string {
  tmpDir ??= mkdtempSync(join(tmpdir(), 'agent-key-creds-test-'));
  const path = join(tmpDir, `key-${Math.random().toString(36).slice(2)}.secret`);
  writeFileSync(path, content, 'utf-8');
  return path;
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('parseAgentKeyFileMap', () => {
  it('parses a valid variant map and trims paths', () => {
    expect(parseAgentKeyFileMap('{"a":"/k/a.secret","b":" /k/b.secret "}')).toEqual({
      a: '/k/a.secret',
      b: '/k/b.secret',
    });
  });

  it('drops empty-path entries', () => {
    expect(parseAgentKeyFileMap('{"a":"  ","b":"/k/b.secret"}')).toEqual({ b: '/k/b.secret' });
  });

  it('bad JSON / arrays / scalars / empty → {}', () => {
    expect(parseAgentKeyFileMap('not json')).toEqual({});
    expect(parseAgentKeyFileMap('["/k/a.secret"]')).toEqual({});
    expect(parseAgentKeyFileMap('"just-a-string"')).toEqual({});
    expect(parseAgentKeyFileMap('')).toEqual({});
    expect(parseAgentKeyFileMap(undefined)).toEqual({});
  });
});

describe('readAgentKeyFileSync / agentKeyFileUsable', () => {
  it('reads and trims a real file; blank file is unusable', () => {
    const path = sidecar('  material  \n');
    expect(readAgentKeyFileSync(path)).toBe('material');
    expect(agentKeyFileUsable(path)).toBe(true);

    const blank = sidecar('   \n');
    expect(agentKeyFileUsable(blank)).toBe(false);
  });

  it('missing/unreadable path → undefined / false, never throws', () => {
    expect(readAgentKeyFileSync(undefined)).toBeUndefined();
    expect(readAgentKeyFileSync('/nonexistent/agent-key.secret')).toBeUndefined();
    expect(agentKeyFileUsable('/nonexistent/agent-key.secret')).toBe(false);
  });
});

describe('hasUsableAgentKeyCredentials', () => {
  it('non-empty SECRET alone is usable', () => {
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_SECRET: 'secret-material' })).toBe(true);
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_SECRET: '   ' })).toBe(false);
  });

  it('single FILE counts only when the sidecar reads non-empty', () => {
    const path = sidecar();
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_FILE: path })).toBe(true);
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_FILE: '/nonexistent.secret' })).toBe(false);
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_FILE: '   ' })).toBe(false);
  });

  it('non-empty FILES disables fallback: {} map, bad JSON, all-missing sidecars → false even with SECRET set', () => {
    const path = sidecar();
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_FILES: '{}', CAT_CAFE_AGENT_KEY_SECRET: 's' })).toBe(
      false,
    );
    expect(hasUsableAgentKeyCredentials({ CAT_CAFE_AGENT_KEY_FILES: 'not-json', CAT_CAFE_AGENT_KEY_SECRET: 's' })).toBe(
      false,
    );
    expect(
      hasUsableAgentKeyCredentials({
        CAT_CAFE_AGENT_KEY_FILES: '{"a":"/nonexistent.secret"}',
        CAT_CAFE_AGENT_KEY_SECRET: 's',
      }),
    ).toBe(false);
    expect(
      hasUsableAgentKeyCredentials({
        CAT_CAFE_AGENT_KEY_FILES: `{"a":"/nonexistent.secret","b":"${path}"}`,
        CAT_CAFE_AGENT_KEY_SECRET: 's',
      }),
    ).toBe(true);
  });

  it('no vars at all → false', () => {
    expect(hasUsableAgentKeyCredentials({})).toBe(false);
  });
});
