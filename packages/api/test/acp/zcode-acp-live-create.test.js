// @ts-check
/**
 * Real ZCode 0.16.3, no prompt. Proves clean-home session/create with
 * ZCODE_MODEL env (no native model field) and in-process session/load.
 * Dummy key only. Skip when the bundled binary is absent.
 * Adapter restart persistence is covered by the fake store contract.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { startAdapter } from './helpers/zcode-acp-test-harness.mjs';

const MAC_APP_ZCODE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const LINUX_APP_ZCODE = '/opt/ZCode/app/resources/glm/zcode.cjs';
const bundled = [process.env.CAT_CAFE_ZCODE_BIN, MAC_APP_ZCODE, LINUX_APP_ZCODE].find(
  (path) => path && existsSync(path),
);
const skipLive = !bundled || process.env.CAT_CAFE_ZCODE_SKIP_LIVE === '1';

describe('ZCode ACP live create (real 0.16.3, no prompt)', { skip: skipLive }, () => {
  it('creates and reloads a session in an isolated home without sending a prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-live-create-'));
    const isolatedHome = join(dir, 'isolated-home');
    const liveEnv = {
      ZCODE_BIN: bundled,
      CAT_CAFE_ZCODE_HOME: isolatedHome,
      ZCODE_MODEL: 'GLM-5.2',
      ANTHROPIC_API_KEY: 'dummy-zcode-live-create-not-a-secret',
    };
    const acp = startAdapter(dir, liveEnv);
    try {
      const init = await acp.request('initialize', { protocolVersion: 1 }, 20_000);
      assert.equal(init.error, undefined, JSON.stringify(init.error));
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] }, 45_000);
      assert.equal(created.error, undefined, JSON.stringify(created.error));
      const sessionId = created.result.sessionId;
      assert.ok(sessionId, 'clean-home session/create with ZCODE_MODEL env must succeed without a native model field');
      const loaded = await acp.request('session/load', { sessionId, cwd: dir, mcpServers: [] }, 45_000);
      assert.equal(loaded.error, undefined, JSON.stringify(loaded.error));
      assert.equal(loaded.result.sessionId, sessionId);
    } finally {
      acp.child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        acp.child.once('exit', () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
