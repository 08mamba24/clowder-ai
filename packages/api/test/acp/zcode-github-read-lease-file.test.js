import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  clearZcodeGhReadLeaseFile,
  writeZcodeGhReadLeaseFile,
  zcodeGhReadLeaseFilePath,
} from '../../dist/domains/cats/services/agents/providers/acp/zcode/zcode-github-read-lease-file.js';

const TOKEN = 'a'.repeat(43);
const OTHER_TOKEN = 'b'.repeat(43);

function lease(token = TOKEN) {
  return {
    token,
    queryUrl: 'http://127.0.0.1:43210/api/agent-github-read',
    mcpUrl: 'http://127.0.0.1:43210/api/agent-github-read/mcp',
    revoke: () => {},
  };
}

test('writeZcodeGhReadLeaseFile stores url+token at 0600 under the isolated home', () => {
  const home = mkdtempSync(join(tmpdir(), 'zcode-lease-'));
  try {
    const path = writeZcodeGhReadLeaseFile(home, lease());
    assert.equal(path, zcodeGhReadLeaseFilePath(home));
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(stored, { url: 'http://127.0.0.1:43210/api/agent-github-read', token: TOKEN });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(!existsSync(`${path}.tmp`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('clearZcodeGhReadLeaseFile removes its own lease and keeps a newer attempt file', () => {
  const home = mkdtempSync(join(tmpdir(), 'zcode-lease-'));
  try {
    writeZcodeGhReadLeaseFile(home, lease(TOKEN));
    writeZcodeGhReadLeaseFile(home, lease(OTHER_TOKEN));
    clearZcodeGhReadLeaseFile(home, TOKEN);
    const kept = JSON.parse(readFileSync(zcodeGhReadLeaseFilePath(home), 'utf8'));
    assert.equal(kept.token, OTHER_TOKEN);
    clearZcodeGhReadLeaseFile(home, OTHER_TOKEN);
    assert.ok(!existsSync(zcodeGhReadLeaseFilePath(home)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('clearZcodeGhReadLeaseFile tolerates a missing, malformed, or foreign-written file', () => {
  const home = mkdtempSync(join(tmpdir(), 'zcode-lease-'));
  try {
    clearZcodeGhReadLeaseFile(home, TOKEN);
    const path = zcodeGhReadLeaseFilePath(home);
    writeFileSync(path, 'not-json', { mode: 0o600 });
    clearZcodeGhReadLeaseFile(home, TOKEN);
    clearZcodeGhReadLeaseFile(home);
    assert.ok(!existsSync(path));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
