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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const authSourceMod = await import(join(here, '..', 'dist', 'config', 'qoder-auth-source.js'));
const { resolveQoderAuthSourceDir } = authSourceMod;

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
    modelResolver: () => 'Auto',
  });
  assert.ok(svc, 'green profile + effective model → service constructed');
  // P2-1：注册后 capability 不再落 unknown fallback（P1-B 全 false 画像）
  const cap = svc.contextCapability();
  assert.equal(cap.provider, 'qoder');
  assert.equal(cap.carrier, 'qodercn-cli');
  assert.equal(cap.reportsRuntimeWindow, false);
  assert.equal(cap.authoritativeUsage, false);
  assert.equal(cap.usageTelemetry, 'unavailable');
  assert.equal(cap.nativeWindowControl, false);
  assert.equal(cap.nativeCompressionControl, false);
  assert.equal(cap.observesCompression, false);
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
    modelResolver: () => 'Auto',
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
    modelResolver: () => 'Auto',
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
    config: { defaultModel: 'Auto', clientId: 'qoder' },
    dataRoot: join(root, 'data'),
    authSourceDir: auth,
    log: { warn: (m) => warns.push(m) },
    modelResolver: () => '  ',
  });
  assert.equal(svc, null);
  assert.ok(
    warns.some((w) => /effective model/.test(w)),
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
    modelResolver: () => 'Auto',
  });
  assert.equal(svc, null);
  assert.ok(
    warns.some((w) => /auth source unreadable|audit failed/.test(w)),
    JSON.stringify(warns),
  );
  rmSync(root, { recursive: true, force: true });
});

// ── P1-2：类型化 account→auth-source resolver（E2E：真实 catalog + 真实 fs）────
function writeQoderCatalog(root, accounts) {
  const cc = join(root, '.cat-cafe');
  mkdirSync(cc, { recursive: true });
  writeFileSync(
    join(cc, 'cat-catalog.json'),
    JSON.stringify({ version: 2, breeds: [], roster: {}, reviewPolicy: {}, accounts }, null, 2),
    'utf8',
  );
  writeFileSync(join(cc, 'credentials.json'), '{}', 'utf8');
  return cc;
}

test('slice2 P1-2: typed auth-source resolver — oauth qoder green; traversal/api_key/wrong-family/stale/missing all red', () => {
  const root = mkdtempSync(join(tmpdir(), 'qoder-s2e-'));
  const cc = writeQoderCatalog(root, {
    qoder: { authType: 'oauth', clientId: 'qoder' },
    'qoder-team': { authType: 'oauth', clientId: 'qoder' },
    'qoder-key': { authType: 'api_key', clientId: 'qoder', baseUrl: 'https://api.deepseek.com' },
    'openai-team': { authType: 'oauth', clientId: 'openai' },
    'qoder-nodir': { authType: 'oauth', clientId: 'qoder' },
    rogue: { authType: 'oauth' },
  });
  for (const ref of ['qoder', 'qoder-team']) {
    mkdirSync(join(cc, 'qoder-auth', ref, '.auth'), { recursive: true });
    writeFileSync(join(cc, 'qoder-auth', ref, '.auth', 'user'), `token-${ref}`);
  }
  // green：显式 ref 与默认 ref
  const g1 = resolveQoderAuthSourceDir({ projectRoot: root, accountRef: 'qoder-team' });
  assert.equal(g1.ok, true, JSON.stringify(g1));
  assert.equal(g1.authSourceDir, join(cc, 'qoder-auth', 'qoder-team'));
  const g2 = resolveQoderAuthSourceDir({ projectRoot: root, accountRef: undefined });
  assert.equal(g2.ok, true, 'default ref falls back to builtin qoder');
  // 穿越段：从未触达 fs 即拒
  const t = resolveQoderAuthSourceDir({ projectRoot: root, accountRef: '../../../personal' });
  assert.equal(t.ok, false);
  assert.match(t.reason, /unsafe qoder accountRef segment/);
  // api_key 账户：config-dir auth 要求 oauth
  const k = resolveQoderAuthSourceDir({ projectRoot: root, accountRef: 'qoder-key' });
  assert.equal(k.ok, false);
  assert.match(k.reason, /must be oauth/);
  // 异家族账户
  const w = resolveQoderAuthSourceDir({ projectRoot: root, accountRef: 'openai-team' });
  assert.equal(w.ok, false);
  assert.match(w.reason, /must declare clientId "qoder"/);
  // round-3 P1-1(2)：familyless OAuth 一律拒（不再是 client&& 才检查）
  const fam = resolveQoderAuthSourceDir({ projectRoot: root, accountRef: 'rogue' });
  assert.equal(fam.ok, false);
  assert.match(fam.reason, /must declare clientId "qoder"/);
  // stale ref（无账户记录）
  const st = resolveQoderAuthSourceDir({ projectRoot: root, accountRef: 'ghost' });
  assert.equal(st.ok, false);
  assert.match(st.reason, /no stored account record/);
  // oauth 账户存在但 auth source 目录未落位（operator onboarding 缺失）
  const nd = resolveQoderAuthSourceDir({ projectRoot: root, accountRef: 'qoder-nodir' });
  assert.equal(nd.ok, false);
  assert.match(nd.reason, /missing or unresolved/);
  rmSync(root, { recursive: true, force: true });
});

