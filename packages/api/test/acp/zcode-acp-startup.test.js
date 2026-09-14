// @ts-check
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { startAdapter } from './helpers/zcode-acp-test-harness.mjs';

const { resolveZcodeBin } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/zcode-acp-bootstrap.js'
);
const { NativeAppServer } = await import('../../dist/domains/cats/services/agents/providers/acp/zcode-acp-native.js');

/** A real stdio child checks the environment before accepting any native RPC. */
function fixture(layout = 'bundle', behavior = 'ready') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zcode-startup-')));
  const root = join(dir, 'ZCode.app', 'Contents', 'Resources');
  const bin = join(root, 'glm', 'zcode.cjs');
  const builtin =
    layout === 'bundle'
      ? join(root, 'config', 'provider', 'zcode-builtin.json')
      : join(dirname(bin), 'provider', 'zcode-builtin.json');
  mkdirSync(dirname(bin), { recursive: true });
  if (layout !== 'missing') {
    mkdirSync(dirname(builtin), { recursive: true });
    writeFileSync(builtin, '{"fixture":"official-builtin"}\n');
  }
  writeFileSync(
    bin,
    `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const behavior = ${JSON.stringify(behavior)};
const expectedBuiltin = ${JSON.stringify(builtin)};
fs.writeFileSync(${JSON.stringify(join(dir, 'native-env.json'))}, JSON.stringify({
  builtin: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
  personal: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
  bundled: process.env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE,
  data: process.env.ZCODE_DATA_BASE_DIR,
  home: process.env.HOME,
  pid: process.pid,
}));
if (behavior === 'stubborn') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
if (behavior === 'exit') {
  process.stderr.write('Cannot load builtin provider config; api_key="split-');
  process.stderr.write('secret-value"');
  process.exitCode = 1;
} else {
  readline.createInterface({input: process.stdin}).on('line', line => {
    const msg = JSON.parse(line);
    fs.appendFileSync(${JSON.stringify(join(dir, 'rpc.log'))}, JSON.stringify(msg)+'\\n');
    const reply = payload => process.stdout.write(JSON.stringify({id: msg.id, ...payload})+'\\n');
    if (msg.method !== 'session/list') return reply({error:{code:-32601,message:'unknown method'}});
    if (behavior === 'hang') return;
    if (behavior === 'error') return reply({error:{code:-32000,message:'provider registry unavailable api_key=secret-value'}});
    if (behavior === 'malformed') return reply({result:{unexpected:true}});
    if (process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE !== expectedBuiltin ||
        !process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE.startsWith(path.join(process.env.HOME, '.provider-runtime-'))) {
      return reply({error:{code:-32000,message:'provider paths were not isolated and resolved'}});
    }
    if (behavior === 'delay') return setTimeout(() => reply({result:{sessions:[]}}), 100);
    reply({result:{sessions:[]}});
  });
}
`,
  );
  return { dir, bin, builtin };
}

async function stop(acp) {
  if (acp.child.exitCode !== null || acp.child.signalCode !== null) return;
  const exited = once(acp.child, 'exit');
  acp.child.kill('SIGTERM');
  await exited;
}

