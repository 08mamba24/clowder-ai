/**
 * F317 Slice 2 unit tests —— 注册链 + 构造期 resolver（点点 round-8 P2 硬验收）
 * 纯单测：真实临时 fs（auth source + runtime profile），不真跑 qodercn。
 *
 * 契约：
 * - qoder 进 ClientId / builtin 账号身份表 / route schema / workspace-strict 集
 * - qoder 无 env 凭证协议（protocolForClient → null；凭证走 config-dir）
 * - 工厂在 **Service 构造期** 经 ensureQoderRuntimeProfile 解析 profileDir 并做
 *   containment 断言；custody 红 / model 缺失 → null（不注册，无半注册态）
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shared = await import('@cat-cafe/shared');
const { builtinAccountFamilyForRef, builtinAccountIdForClient, protocolForClient } = shared;
const accountResolver = await import(join(here, '..', 'dist', 'config', 'account-resolver.js'));
const factory = await import(
  join(here, '..', 'dist', 'domains', 'cats', 'services', 'agents', 'providers', 'qoder-service-factory.js')
);
const { createQoderAgentService } = factory;

function makeAuthSource(root, token) {
  const dir = join(root, `auth-${token}`);
  mkdirSync(join(dir, '.auth'), { recursive: true });
  writeFileSync(join(dir, '.auth', 'user'), token);
  return dir;
}

// ── 注册链身份表 ───────────────────────────────────────────────────────────
test('slice2: qoder in builtin identity table, workspace-strict, and WITHOUT env credential protocol', () => {
  assert.equal(builtinAccountFamilyForRef('qoder'), 'qoder', 'builtin account ref resolves');
  assert.equal(builtinAccountIdForClient('qoder'), 'qoder');
  assert.equal(accountResolver.providerRequiresThreadWorkspace('qoder'), true, 'qoder is workspace-strict');
  assert.equal(accountResolver.providerRequiresThreadWorkspace('opencode'), true, 'opencode unchanged');
  assert.equal(accountResolver.providerRequiresThreadWorkspace('anthropic'), false, 'non-strict providers unchanged');
  assert.equal(accountResolver.resolveBuiltinClientForProvider('qoder'), 'qoder');
  assert.equal(protocolForClient('qoder'), null, 'qoder credentials ride config-dir — no env protocol');
});

// ── P2 工厂：构造期 ensure + containment ───────────────────────────────────
test('slice2 P2: factory resolves the runtime profile AT CONSTRUCTION (green path)', () => {
  const root = mkdtempSync(join(tmpdir(), 'qoder-s2a-'));
  const auth = makeAuthSource(root, 'token-A');
  const svc = createQoderAgentService({
    catId: 'cat_qoder_s2',
    config: { defaultModel: 'Auto', clientId: 'qoder' },
    dataRoot: join(root, 'data'),
    authSourceDir: auth,
    log: { warn: () => {} },
  });
  assert.ok(svc, 'green profile + explicit model → service constructed');
  assert.equal(typeof svc.invoke, 'function', 'is an AgentService');
  const profileDir = join(root, 'data', 'qoder-profiles', 'cat_qoder_s2');
  assert.ok(existsSync(join(profileDir, '.auth', 'user')), 'profile seeded from auth source at construction');
  assert.ok(existsSync(join(profileDir, '.account-fingerprint')), 'fingerprint marker written');
  rmSync(root, { recursive: true, force: true });
});

test('slice2 P2: custody-red profile → factory returns null (cat NOT registered; string-cache would be fail-open)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qoder-s2b-'));
  const auth = makeAuthSource(root, 'token-A');
  const dataRoot = join(root, 'data');
  const first = createQoderAgentService({
    catId: 'cat_qoder_s2',
    config: { defaultModel: 'Auto', clientId: 'qoder' },
    dataRoot,
    authSourceDir: auth,
    log: { warn: () => {} },
  });
  assert.ok(first, 'first construction seeds a green profile');
  // 构造期攻击面（点点 round-8 P1 场景）：profile 根被换成指向外部绿目录的 symlink。
  // 只缓存字符串的 resolver 会放行；P2 要求构造期 ensure 当场拒掉。
  const external = mkdtempSync(join(tmpdir(), 'qoder-s2b-ext-'));
  mkdirSync(join(external, '.auth'), { recursive: true });
  writeFileSync(join(external, '.auth', 'user'), 'external-token');
  writeFileSync(join(external, '.account-fingerprint'), 'f'.repeat(16));
  const profileDir = join(dataRoot, 'qoder-profiles', 'cat_qoder_s2');
  rmSync(profileDir, { recursive: true, force: true });
  symlinkSync(external, profileDir, 'dir');
  const warns = [];
  const second = createQoderAgentService({
    catId: 'cat_qoder_s2',
    config: { defaultModel: 'Auto', clientId: 'qoder' },
    dataRoot,
    authSourceDir: auth,
    log: { warn: (m) => warns.push(m) },
  });
  assert.equal(second, null, 'custody-red profile must NOT construct a service');
  assert.ok(
    warns.some((w) => /symlink|audit failed/.test(w)),
    JSON.stringify(warns),
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

test('slice2: missing explicit defaultModel → null (P1-D: model is a hard typed input)', () => {
  const root = mkdtempSync(join(tmpdir(), 'qoder-s2c-'));
  const auth = makeAuthSource(root, 'token-A');
  const warns = [];
  const svc = createQoderAgentService({
    catId: 'cat_qoder_s2',
    config: { defaultModel: '   ', clientId: 'qoder' },
    dataRoot: join(root, 'data'),
    authSourceDir: auth,
    log: { warn: (m) => warns.push(m) },
  });
  assert.equal(svc, null);
  assert.ok(
    warns.some((w) => /defaultModel/.test(w)),
    JSON.stringify(warns),
  );
  rmSync(root, { recursive: true, force: true });
});

test('slice2: unreadable auth source → null (fail closed)', () => {
  const root = mkdtempSync(join(tmpdir(), 'qoder-s2d-'));
  const warns = [];
  const svc = createQoderAgentService({
    catId: 'cat_qoder_s2',
    config: { defaultModel: 'Auto', clientId: 'qoder' },
    dataRoot: join(root, 'data'),
    authSourceDir: join(root, 'missing-auth'),
    log: { warn: (m) => warns.push(m) },
  });
  assert.equal(svc, null);
  assert.ok(
    warns.some((w) => /auth source unreadable|audit failed/.test(w)),
    JSON.stringify(warns),
  );
  rmSync(root, { recursive: true, force: true });
});