test('slice2 P1-2: auth source symlinked out of the durable root is rejected (realpath containment)', () => {
  const root = mkdtempSync(join(tmpdir(), 'qoder-s2f-'));
  const cc = writeQoderCatalog(root, { qoder: { authType: 'oauth', clientId: 'qoder' } });
  const external = mkdtempSync(join(tmpdir(), 'qoder-s2f-ext-'));
  mkdirSync(join(external, '.auth'), { recursive: true });
  writeFileSync(join(external, '.auth', 'user'), 'external');
  mkdirSync(join(cc, 'qoder-auth'), { recursive: true });
  symlinkSync(external, join(cc, 'qoder-auth', 'qoder'), 'dir');
  const r = resolveQoderAuthSourceDir({ projectRoot: root, accountRef: 'qoder' });
  assert.equal(r.ok, false, 'symlinked auth source must not pass containment');
  assert.match(r.reason, /escapes the durable auth root/);
  rmSync(root, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

// ── round-3（砚砚 2×P1 + 2×P2）════════════════════════════════════════════
// P1-1(1)：无存储账户记录时不得走合成 builtin 回退
test('slice2 r3: synthetic builtin fallback rejected — auth dir alone is not admission', () => {
  const root = mkdtempSync(join(tmpdir(), 'qoder-r3a-'));
  const cc = writeQoderCatalog(root, {}); // 无任何账户记录
  mkdirSync(join(cc, 'qoder-auth', 'qoder', '.auth'), { recursive: true });
  writeFileSync(join(cc, 'qoder-auth', 'qoder', '.auth', 'user'), 'tok');
  const r = resolveQoderAuthSourceDir({ projectRoot: root, accountRef: 'qoder' });
  assert.equal(r.ok, false, 'no stored record → reject even with auth dir present');
  assert.match(r.reason, /no stored account record/);
  rmSync(root, { recursive: true, force: true });
});

// P1-1(3)：authRoot 自身是 symlink → 拒（child containment 锚不住已出逃的根）
test('slice2 r3: qoder-auth root itself symlinked out is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'qoder-r3b-'));
  const cc = writeQoderCatalog(root, { qoder: { authType: 'oauth', clientId: 'qoder' } });
  const external = mkdtempSync(join(tmpdir(), 'qoder-r3b-ext-'));
  mkdirSync(join(external, 'qoder', '.auth'), { recursive: true });
  writeFileSync(join(external, 'qoder', '.auth', 'user'), 'external');
  mkdirSync(join(cc), { recursive: true });
  symlinkSync(external, join(cc, 'qoder-auth'), 'dir');
  const r = resolveQoderAuthSourceDir({ projectRoot: root, accountRef: 'qoder' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /auth root is a symlink/);
  rmSync(root, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

// P1-2：分离 runtime/workspace 拓扑——账户与 auth 必须落持久 workspace 而非可弃置 checkout
test('slice2 r3: split runtime/workspace topology — durable root follows the account store', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'qoder-r3c-ws-'));
  const runtime = mkdtempSync(join(tmpdir(), 'qoder-r3c-rt-'));
  const saved = {};
  for (const k of ['CAT_CAFE_RUNTIME_ROOT', 'CAT_CAFE_WORKSPACE_ROOT']) {
    saved[k] = process.env[k];
    process.env[k] = k === 'CAT_CAFE_RUNTIME_ROOT' ? runtime : workspace;
  }
  try {
    // 账户 + auth 落持久 workspace
    const wsCC = writeQoderCatalog(workspace, { 'qoder-team': { authType: 'oauth', clientId: 'qoder' } });
    mkdirSync(join(wsCC, 'qoder-auth', 'qoder-team', '.auth'), { recursive: true });
    writeFileSync(join(wsCC, 'qoder-auth', 'qoder-team', '.auth', 'user'), 'tok');
    // runtime checkout 下有一个"旧位置"目录（存在也不得被采用）
    mkdirSync(join(runtime, '.cat-cafe', 'qoder-auth', 'qoder-team', '.auth'), { recursive: true });
    const projectRoot = join(runtime, 'packages', 'api'); // runtime 内项目路径
    mkdirSync(projectRoot, { recursive: true });
    const r = resolveQoderAuthSourceDir({ projectRoot, accountRef: 'qoder-team' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(
      r.authSourceDir.startsWith(join(realpathSync(workspace), '.cat-cafe', 'qoder-auth')),
      `auth source must live in the persistent workspace, got ${r.authSourceDir}`,
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

// P2-1：投影级——capability 的 provider/carrier 都必须是枚举认可值（不再 unrecognized）
test('slice2 r3: qoder capability projects to recognized provider AND carrier', async () => {
  const contract = await import(
    join(here, '..', 'dist', 'domains', 'cats', 'services', 'session', 'context-projection-telemetry-contract.js')
  );
  const providers = contract.CONTEXT_PROJECTION_ENUMS.providers;
  const carriers = contract.CONTEXT_PROJECTION_ENUMS.carriers;
  assert.ok(providers.includes('qoder'), 'providers enum includes qoder');
  assert.ok(carriers.includes('qodercn-cli'), 'carriers enum includes qodercn-cli');
  const svc = createQoderAgentService({
    catId: 'cat_qoder_s2',
    config: { defaultModel: 'Auto', clientId: 'qoder' },
    dataRoot: join(mkdtempSync(join(tmpdir(), 'qoder-r3d-')), 'data'),
    authSourceDir: (() => {
      const a = mkdtempSync(join(tmpdir(), 'qoder-r3d-auth-'));
      mkdirSync(join(a, '.auth'), { recursive: true });
      writeFileSync(join(a, '.auth', 'user'), 't');
      return a;
    })(),
    log: { warn: () => {} },
    modelResolver: () => 'Auto',
  });
  assert.ok(svc);
  const cap = svc.contextCapability();
  assert.equal(providers.includes(cap.provider), true, 'capability provider is bounded-recognized');
  assert.equal(carriers.includes(cap.carrier), true, 'capability carrier is bounded-recognized');
});