describe('ZCode native startup readiness', () => {
  it('revokes temporary credentials before a slow native shutdown finishes', async () => {
    const { dir, bin } = fixture('bundle', 'stubborn');
    const native = new NativeAppServer(bin, {
      ...process.env,
      CAT_CAFE_ZCODE_HOME: join(dir, 'home'),
      ZCODE_MODEL: 'GLM-5.3',
      ANTHROPIC_API_KEY: 'dummy-shutdown-test',
    });
    const ready = await native.request('session/list', {});
    assert.equal(ready.error, undefined);
    const nativeEnv = JSON.parse(readFileSync(join(dir, 'native-env.json'), 'utf8'));
    try {
      assert.equal(existsSync(nativeEnv.personal), true);
      native.close();
      assert.equal(existsSync(nativeEnv.personal), false, 'cleanup must not wait for the child close event');
    } finally {
      process.kill(nativeEnv.pid, 'SIGKILL');
      await native.whenExited();
    }
  });
  for (const layout of ['bundle', 'adjacent']) {
    it(`resolves the ${layout} provider layout before initialize reports ready`, async () => {
      const { dir, bin, builtin } = fixture(layout);
      const acp = startAdapter(dir, { ZCODE_BIN: bin });
      try {
        const initialized = await acp.request('initialize', { protocolVersion: 1 });
        assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
        assert.equal(acp.rpcLog()[0]?.method, 'session/list', 'ready requires a successful native RPC');
        const nativeEnv = JSON.parse(readFileSync(join(dir, 'native-env.json'), 'utf8'));
        assert.equal(nativeEnv.builtin, builtin);
        assert.ok(nativeEnv.personal.startsWith(join(acp.isolatedHome, '.provider-runtime-')));
        assert.equal(readFileSync(builtin, 'utf8'), '{"fixture":"official-builtin"}\n');
      } finally {
        await stop(acp);
      }
    });
  }

  it('resolves provider config beside the real CLI behind a symlink', async () => {
    const { dir, bin, builtin } = fixture();
    const link = join(dir, 'zcode.cjs');
    symlinkSync(bin, link);
    const acp = startAdapter(dir, { ZCODE_BIN: link });
    try {
      const initialized = await acp.request('initialize', { protocolVersion: 1 });
      assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
      assert.equal(acp.rpcLog()[0]?.method, 'session/list');
      assert.equal(JSON.parse(readFileSync(join(dir, 'native-env.json'), 'utf8')).builtin, builtin);
    } finally {
      await stop(acp);
    }
  });

  it('overrides ambient provider and data paths with Hub-owned coordinates', async () => {
    const { dir, bin } = fixture();
    const acp = startAdapter(dir, {
      ZCODE_BIN: bin,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '/do-not-read/user-builtin.json',
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: '/do-not-read/user-personal.json',
      ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: '/do-not-read/user-bundled.json',
      ZCODE_DATA_BASE_DIR: '/do-not-read/user-data',
    });
    try {
      const initialized = await acp.request('initialize', { protocolVersion: 1 });
      assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
      assert.equal(acp.rpcLog()[0]?.method, 'session/list');
      const nativeEnv = JSON.parse(readFileSync(join(dir, 'native-env.json'), 'utf8'));
      assert.equal(nativeEnv.data, acp.isolatedHome);
      assert.equal(nativeEnv.bundled, undefined, 'ambient refresh paths must not target the installed bundle');
    } finally {
      await stop(acp);
    }
  });

  for (const behavior of ['exit', 'error', 'hang', 'malformed']) {
    it(`rejects initialize when native startup is ${behavior}`, async () => {
      const { dir, bin } = fixture('bundle', behavior);
      const acp = startAdapter(dir, { ZCODE_BIN: bin, ZCODE_REQUEST_TIMEOUT_MS: '300' });
      try {
        const initialized = await acp.request('initialize', { protocolVersion: 1 }, 3000);
        assert.ok(initialized.error, 'unusable backend must not advertise readiness');
        assert.doesNotMatch(JSON.stringify(initialized), /secret-value|split-secret/);
        if (behavior === 'exit') assert.match(initialized.error.message, /Cannot load builtin provider config/);
        if (behavior === 'hang') assert.match(initialized.error.message, /timeout.*session\/list/);
        if (behavior === 'malformed') assert.match(initialized.error.message, /invalid.*session\/list/i);
      } finally {
        await stop(acp);
      }
    });
  }

  it('waits for the native response rather than the process spawn', async () => {
    const { dir, bin } = fixture('bundle', 'delay');
    const acp = startAdapter(dir, { ZCODE_BIN: bin });
    try {
      const initialized = await acp.request('initialize', { protocolVersion: 1 });
      assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
      assert.equal(acp.rpcLog()[0]?.method, 'session/list');
    } finally {
      await stop(acp);
    }
  });

  it('reports a missing provider file without starting the native child', async () => {
    const { dir, bin } = fixture('missing');
    const acp = startAdapter(dir, { ZCODE_BIN: bin });
    try {
      const initialized = await acp.request('initialize', { protocolVersion: 1 }, 3000);
      assert.ok(initialized.error);
      assert.match(initialized.error.message, /provider config.*missing/i);
      assert.equal(acp.rpcLog().length, 0);
    } finally {
      await stop(acp);
    }
  });

  it('does not silently replace an explicitly missing CLI with an installed version', () => {
    const { dir, bin } = fixture();
    assert.equal(resolveZcodeBin({ CAT_CAFE_ZCODE_BIN: join(dir, 'missing.cjs') }, [bin]), undefined);
  });
});
