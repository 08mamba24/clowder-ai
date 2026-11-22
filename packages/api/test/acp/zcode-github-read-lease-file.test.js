import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  clearZcodeGhReadLeaseFile,
  writeZcodeGhReadLeaseFile,
  zcodeGhReadLeaseFileForProviderConfig,
} from '../../dist/domains/cats/services/agents/providers/acp/zcode/zcode-github-read-lease-file.js';

const TOKEN = 'a'.repeat(43);

test('the lease file is a sibling of the process provider input, not a shared HOME file', () => {
  const runtime = mkdtempSync(join(tmpdir(), 'zcode-lease-'));
  try {
    const providerConfig = join(runtime, 'provider.json');
    const path = zcodeGhReadLeaseFileForProviderConfig(providerConfig);
    assert.equal(path, join(runtime, 'gh-read-lease.json'));
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('writeZcodeGhReadLeaseFile stores url+token at 0600 with no staging residue', () => {
  const runtime = mkdtempSync(join(tmpdir(), 'zcode-lease-'));
  try {
    const path = join(runtime, 'gh-read-lease.json');
    writeZcodeGhReadLeaseFile(path, { url: 'http://127.0.0.1:43210/api/agent-github-read', token: TOKEN });
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(stored, { url: 'http://127.0.0.1:43210/api/agent-github-read', token: TOKEN });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(!existsSync(`${path}.tmp`));
    // A rewrite replaces only this process's file.
    writeZcodeGhReadLeaseFile(path, { url: 'http://127.0.0.1:43211/api/agent-github-read', token: 'b'.repeat(43) });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, 'b'.repeat(43));
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('clearZcodeGhReadLeaseFile removes the lease and tolerates a missing file', () => {
  const runtime = mkdtempSync(join(tmpdir(), 'zcode-lease-'));
  try {
    const path = join(runtime, 'gh-read-lease.json');
    clearZcodeGhReadLeaseFile(path);
    writeZcodeGhReadLeaseFile(path, { url: 'http://127.0.0.1:43210/api/agent-github-read', token: TOKEN });
    clearZcodeGhReadLeaseFile(path);
    assert.ok(!existsSync(path));
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
});
