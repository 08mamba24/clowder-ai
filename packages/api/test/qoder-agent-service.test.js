/**
 * F317 Phase 1 Slice 1 unit tests — 窄 QoderAgentService + runtime profile
 * 纯单测：fake spawn / 注入 fs，不真跑 qodercn。协议形状断言用 L1 夹具。
 * round-3 契约（砚砚六组 P1）：
 *   P1① stderr 不内联进用户可见错误（F212 AC-A9：humanized only），由共享 spawnCli 同步脱敏；
 *   P1② pre-abort 先于 recorder；prepared request 深度冻结，落档字节不可变；
 *   P1③ 复用 shared spawnCli（EPIPE 守卫/有界终止/exit 等待）+ CliRawArchive；
 *   P1④ init model 精确匹配（大小写敏感）+ 显式 -m provenance 落 metadata；
 *   P1⑤ atomic swap 的 restore/rm 失败如实返回（committed swap 收尾失败进 warnings）；
 *   P1⑥ resume 二次审计：session 必须真实存在于本 profile 的 projects/ 下。
 * Service 模块依赖共享 spawnCli 模块图，本文件固定走 dist 构建（parser 测试保留 src 模式）。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, '..', 'dist', 'domains', 'cats', 'services', 'agents', 'providers');
const SRC = join(here, '..', 'src', 'domains', 'cats', 'services', 'agents', 'providers');

const svcModule = await import(join(DIST, 'QoderAgentService.js'));
const profileModule = await import(join(SRC, 'qoder-runtime-profile.ts'));
const {
  buildQoderArgs,
  qoderInitGate,
  QODER_BASIC_TOOLS,
  QODER_MEMORY_MCP_SERVER,
  QODER_READONLY_MEMORY_TOOLS,
  QoderAgentService,
} = svcModule;
const { ensureQoderRuntimeProfile, auditQoderProfile, isSafeCatIdSegment } = profileModule;
const FIXTURE = join(here, 'fixtures', 'qoder');
const fixtureLines = (name) =>
  readFileSync(join(FIXTURE, 'current', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean);

const CAT = 'cat_test_qoder';

// ── argv：prompt 走 stdin，安全 flag 全集 ───────────────────────────────────
test('buildQoderArgs: stdin prompt channel, no prompt text in argv, full safety set', () => {
  const args = buildQoderArgs({ profileDir: '/p', model: 'qwen-max', toolAccess: 'disabled' });
  assert.deepEqual(args, [
    '-p',
    '-',
    '-m',
    'qwen-max',
    '-o',
    'stream-json',
    '--config-dir',
    '/p',
    '--strict-mcp-config',
    '--allowed-mcp-server-names',
    'nothing',
    '--tools',
    '',
    '--setting-sources',
    'user',
  ]);
  const resume = buildQoderArgs({
    profileDir: '/p',
    model: 'qwen-max',
    sessionId: 'sid-1',
    toolAccess: 'disabled',
  });
  assert.ok(resume.includes('-r') && resume.includes('sid-1'));
  assert.ok(!args.join(' ').includes('bypass_permissions'));
});

test('argv carries explicit -m model (round-2 P1-1: model is a typed input, actually sent)', () => {
  const args = buildQoderArgs({ profileDir: '/p', model: 'qwen-max', toolAccess: 'disabled' });
  const i = args.indexOf('-m');
  assert.ok(i > 0 && args[i + 1] === 'qwen-max');
});

test('L2: controlled argv exposes the complete basic set and preauthorizes bounded write/shell + memory', () => {
  assert.deepEqual(QODER_BASIC_TOOLS, ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
  assert.equal(QODER_MEMORY_MCP_SERVER, 'cat-cafe-memory');
  assert.equal(QODER_READONLY_MEMORY_TOOLS.length, 12, 'split memory.js readonly surface is pinned exactly');

  const args = buildQoderArgs({
    profileDir: '/p',
    model: 'Auto',
    toolAccess: 'controlled',
    mcpConfigPath: '/tmp/qoder-memory.json',
    workingDirectory: '/tmp/workspace-l2',
  });
  const toolsIndex = args.indexOf('--tools');
  const firstAllowed = args.indexOf('--allowed-tools');
  assert.deepEqual(args.slice(toolsIndex + 1, firstAllowed), QODER_BASIC_TOOLS);
  const allowed = args.flatMap((arg, i) => (arg === '--allowed-tools' ? [args[i + 1]] : []));
  assert.deepEqual(
    new Set(allowed),
    new Set([
      'Read(//tmp/workspace-l2/**)',
      'Edit(//tmp/workspace-l2/**)',
      'Write(//tmp/workspace-l2/**)',
      'Glob(//tmp/workspace-l2/**)',
      'Grep(//tmp/workspace-l2/**)',
      'Bash',
      ...QODER_READONLY_MEMORY_TOOLS.map((name) => `mcp__${QODER_MEMORY_MCP_SERVER}__${name}`),
    ]),
  );
  assert.equal(args[args.indexOf('--mcp-config') + 1], '/tmp/qoder-memory.json');
  assert.equal(args[args.indexOf('--allowed-mcp-server-names') + 1], QODER_MEMORY_MCP_SERVER);
  assert.ok(!args.includes('nothing'));
  assert.ok(!args.includes('bypass_permissions'));
});

test('L2: read-only execution policy collapses back to an empty built-in/MCP surface', () => {
  const args = buildQoderArgs({ profileDir: '/p', model: 'Auto', toolAccess: 'disabled' });
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--allowed-mcp-server-names') + 1], 'nothing');
  assert.ok(!args.includes('--allowed-tools'));
  assert.ok(!args.includes('--mcp-config'));
});

test('GitHub read MCP: only a granted invocation adds the exact readonly tool and server', () => {
  const args = buildQoderArgs({
    profileDir: '/p',
    model: 'Auto',
    toolAccess: 'controlled',
    mcpConfigPath: '/tmp/qoder-memory.json',
    workingDirectory: '/tmp/workspace-l2',
    githubRead: true,
  });
  const allowed = args.flatMap((arg, i) => (arg === '--allowed-tools' ? [args[i + 1]] : []));
  assert.ok(allowed.includes('mcp__clowder-repository-read__github_read'));
  const start = args.indexOf('--allowed-mcp-server-names') + 1;
  assert.deepEqual(args.slice(start, args.indexOf('--setting-sources')), [
    QODER_MEMORY_MCP_SERVER,
    'clowder-repository-read',
  ]);
  assert.ok(!allowed.some((tool) => tool.includes('clowder-repository-read') && tool.endsWith('*')));
  const disabled = buildQoderArgs({ profileDir: '/p', model: 'Auto', toolAccess: 'disabled', githubRead: true });
  assert.ok(!disabled.some((arg) => arg.includes('clowder-repository-read')));
});

// ── init 门：tools/mcp/model/版本 全锁 ─────────────────────────────────────
test('qoderInitGate: version, permissionMode, tools, mcp, model all enforced (missing fields red)', () => {
  const good = { protocol_version: '1.4.0', permissionMode: 'default', model: 'qwen-max', tools: [], mcp_servers: [] };
  assert.equal(qoderInitGate(good, 'qwen-max').ok, true);
  assert.equal(qoderInitGate({ ...good, protocol_version: '2.0' }, 'qwen-max').ok, false);
  assert.equal(qoderInitGate({ ...good, permissionMode: 'bypass_permissions' }, 'qwen-max').ok, false);
  assert.equal(
    qoderInitGate({ ...good, tools: ['Bash', 'Write'] }, 'qwen-max').ok,
    false,
    'full tool surface must not pass',
  );
  assert.equal(qoderInitGate({ ...good, mcp_servers: [{ name: 'x', status: 'connected' }] }, 'qwen-max').ok, false);
  // round-2 P1-1：字段缺失（undefined）不得当空数组放行
  const noTools = { ...good };
  delete noTools.tools;
  assert.equal(qoderInitGate(noTools, 'qwen-max').ok, false, 'missing tools field red');
  const noMcp = { ...good };
  delete noMcp.mcp_servers;
  assert.equal(qoderInitGate(noMcp, 'qwen-max').ok, false, 'missing mcp_servers field red');
  assert.equal(qoderInitGate({ ...good, model: 'Auto' }, 'qwen-max').ok, false, 'silent Auto fallback red');
});

test('L2: init gate accepts only the exact basic + readonly-memory surface and a connected memory server', () => {
  const expectedTools = [
    ...QODER_BASIC_TOOLS,
    ...QODER_READONLY_MEMORY_TOOLS.map((name) => `mcp__${QODER_MEMORY_MCP_SERVER}__${name}`),
  ];
  const expected = { tools: expectedTools, mcpServerNames: [QODER_MEMORY_MCP_SERVER] };
  const good = {
    protocol_version: '1.4.0',
    permissionMode: 'default',
    model: 'Auto',
    tools: [...expectedTools].reverse(),
    mcp_servers: [{ name: QODER_MEMORY_MCP_SERVER, status: 'connected' }],
  };
  assert.equal(qoderInitGate(good, 'Auto', expected).ok, true, 'order-independent exact set passes');
  assert.equal(qoderInitGate({ ...good, tools: expectedTools.slice(1) }, 'Auto', expected).ok, false, 'missing red');
  assert.equal(qoderInitGate({ ...good, tools: [...expectedTools, 'Agent'] }, 'Auto', expected).ok, false, 'extra red');
  assert.equal(
    qoderInitGate(
      { ...good, mcp_servers: [{ name: QODER_MEMORY_MCP_SERVER, status: 'disconnected' }] },
      'Auto',
      expected,
    ).ok,
    false,
    'disconnected memory server red',
  );
});

// round-3 P1④：精确匹配——大小写漂移不再放行（auth-error 夹具实测：未认证 CLI 回报
// 小写 auto；大小写宽容会把这类漂移静默吞掉）
test('round3 P1-4a: init gate model match is exact — case drift is fail-closed', () => {
  const lower = { protocol_version: '1.4.0', permissionMode: 'default', model: 'auto', tools: [], mcp_servers: [] };
  assert.equal(qoderInitGate(lower, 'Auto').ok, false, 'auto != Auto must be red (case drift masks drift)');
  assert.equal(qoderInitGate(lower, 'auto').ok, true, 'exact same identifier passes');
  assert.equal(qoderInitGate({ ...lower, model: 'Auto' }, 'auto').ok, false, 'Auto != auto must be red too');
});

// round-3 P1④：显式 -m provenance 守卫（argv 断言，缺/错即拒发）
test('round3 P1-4c: assertExplicitModelFlag guards argv provenance', () => {
  const assertExplicitModelFlag = svcModule.assertExplicitModelFlag;
  assert.equal(typeof assertExplicitModelFlag, 'function', 'exported guard');
  assertExplicitModelFlag(['-p', '-', '-m', 'qwen-max', '-o', 'stream-json'], 'qwen-max');
  assert.throws(() => assertExplicitModelFlag(['-p', '-', '-o', 'stream-json'], 'qwen-max'), /-m/);
  assert.throws(() => assertExplicitModelFlag(['-p', '-', '-m', 'Auto'], 'qwen-max'), /-m/);
});

// round-3 P1③：env 覆盖纪律——denylist/qoder* 从继承 env 删除（null），inputs 里的
// qoder* 一律不转发，QODERCN_CONFIG_DIR 只由 resolver 单点注入
test('round3 P1-3d: buildQoderEnvOverrides — denied/qoder keys deleted, config dir single injection point', () => {
  const buildQoderEnvOverrides = svcModule.buildQoderEnvOverrides;
  assert.equal(typeof buildQoderEnvOverrides, 'function', 'exported overrides builder');
  const ov = buildQoderEnvOverrides({
    profileDir: '/p',
    inheritEnv: {
      PATH: '/bin',
      NODE_OPTIONS: '--require /evil.js',
      QODERCN_CONFIG_DIR: '/evil',
      qodercn_state: 'x',
    },
    callbackEnv: { CALLBACK_TOKEN: 'cbt', QODERCN_CONFIG_DIR: '/evil2' },
    accountEnv: { ACC_V: '1', NODE_PRELOAD: '/evil.so' },
  });
  // 覆盖表只含：删除项（null）+ 转发 inputs + resolver 注入的 config dir；
  // 干净继承键（PATH）不经覆盖表，由共享 buildChildEnv 从 process.env 继承
  assert.ok(!('PATH' in ov), 'clean inherited keys flow via buildChildEnv, not overrides');
  assert.equal(ov.CALLBACK_TOKEN, 'cbt');
  assert.equal(ov.ACC_V, '1');
  assert.equal(ov.NODE_OPTIONS, null, 'inherited denied key deleted');
  assert.ok(!('NODE_PRELOAD' in ov), 'account denied key never forwarded (and not inherited here)');
  assert.equal(ov.qodercn_state, null, 'inherited qoder* deleted');
  assert.equal(ov.QODERCN_CONFIG_DIR, '/p', 'resolver value wins — single injection point');
});

// F317 keychain isolation: the two storage switches keep CLI credentials out
// of the native keychain, while DISABLE_UMID_REPORT stops the separately
// signed umid-bridge helper from trying to create a login-keychain item.
// All three are final writes and cannot be disabled by inherited or supplied
// environment values.
test('qoder keychain isolation: buildQoderEnvOverrides forces storage and UMID switches', () => {
  const buildQoderEnvOverrides = svcModule.buildQoderEnvOverrides;
  const attacked = buildQoderEnvOverrides({
    profileDir: '/p',
    inheritEnv: {
      QODERCN_FORCE_FILE_STORAGE: 'false',
      QODERCN_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
      QODERCN_DISABLE_UMID_REPORT: 'false',
    },
    callbackEnv: {
      QODERCN_FORCE_FILE_STORAGE: 'false',
      QODERCN_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
      QODERCN_DISABLE_UMID_REPORT: 'false',
    },
    accountEnv: {
      QODERCN_FORCE_FILE_STORAGE: 'false',
      QODERCN_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
      QODERCN_DISABLE_UMID_REPORT: 'false',
    },
  });
  assert.equal(attacked.QODERCN_FORCE_FILE_STORAGE, 'true', 'final write must win over all three inputs');
  assert.equal(attacked.QODERCN_FORCE_ENCRYPTED_FILE_STORAGE, 'true', 'level-1 hybrid-storage switch forced too');
  assert.equal(attacked.QODERCN_DISABLE_UMID_REPORT, 'true', 'UMID helper must stay disabled');
  const minimal = buildQoderEnvOverrides({ profileDir: '/p' });
  assert.equal(minimal.QODERCN_FORCE_FILE_STORAGE, 'true', 'forced even with no inputs at all');
  assert.equal(minimal.QODERCN_FORCE_ENCRYPTED_FILE_STORAGE, 'true', 'level-1 switch forced with no inputs too');
  assert.equal(minimal.QODERCN_DISABLE_UMID_REPORT, 'true', 'UMID helper disabled with no inputs too');
});

// ── profile：路径逃逸 / 深度盲区 / hooks 语义 / fail-closed ───────────────
test('isSafeCatIdSegment rejects traversal segments', () => {
  assert.equal(isSafeCatIdSegment('cat_ok-1'), true);
  assert.equal(isSafeCatIdSegment('../../victim'), false);
  assert.equal(isSafeCatIdSegment('a/b'), false);
  assert.equal(isSafeCatIdSegment('..'), false);
  assert.throws(() =>
    ensureQoderRuntimeProfile({ dataRoot: '/tmp/x', catId: '../../victim', authSourceDir: '/tmp/x' }),
  );
});

function memFs(files, unreadableDirs = new Set()) {
  const norm = (p) => p.replace(/\/+$/, '');
  const fs = {
    files,
    existsSync: (p) => files.has(norm(p)) || [...files.keys()].some((k) => k.startsWith(norm(p) + '/')),
    readdirSync: (p) => {
      if (unreadableDirs.has(norm(p))) throw new Error('EACCES');
      const prefix = norm(p) + '/';
      const direct = new Set();
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (rest) direct.add(rest.split('/')[0]);
      }
      return [...direct].map((name) => ({ name, isDirectory: () => !files.has(prefix + name) }));
    },
    lstatSync: (p) => {
      if (files.has(norm(p))) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mode: 0o644 };
      }
      if ([...files.keys()].some((k) => k.startsWith(norm(p) + '/'))) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, mode: 0o755 };
      }
      throw Object.assign(new Error('ENOENT (memfs)'), { code: 'ENOENT' });
    },
    readFileSync: (p) => {
      const v = files.get(norm(p));
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    writeFileSync: (p, d) => files.set(norm(p), d),
    copySync: (s, d) => {
      for (const [k, v] of [...files]) if (k === s || k.startsWith(s + '/')) files.set(d + k.slice(s.length), v);
    },
    mkdirSync: () => {},
    renameSync: (from, to) => {
      for (const [k, v] of [...files])
        if (k === from || k.startsWith(from + '/')) files.set(to + k.slice(from.length), v);
      for (const [k] of [...files]) if (k === from || k.startsWith(from + '/')) files.delete(k);
    },
    rmSync: (p) => {
      for (const [k] of [...files]) if (k === p || k.startsWith(p + '/')) files.delete(k);
    },
  };
  return fs;
}

function profileFs(files) {
  return memFs(files ?? new Map());
}

test('audit: deep plugin scripts detected (no depth cap), unreadable dir is violation', () => {
  const deep = memFs(
    new Map([
      ['/p/.auth/user', 't'],
      ['/p/.account-fingerprint', 'f'.repeat(16)],
    ]),
  );
  deep.files.set('/p/plugins/1/2/3/4/5/6/7/evil.js', 'x');
  const a1 = auditQoderProfile('/p', deep);
  assert.equal(a1.ok, false);
  assert.ok(
    a1.violations.some((v) => v.includes('evil.js')),
    'depth-8 script detected',
  );

  const unreadable = memFs(
    new Map([
      ['/p/.auth/user', 't'],
      ['/p/.account-fingerprint', 'f'.repeat(16)],
    ]),
    new Set(['/p/plugins']),
  );
  unreadable.files.set('/p/plugins/data', '');
  const a2 = auditQoderProfile('/p', unreadable);
  assert.equal(a2.ok, false);
  assert.ok(a2.violations.some((v) => v.includes('unreadable')));
});

test('audit: hooks:{} counts as empty (no violation), non-empty hooks red', () => {
  const fs1 = memFs(
    new Map([
      ['/p/.auth/user', 't'],
      ['/p/.account-fingerprint', 'f'.repeat(16)],
      ['/p/settings.json', '{"hooks":{}}'],
    ]),
  );
  assert.equal(auditQoderProfile('/p', fs1).ok, true);
  const fs2 = memFs(
    new Map([
      ['/p/.auth/user', 't'],
      ['/p/.account-fingerprint', 'f'.repeat(16)],
      ['/p/settings.json', '{"hooks":{"SessionStart":[]}}'],
    ]),
  );
  assert.equal(auditQoderProfile('/p', fs2).ok, false);
});

// ── ensure 生命周期（真临时目录）：seed / 复用 / 换绑 / 失败保留 ───────────
function makeAuth(root, token) {
  const dir = join(root, 'auth-' + token);
  mkdirSync(join(dir, '.auth'), { recursive: true });
  writeFileSync(join(dir, '.auth', 'user'), token);
  return dir;
}

async function realFsWrappers() {
  const fsmod = await import('node:fs');
  return {
    base: {
      existsSync: (p) => fsmod.existsSync(p),
      readdirSync: (p, o) => fsmod.readdirSync(p, o),
      lstatSync: (p) => fsmod.lstatSync(p),
      readFileSync: (p) => fsmod.readFileSync(p, 'utf8'),
      writeFileSync: (p, d) => fsmod.writeFileSync(p, d),
      copySync: (s, d) => cpSync(s, d, { recursive: true }),
      mkdirSync: (p, o) => fsmod.mkdirSync(p, o),
      renameSync: (f, t) => fsmod.renameSync(f, t),
      rmSync: (p, o) => fsmod.rmSync(p, o),
      realpathSync: (p) => fsmod.realpathSync(p),
    },
  };
}

test('lifecycle: seed, reuse, account A→B rebind (no stale credentials), failed swap keeps old profile', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-life-'));
  const authA = makeAuth(root, 'token-A');
  const authB = makeAuth(root, 'token-B');

  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  assert.equal(first.audit.ok, true);
  assert.equal(readFileSync(join(first.profileDir, '.auth', 'user'), 'utf8'), 'token-A');

  const reuse = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  assert.equal(reuse.audit.ok, true);
  assert.equal(reuse.audit.swapped, undefined, 'same account reuses profile');

  const rebind = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authB, fs: base });
  assert.equal(rebind.audit.ok, true);
  assert.equal(rebind.audit.swapped, 'rebind-account');
  assert.equal(
    readFileSync(join(rebind.profileDir, '.auth', 'user'), 'utf8'),
    'token-B',
    'A→B must not keep A credentials',
  );

  // 失败的 swap（auth source 不可读）保留旧 profile
  const before = readFileSync(join(rebind.profileDir, '.auth', 'user'), 'utf8');
  const failed = ensureQoderRuntimeProfile({
    dataRoot: root,
    catId: 'c1',
    authSourceDir: join(root, 'missing'),
    fs: base,
  });
  assert.equal(failed.audit.ok, false);
  assert.equal(
    readFileSync(join(rebind.profileDir, '.auth', 'user'), 'utf8'),
    before,
    'old profile preserved on failed swap',
  );
  rmSync(root, { recursive: true, force: true });
});

// ══ round-3 P1⑤：atomic swap 收尾失败如实返回 ═════════════════════════════

test('round3 P1-5a: swap failure with FAILED rollback reported truthfully (no false "rolled back")', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-p15a-'));
  const authA = makeAuth(root, 'token-A');
  const authB = makeAuth(root, 'token-B');
  ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  let renameCalls = 0;
  const fs = {
    ...base,
    renameSync: (f, t) => {
      renameCalls++;
      // 第 2 次 = staging→live；之后（含回滚 backup→live）全部失败
      if (renameCalls >= 2) throw new Error('EIO injected');
      base.renameSync(f, t);
    },
  };
  const res = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authB, fs });
  assert.equal(res.audit.ok, false);
  assert.ok(
    res.audit.violations.some((v) => /rollback[^\n]*failed/i.test(v)),
    `rollback failure must be reported, got: ${JSON.stringify(res.audit.violations)}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test('round3 P1-5b: committed swap with failed backup cleanup stays ok:true with honest warning', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-p15b-'));
  const authA = makeAuth(root, 'token-A');
  const authB = makeAuth(root, 'token-B');
  ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  const fs = {
    ...base,
    rmSync: (p, o) => {
      if (p.includes('.old-')) throw new Error('EBUSY injected');
      base.rmSync(p, o);
    },
  };
  const res = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authB, fs });
  assert.equal(res.audit.ok, true, 'swap committed — new profile is live and green');
  assert.equal(res.audit.swapped, 'rebind-account');
  assert.ok(
    Array.isArray(res.audit.warnings) &&
      res.audit.warnings.some((w) => w.includes('.old-') && /cleanup failed/i.test(w)),
    `stale-credential leftover must be surfaced, got: ${JSON.stringify(res.audit.warnings)}`,
  );
  assert.equal(readFileSync(join(res.profileDir, '.auth', 'user'), 'utf8'), 'token-B');
  rmSync(root, { recursive: true, force: true });
});

test('round3 P1-5c: staging audit failure with failed staging cleanup names the leftover path', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-p15c-'));
  const authA = makeAuth(root, 'token-A');
  ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  // 让 profile 变污染（round-4 P1-1 后审计面 = plugins/ 子树，污染必须落在那里才触发
  // atomicSwap）。staging 是 auth-only seed、天然无 plugins/——用 fingerprint 不可读让
  // staging 审计变红（审计语义内），rm 注入照旧；两件事都必须如实出现在 violations
  mkdirSync(join(root, 'qoder-profiles', 'c1', 'plugins'), { recursive: true });
  writeFileSync(join(root, 'qoder-profiles', 'c1', 'plugins', 'evil.sh'), 'x');
  const fs = {
    ...base,
    readFileSync: (p) => {
      if (p.includes('.staging-')) throw new Error('EACCES injected');
      return base.readFileSync(p);
    },
    rmSync: (p, o) => {
      if (p.includes('.staging-')) throw new Error('EACCES injected');
      base.rmSync(p, o);
    },
  };
  const res = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs });
  assert.equal(res.audit.ok, false);
  assert.ok(
    res.audit.violations.some((v) => /staging audit failed/i.test(v)),
    'staging audit red reported',
  );
  assert.ok(
    res.audit.violations.some((v) => /staging cleanup[^\n]*FAILED/i.test(v) && v.includes('.staging-')),
    `failed staging cleanup must name the credential-bearing leftover, got: ${JSON.stringify(res.audit.violations)}`,
  );
  rmSync(root, { recursive: true, force: true });
});

// ── Service invoke（fake spawn，L1 夹具）──────────────────────────────────
function fakeStdin(opts = {}) {
  const stdin = new EventEmitter();
  stdin.write = (s) => {
    if (opts.recorder) opts.recorder.push(s);
    if (opts.epipe) {
      const err = new Error('write EPIPE');
      err.code = 'EPIPE';
      stdin.emit('error', err);
    }
  };
  stdin.end = () => {};
  return stdin;
}

function fakeChild(lines, opts = {}) {
  const child = new EventEmitter();
  child.stdout = Readable.from(lines.map((l) => l + '\n'));
  child.stderr = Readable.from((opts.stderr ?? []).map((l) => l + '\n'));
  child.stdin = fakeStdin(opts.stdin ?? {});
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    if (!opts.ignoreKillClose) child.emit('close', opts.exitCode ?? 0, null);
  };
  if (!opts.noAutoClose) queueMicrotask(() => child.emit('close', opts.exitCode ?? 0, null));
  return child;
}

function greenProfileFs() {
  return memFs(
    new Map([
      ['/p/.auth/user', 't'],
      ['/p/.account-fingerprint', 'f'.repeat(16)],
    ]),
  );
}

async function runInvoke(svc, prompt, options) {
  const out = [];
  for await (const m of svc.invoke(prompt, options)) out.push(m);
  return out;
}

function makeSvc(overrides = {}) {
  return new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    model: 'Auto',
    binary: '/usr/bin/true',
    profileFs: greenProfileFs(),
    toolAccess: 'disabled',
    ...overrides,
  });
}

function controlledFixture(name = 'tool-use', githubRead = false) {
  const expectedTools = [
    ...QODER_BASIC_TOOLS,
    ...QODER_READONLY_MEMORY_TOOLS.map((tool) => `mcp__${QODER_MEMORY_MCP_SERVER}__${tool}`),
  ];
  return fixtureLines(name).map((line) => {
    const event = JSON.parse(line);
    if (event.type === 'system' && event.subtype === 'init') {
      event.tools = [...expectedTools];
      event.mcp_servers = [{ name: QODER_MEMORY_MCP_SERVER, status: 'connected' }];
      if (githubRead) {
        event.tools.push('mcp__clowder-repository-read__github_read');
        event.mcp_servers.push({ name: 'clowder-repository-read', status: 'connected' });
      }
    }
    return JSON.stringify(event);
  });
}

function makeControlledRuntime(root, wrapperBody) {
  const runtimeRoot = join(root, 'runtime');
  const wrapperPath = join(runtimeRoot, 'scripts', 'qoder-shell-sandbox.mjs');
  const memoryPath = join(runtimeRoot, 'packages', 'mcp-server', 'dist', 'memory.js');
  mkdirSync(dirname(wrapperPath), { recursive: true });
  mkdirSync(dirname(memoryPath), { recursive: true });
  if (wrapperBody) writeFileSync(wrapperPath, wrapperBody);
  else {
    cpSync(join(here, '..', '..', '..', 'scripts', 'qoder-shell-sandbox.mjs'), wrapperPath);
  }
  chmodSync(wrapperPath, 0o755);
  writeFileSync(memoryPath, "process.stdout.write('memory-ok\\n');\n");
  // Structural controlled tests never execute the sandbox binary (probe is
  // stubbed), but validation requires an existing executable file — and the
  // macOS-only /usr/bin/sandbox-exec literal would fail that check on Linux.
  // Fail loud if a future change ever runs the stub: a silent exit-0 would
  // fake an "allowed" canary and hide the missing real sandbox.
  const sandboxExecPath = join(root, 'sandbox-exec');
  writeFileSync(sandboxExecPath, '#!/bin/sh\necho "test sandbox-exec stub must never execute" >&2\nexit 70\n');
  chmodSync(sandboxExecPath, 0o755);
  return { memoryPath, runtimeRoot, sandboxExecPath, wrapperPath };
}

test('GitHub read MCP: private HTTP header survives native config, never prompt/env/argv, then revokes before unlink', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qoder-gh-mcp-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const runtime = makeControlledRuntime(root);
  const token = 'h'.repeat(43);
  let configPath, config, spawnOptions, argv, prepared;
  let revoked = 0;
  try {
    const lines = controlledFixture('tool-use', true);
    const svc = makeSvc({
      toolAccess: 'controlled',
      memoryMcpServerPath: runtime.memoryPath,
      runtimeRoot: runtime.runtimeRoot,
      shellSandboxWrapperPath: runtime.wrapperPath,
      sandboxBinary: runtime.sandboxExecPath,
      sandboxProbe: () => {},
      spawnFn: (_command, args, options) => {
        argv = args;
        spawnOptions = options;
        configPath = args[args.indexOf('--mcp-config') + 1];
        config = JSON.parse(readFileSync(configPath, 'utf8'));
        assert.equal(statSync(configPath).mode & 0o777, 0o600);
        return fakeChild(lines);
      },
    });
    const out = await runInvoke(svc, 'read approved PRs through github_read', {
      workingDirectory: workspace,
      openGitHubReadLease: async () => ({
        token,
        queryUrl: 'http://127.0.0.1:43210/api/agent-github-read',
        mcpUrl: 'http://127.0.0.1:43210/api/agent-github-read/mcp',
        revoke() {
          revoked++;
          assert.ok(existsSync(configPath));
        },
      }),
      beforeProviderLaunch: async (request) => {
        prepared = request;
      },
    });
    assert.deepEqual(config?.mcpServers['clowder-repository-read'], {
      type: 'http',
      url: 'http://127.0.0.1:43210/api/agent-github-read/mcp',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.deepEqual(prepared.tools.declaredServerNames, [QODER_MEMORY_MCP_SERVER, 'clowder-repository-read']);
    assert.ok(!JSON.stringify([argv, spawnOptions.env, prepared, out]).includes(token));
    assert.equal(
      out.some((m) => m.type === 'error'),
      false,
      JSON.stringify(out),
    );
    assert.equal(revoked, 1);
    assert.equal(existsSync(configPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GitHub read MCP: denied grants preserve 18 tools and readonly policy never opens a lease', async () => {
  for (const readOnly of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'qoder-gh-no-grant-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const runtime = makeControlledRuntime(root);
    let opens = 0;
    let prepared;
    try {
      const svc = makeSvc({
        toolAccess: 'controlled',
        memoryMcpServerPath: runtime.memoryPath,
        runtimeRoot: runtime.runtimeRoot,
        shellSandboxWrapperPath: runtime.wrapperPath,
        sandboxBinary: runtime.sandboxExecPath,
        sandboxProbe: () => {},
        spawnFn: (_command, args) => {
          assert.ok(!args.some((arg) => arg.includes('clowder-repository-read')));
          if (!readOnly) {
            const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
            assert.deepEqual(Object.keys(config.mcpServers), [QODER_MEMORY_MCP_SERVER]);
          }
          return fakeChild(readOnly ? fixtureLines('success') : controlledFixture());
        },
      });
      const out = await runInvoke(svc, 'no granted GitHub read', {
        workingDirectory: workspace,
        ...(readOnly ? { toolExecutionPolicy: { mode: 'read_only' } } : {}),
        openGitHubReadLease: async () => {
          opens++;
          return null;
        },
        beforeProviderLaunch: async (request) => {
          prepared = request;
        },
      });
      assert.equal(opens, readOnly ? 0 : 1);
      assert.deepEqual(prepared.tools.declaredServerNames, readOnly ? [] : [QODER_MEMORY_MCP_SERVER]);
      assert.ok(
        out.some((m) => m.type === 'done'),
        JSON.stringify(out),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('GitHub read MCP: init surface mismatch and early exits revoke before removing private config', async () => {
  for (const failure of [
    'missing-tool',
    'missing-server',
    'disconnected',
    'extra-tool',
    'recorder',
    'spawn',
    'cancel',
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'qoder-gh-revoke-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const runtime = makeControlledRuntime(root);
    let configPath;
    let revoked = 0;
    let streamClosed = false;
    try {
      const svc = makeSvc({
        toolAccess: 'controlled',
        memoryMcpServerPath: runtime.memoryPath,
        runtimeRoot: runtime.runtimeRoot,
        shellSandboxWrapperPath: runtime.wrapperPath,
        sandboxBinary: runtime.sandboxExecPath,
        sandboxProbe: (p) => {
          configPath = p.mcpConfigPath;
        },
      });
      const invoke = svc.invoke('read approved PRs', {
        workingDirectory: workspace,
        openGitHubReadLease: async () => ({
          token: 'h'.repeat(43),
          queryUrl: 'http://127.0.0.1:43210/api/agent-github-read',
          mcpUrl: 'http://127.0.0.1:43210/api/agent-github-read/mcp',
          revoke() {
            revoked++;
            assert.ok(existsSync(configPath));
            if (failure !== 'recorder') assert.ok(streamClosed, 'provider stream closes before grant disposal');
          },
        }),
        beforeProviderLaunch: async () => {
          if (failure === 'recorder') throw new Error('recorder rejected');
        },
        spawnCliOverride: async function* () {
          try {
            if (failure === 'spawn') throw new Error('synthetic spawn failure');
            for (const line of controlledFixture('tool-use', true)) {
              const event = JSON.parse(line);
              if (event.type === 'system' && event.subtype === 'init') {
                if (failure === 'missing-tool') event.tools.pop();
                if (failure === 'missing-server') event.mcp_servers.pop();
                if (failure === 'disconnected') event.mcp_servers[1].status = 'disconnected';
                if (failure === 'extra-tool') event.tools.push('mcp__clowder-repository-read__write');
              }
              yield event;
            }
          } finally {
            streamClosed = true;
          }
        },
      });
      if (failure === 'cancel') {
        await invoke.next();
        await invoke.return();
      } else {
        const out = [];
        for await (const event of invoke) out.push(event);
        assert.ok(
          out.some((event) => event.type === 'error'),
          `${failure}: ${JSON.stringify(out)}`,
        );
        assert.ok(!out.some((event) => event.type === 'text'), 'reject drift before model content');
      }
      assert.equal(revoked, 1, failure);
      assert.equal(existsSync(configPath), false, failure);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test(
  'GitHub read lease stays outside scratch, is denied to real shells and revoked on every exit',
  { skip: process.platform !== 'darwin' },
  async () => {
    for (const recorderFails of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), 'qoder-gh-read-'));
      const workspace = join(root, 'workspace');
      mkdirSync(workspace);
      const runtime = makeControlledRuntime(root);
      const token = 'h'.repeat(43);
      let path;
      let revoked = 0;
      let prepared;
      try {
        const svc = makeSvc({
          toolAccess: 'controlled',
          memoryMcpServerPath: runtime.memoryPath,
          runtimeRoot: runtime.runtimeRoot,
          shellSandboxWrapperPath: runtime.wrapperPath,
          sandboxBinary: '/usr/bin/sandbox-exec',
          sandboxProbe: (probe) => {
            path = probe.mcpConfigPath;
            assert.ok(path && !path.startsWith(probe.scratchDir));
            assert.equal(statSync(path).mode & 0o777, 0o600);
            assert.equal(
              JSON.parse(readFileSync(path, 'utf8')).mcpServers['clowder-repository-read'].headers.Authorization,
              `Bearer ${token}`,
            );
            const env = Object.fromEntries(Object.entries(probe.childEnv).filter(([, v]) => v !== null));
            assert.ok(!JSON.stringify(env).includes(token));
            const denied = spawnSync(process.execPath, [runtime.wrapperPath, `/bin/cat '${path}'`], {
              env,
              encoding: 'utf8',
            });
            assert.notEqual(denied.status, 0, denied.stdout);
            assert.ok(!`${denied.stdout}${denied.stderr}`.includes(token));
            const mcpConfigPath = probe.mcpConfigPath;
            assert.ok(!mcpConfigPath.startsWith(probe.scratchDir));
            assert.equal(statSync(mcpConfigPath).mode & 0o777, 0o600);
            for (const policy of [env.CAT_CAFE_QODER_WORKSPACE_POLICY, env.CAT_CAFE_QODER_MEMORY_POLICY]) {
              const mcpRead = spawnSync('/usr/bin/sandbox-exec', ['-f', policy, '/bin/cat', mcpConfigPath], {
                env,
                encoding: 'utf8',
              });
              assert.notEqual(mcpRead.status, 0, mcpRead.stdout);
              assert.ok(!`${mcpRead.stdout}${mcpRead.stderr}`.includes(token));
            }
            const nested = spawnSync(process.execPath, [runtime.wrapperPath, 'env'], { env, encoding: 'utf8' });
            assert.equal(nested.status, 0, nested.stderr);
            assert.ok(!nested.stdout.includes(path));
          },
          spawnFn: () => fakeChild(controlledFixture('tool-use', true)),
        });
        const out = await runInvoke(svc, 'read approved PRs', {
          workingDirectory: workspace,
          openGitHubReadLease: async () => ({
            token,
            queryUrl: 'http://127.0.0.1:43210/api/agent-github-read',
            mcpUrl: 'http://127.0.0.1:43210/api/agent-github-read/mcp',
            revoke() {
              revoked++;
              assert.ok(existsSync(path));
            },
          }),
          beforeProviderLaunch: async (request) => {
            prepared = request;
            if (recorderFails) throw new Error('blocked');
          },
        });
        assert.equal(revoked, 1);
        assert.equal(existsSync(path), false);
        assert.ok(!JSON.stringify([prepared, out]).includes(token));
        assert.ok(
          out.some((m) => m.type === (recorderFails ? 'error' : 'done')),
          JSON.stringify(out),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);

test('L2: controlled invoke fails closed before spawn when sandbox-exec is unavailable', async () => {
  let spawned = 0;
  const svc = makeSvc({
    toolAccess: 'controlled',
    memoryMcpServerPath: '/runtime/packages/mcp-server/dist/memory.js',
    runtimeRoot: '/runtime',
    shellSandboxWrapperPath: '/runtime/scripts/qoder-shell-sandbox.mjs',
    sandboxBinary: '',
    spawnFn: () => {
      spawned += 1;
      return fakeChild(controlledFixture());
    },
  });

  const out = await runInvoke(svc, 'read the fixture', { workingDirectory: '/tmp/workspace-l2' });

  assert.equal(spawned, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'error');
  assert.match(out[0].error, /sandbox-exec is required/);
});

test('L2: controlled invoke fails closed before spawn when the sandbox binary path is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qoder-l2-missing-sandbox-'));
  const controlledRuntime = makeControlledRuntime(root);
  let spawned = 0;
  try {
    const svc = makeSvc({
      toolAccess: 'controlled',
      memoryMcpServerPath: controlledRuntime.memoryPath,
      runtimeRoot: controlledRuntime.runtimeRoot,
      shellSandboxWrapperPath: controlledRuntime.wrapperPath,
      sandboxBinary: join(root, 'no-such-sandbox-exec'),
      spawnFn: () => {
        spawned += 1;
        return fakeChild(controlledFixture());
      },
    });

    const out = await runInvoke(svc, 'read the fixture', { workingDirectory: '/tmp/workspace-l2' });

    assert.equal(spawned, 0);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'error');
    assert.match(out[0].error, /runtime sandbox asset unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('L2: controlled invoke delivers six basic tools and a strict readonly memory config, then cleans it up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qoder-l2-structural-'));
  const controlledRuntime = makeControlledRuntime(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const canonicalWorkspace = realpathSync(workspace);
  let mcpConfigPath;
  let mcpConfig;
  let mcpConfigMode;
  let seenArgs;
  let seenEnv;
  let workspacePolicy;
  let memoryPolicy;
  let memoryShim;
  let prepared;
  const svc = makeSvc({
    toolAccess: 'controlled',
    memoryMcpServerPath: controlledRuntime.memoryPath,
    runtimeRoot: controlledRuntime.runtimeRoot,
    shellSandboxWrapperPath: controlledRuntime.wrapperPath,
    sandboxBinary: controlledRuntime.sandboxExecPath,
    sandboxProbe: () => {},
    spawnFn: (_cmd, args, options) => {
      seenArgs = args;
      seenEnv = options.env;
      mcpConfigPath = args[args.indexOf('--mcp-config') + 1];
      mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      mcpConfigMode = statSync(mcpConfigPath).mode & 0o777;
      workspacePolicy = readFileSync(options.env.CAT_CAFE_QODER_WORKSPACE_POLICY, 'utf8');
      memoryPolicy = readFileSync(options.env.CAT_CAFE_QODER_MEMORY_POLICY, 'utf8');
      memoryShim = readFileSync(options.env.CAT_CAFE_QODER_MEMORY_SHIM, 'utf8');
      return fakeChild(controlledFixture());
    },
  });
  const callbackEnv = {
    CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
    CAT_CAFE_INVOCATION_ID: 'inv-l2',
    CAT_CAFE_CALLBACK_TOKEN: 'secret-token',
    CAT_CAFE_USER_ID: 'user-l2',
    CAT_CAFE_CAT_ID: CAT,
    CAT_CAFE_THREAD_ID: 'thread-l2',
  };
  const prevForceStorage = process.env.QODERCN_FORCE_FILE_STORAGE;
  const prevForceEncryptedStorage = process.env.QODERCN_FORCE_ENCRYPTED_FILE_STORAGE;
  const prevDisableUmid = process.env.QODERCN_DISABLE_UMID_REPORT;
  process.env.QODERCN_FORCE_FILE_STORAGE = 'false';
  process.env.QODERCN_FORCE_ENCRYPTED_FILE_STORAGE = 'false';
  process.env.QODERCN_DISABLE_UMID_REPORT = 'false';
  let out;
  try {
    out = await runInvoke(svc, 'read the fixture', {
      workingDirectory: workspace,
      callbackEnv,
      beforeProviderLaunch: async (request) => {
        prepared = request;
        return { requestGenerationId: 'rg', generationOrdinal: 1, sessionId: 's' };
      },
    });
  } finally {
    if (prevForceStorage === undefined) delete process.env.QODERCN_FORCE_FILE_STORAGE;
    else process.env.QODERCN_FORCE_FILE_STORAGE = prevForceStorage;
    if (prevForceEncryptedStorage === undefined) delete process.env.QODERCN_FORCE_ENCRYPTED_FILE_STORAGE;
    else process.env.QODERCN_FORCE_ENCRYPTED_FILE_STORAGE = prevForceEncryptedStorage;
    if (prevDisableUmid === undefined) delete process.env.QODERCN_DISABLE_UMID_REPORT;
    else process.env.QODERCN_DISABLE_UMID_REPORT = prevDisableUmid;
    rmSync(root, { recursive: true, force: true });
  }

  assert.ok(
    out.some((m) => m.type === 'done'),
    JSON.stringify(out),
  );
  assert.equal(
    seenEnv.QODERCN_FORCE_FILE_STORAGE,
    'true',
    'controlled spawn env must force the encrypted-file credential backend; inherited false must not win',
  );
  assert.equal(
    seenEnv.QODERCN_FORCE_ENCRYPTED_FILE_STORAGE,
    'true',
    'controlled spawn env must also force the level-1 hybrid-storage switch',
  );
  assert.equal(
    seenEnv.QODERCN_DISABLE_UMID_REPORT,
    'true',
    'controlled spawn env must disable the native UMID helper; inherited false must not win',
  );
  assert.ok(seenArgs.includes('--allowed-tools'));
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), [QODER_MEMORY_MCP_SERVER]);
  const memory = mcpConfig.mcpServers[QODER_MEMORY_MCP_SERVER];
  assert.equal(memory.command, seenEnv.CAT_CAFE_QODER_MEMORY_SHIM);
  assert.deepEqual(memory.args, []);
  assert.equal(memory.env.CAT_CAFE_READONLY, 'true');
  assert.equal(memory.env.CAT_CAFE_READONLY_AGENT_KEY_UNION, 'false');
  assert.equal(memory.env.ALLOWED_WORKSPACE_DIRS, canonicalWorkspace);
  assert.equal(memory.env.CAT_CAFE_API_URL, 'http://127.0.0.1:3004');
  assert.equal(memory.env.CAT_CAFE_CALLBACK_TOKEN, undefined, 'readonly memory does not receive write credentials');
  assert.equal(memory.env.CAT_CAFE_INVOCATION_ID, undefined, 'readonly memory does not receive invocation credentials');
  assert.equal(memory.env.QODERCN_DISABLE_UMID_REPORT, undefined, 'readonly memory does not receive Qoder-only env');
  assert.equal(mcpConfigMode, 0o600, 'invocation-scoped MCP config must be owner-readable only');
  assert.equal(
    seenEnv.CAT_CAFE_CALLBACK_TOKEN,
    undefined,
    'Qoder/Bash child env must not inherit callback credentials',
  );
  assert.equal(
    seenEnv.CAT_CAFE_INVOCATION_ID,
    undefined,
    'Qoder/Bash child env must not inherit invocation credentials',
  );
  assert.equal(seenEnv.QODERCN_SHELL_PREFIX, controlledRuntime.wrapperPath);
  assert.match(workspacePolicy, /\(deny file-read\*/);
  assert.match(workspacePolicy, /\(deny file-write\*\)/);
  assert.match(workspacePolicy, /qoder-l2-structural-/);
  assert.match(memoryPolicy, /packages\/mcp-server\/dist/);
  assert.match(memoryPolicy, /\(allow file-write\* \(subpath .*scratch/);
  assert.match(memoryShim, /packages\/mcp-server\/dist\/memory\.js/);
  assert.equal(existsSync(mcpConfigPath), false, 'invocation-scoped MCP config must be removed after invocation');
  assert.equal(existsSync(memory.command), false, 'memory shim must be removed after invocation');
  assert.equal(existsSync(seenEnv.CAT_CAFE_QODER_WORKSPACE_POLICY), false, 'sandbox policy must be removed');
  assert.equal(prepared.runtime.toolExecutionPolicy, 'workspace_write');
  assert.deepEqual(prepared.tools.declaredServerNames, [QODER_MEMORY_MCP_SERVER]);
});

test(
  'L2: macOS shell-prefix sandbox blocks policy self-selection and runtime-root reads',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'qoder-l2-seatbelt-'));
    const workspace = join(root, 'workspace');
    const inside = join(workspace, 'inside.txt');
    const outside = join(root, 'outside.txt');
    const controlledRuntime = makeControlledRuntime(root);
    const runtimeSecret = join(controlledRuntime.runtimeRoot, '.env');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(outside, 'outside-secret');
    writeFileSync(runtimeSecret, 'DEPLOY_TOKEN=seatbelt-canary');
    let canary;
    try {
      const svc = makeSvc({
        toolAccess: 'controlled',
        memoryMcpServerPath: controlledRuntime.memoryPath,
        runtimeRoot: controlledRuntime.runtimeRoot,
        shellSandboxWrapperPath: controlledRuntime.wrapperPath,
        sandboxBinary: '/usr/bin/sandbox-exec',
        spawnFn: (_cmd, _args, options) => {
          const run = (command) =>
            spawnSync(process.execPath, [controlledRuntime.wrapperPath, command], {
              env: options.env,
              encoding: 'utf8',
            });
          const shimPath = options.env.CAT_CAFE_QODER_MEMORY_SHIM;
          canary = {
            insideWrite: run(`/usr/bin/touch '${inside}'`).status,
            outsideWrite: run(`/usr/bin/touch '${outside}.new'`).status,
            outsideRead: run(`/bin/cat '${outside}'`).status,
            runtimeRead: run(`/bin/cat '${runtimeSecret}'`).status,
            shimOverwrite: run(`/usr/bin/printf '#!/bin/sh\\n/bin/cat "${runtimeSecret}"\\n' > '${shimPath}'`).status,
            shimExec: run(shimPath),
          };
          return fakeChild(controlledFixture());
        },
      });
      const out = await runInvoke(svc, 'sandbox canary', { workingDirectory: workspace });
      assert.ok(
        out.some((message) => message.type === 'done'),
        JSON.stringify(out),
      );
      assert.equal(canary.insideWrite, 0);
      assert.notEqual(canary.outsideWrite, 0);
      assert.notEqual(canary.outsideRead, 0);
      assert.notEqual(canary.runtimeRead, 0);
      assert.notEqual(canary.shimOverwrite, 0, 'Bash must not be able to replace the privileged memory shim');
      assert.doesNotMatch(
        canary.shimExec.stdout,
        /seatbelt-canary/,
        'exact shim command must not reveal runtime secrets',
      );
      assert.equal(existsSync(inside), true);
      assert.equal(existsSync(`${outside}.new`), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'L2: macOS controlled PATH resolves guarded gh and a runnable pnpm before provider spawn',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'qoder-l2-path-boundary-'));
    const workspace = join(root, 'workspace');
    const controlledRuntime = makeControlledRuntime(root);
    mkdirSync(workspace, { recursive: true });
    let attempts;
    try {
      const svc = makeSvc({
        toolAccess: 'controlled',
        memoryMcpServerPath: controlledRuntime.memoryPath,
        runtimeRoot: controlledRuntime.runtimeRoot,
        shellSandboxWrapperPath: controlledRuntime.wrapperPath,
        sandboxBinary: '/usr/bin/sandbox-exec',
        spawnFn: (_cmd, _args, options) => {
          const run = (command) =>
            spawnSync(process.execPath, [controlledRuntime.wrapperPath, command], {
              cwd: workspace,
              env: options.env,
              encoding: 'utf8',
            });
          attempts = {
            ghPath: run('command -v gh'),
            ghVersion: run('gh --version'),
            pnpmPath: run('command -v pnpm'),
            pnpmVersion: run('pnpm --version'),
          };
          return fakeChild(controlledFixture());
        },
      });
      const out = await runInvoke(svc, 'tool PATH canary', { workingDirectory: workspace });
      assert.ok(
        out.some((message) => message.type === 'done'),
        JSON.stringify(out),
      );
      assert.equal(attempts.ghPath.status, 0, attempts.ghPath.stderr);
      assert.match(attempts.ghPath.stdout, /scripts\/guarded-bin\/gh\s*$/);
      assert.equal(attempts.ghVersion.status, 0, attempts.ghVersion.stderr);
      assert.equal(attempts.pnpmPath.status, 0, attempts.pnpmPath.stderr);
      assert.equal(attempts.pnpmVersion.status, 0, attempts.pnpmVersion.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'L2: macOS shell-prefix sandbox denies shared git hooks/config and attacker-planted gitdir pointers',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'qoder-l2-git-boundary-'));
    const mainRepo = join(root, 'main-repo');
    const worktree = join(root, 'cat-worktree');
    const plantedWorkspace = join(root, 'planted-workspace');
    const controlledRuntime = makeControlledRuntime(root);
    try {
      assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', mainRepo]).status, 0);
      writeFileSync(join(mainRepo, 'README.md'), 'main repo\n');
      assert.equal(spawnSync('git', ['-C', mainRepo, 'add', '-A']).status, 0);
      assert.equal(
        spawnSync('git', ['-C', mainRepo, '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'init'])
          .status,
        0,
      );
      assert.equal(spawnSync('git', ['-C', mainRepo, 'worktree', 'add', '-q', worktree]).status, 0);
      writeFileSync(join(worktree, 'CHANGE.md'), 'sandboxed commit\n');
      const gitDir = realpathSync(
        resolve(worktree, readFileSync(join(worktree, '.git'), 'utf8').trim().slice('gitdir:'.length).trim()),
      );
      mkdirSync(plantedWorkspace, { recursive: true });
      writeFileSync(join(plantedWorkspace, '.git'), readFileSync(join(worktree, '.git'), 'utf8'));

      const hooksCanary = join(mainRepo, '.git', 'hooks', 'qoder-canary');
      const gitConfig = join(mainRepo, '.git', 'config');
      const mainRef = join(mainRepo, '.git', 'refs', 'heads', 'main');
      const forgedRef = join(mainRepo, '.git', 'refs', 'heads', 'qoder-forged');
      const sharedReflog = join(mainRepo, '.git', 'logs', 'HEAD');
      const originalConfig = readFileSync(gitConfig, 'utf8');
      const originalMainRef = readFileSync(mainRef, 'utf8');
      const originalSharedReflog = readFileSync(sharedReflog, 'utf8');
      const attempts = [];
      for (const workspace of [worktree, plantedWorkspace]) {
        const svc = makeSvc({
          toolAccess: 'controlled',
          memoryMcpServerPath: controlledRuntime.memoryPath,
          runtimeRoot: controlledRuntime.runtimeRoot,
          shellSandboxWrapperPath: controlledRuntime.wrapperPath,
          sandboxBinary: '/usr/bin/sandbox-exec',
          spawnFn: (_cmd, _args, options) => {
            const runResult = (command) =>
              spawnSync(process.execPath, [controlledRuntime.wrapperPath, command], {
                cwd: workspace,
                env: options.env,
                encoding: 'utf8',
              });
            const run = (command) => runResult(command).status;
            const gitCommit =
              workspace === worktree
                ? runResult(
                    `git -C '${worktree}' add CHANGE.md && git -C '${worktree}' -c user.email=a@b.c -c user.name=t commit -qm sandbox-canary`,
                  )
                : undefined;
            attempts.push({
              config: run(`/usr/bin/printf '\\n# qoder-canary\\n' >> '${gitConfig}'`),
              commondir: run(`/usr/bin/printf '../..\\n' > '${join(gitDir, 'commondir')}'`),
              gitCommit: gitCommit?.status,
              gitCommitStderr: gitCommit?.stderr,
              gitdir: run(`/usr/bin/printf '${join(plantedWorkspace, '.git')}\\n' > '${join(gitDir, 'gitdir')}'`),
              hooks: run(`/usr/bin/touch '${hooksCanary}'`),
              overwriteMainRef: run(`/usr/bin/printf '0000000000000000000000000000000000000000\\n' > '${mainRef}'`),
              removeMainRef: run(`/bin/rm -f '${mainRef}'`),
              removeSharedReflog: run(`/bin/rm -f '${sharedReflog}'`),
              writeForgedRef: run(`/usr/bin/printf '${originalMainRef.trim()}\\n' > '${forgedRef}'`),
            });
            return fakeChild(controlledFixture());
          },
        });
        const out = await runInvoke(svc, 'git boundary canary', { workingDirectory: workspace });
        assert.ok(
          out.some((message) => message.type === 'done'),
          JSON.stringify(out),
        );
      }

      assert.equal(attempts[0].gitCommit, 0, attempts[0].gitCommitStderr);
      assert.equal(attempts[0].config, 1);
      assert.equal(attempts[0].commondir, 1);
      assert.equal(attempts[0].gitdir, 1);
      assert.equal(attempts[0].hooks, 1);
      assert.equal(attempts[0].overwriteMainRef, 1);
      assert.equal(attempts[0].removeMainRef, 1);
      assert.equal(attempts[0].removeSharedReflog, 1);
      assert.equal(attempts[0].writeForgedRef, 1);
      assert.equal(attempts[1].gitCommit, undefined);
      assert.equal(attempts[1].config, 1);
      assert.equal(attempts[1].commondir, 1);
      assert.equal(attempts[1].gitdir, 1);
      assert.equal(attempts[1].hooks, 1);
      assert.equal(attempts[1].overwriteMainRef, 1);
      assert.equal(attempts[1].removeMainRef, 1);
      assert.equal(attempts[1].removeSharedReflog, 1);
      assert.equal(attempts[1].writeForgedRef, 1);
      assert.equal(existsSync(hooksCanary), false);
      assert.equal(existsSync(forgedRef), false);
      assert.equal(readFileSync(mainRef, 'utf8'), originalMainRef);
      assert.equal(readFileSync(sharedReflog, 'utf8'), originalSharedReflog);
      assert.equal(readFileSync(gitConfig, 'utf8'), originalConfig);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'L2: macOS direct-checkout workspace excludes .git except current branch commit metadata',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'qoder-l2-direct-git-'));
    const repo = join(root, 'repo');
    const controlledRuntime = makeControlledRuntime(root);
    try {
      assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', repo]).status, 0);
      writeFileSync(join(repo, 'README.md'), 'initial\n');
      assert.equal(spawnSync('git', ['-C', repo, 'add', '-A']).status, 0);
      assert.equal(
        spawnSync('git', ['-C', repo, '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'init']).status,
        0,
      );
      assert.equal(spawnSync('git', ['-C', repo, 'branch', 'sibling']).status, 0);
      writeFileSync(join(repo, 'CHANGE.md'), 'sandboxed direct commit\n');
      const mainRef = join(repo, '.git', 'refs', 'heads', 'main');
      const siblingRef = join(repo, '.git', 'refs', 'heads', 'sibling');
      const forgedRef = join(repo, '.git', 'refs', 'heads', 'forged');
      const reflogHead = join(repo, '.git', 'logs', 'HEAD');
      const originalSiblingRef = readFileSync(siblingRef, 'utf8');
      let attempts;
      const svc = makeSvc({
        toolAccess: 'controlled',
        memoryMcpServerPath: controlledRuntime.memoryPath,
        runtimeRoot: controlledRuntime.runtimeRoot,
        shellSandboxWrapperPath: controlledRuntime.wrapperPath,
        sandboxBinary: '/usr/bin/sandbox-exec',
        spawnFn: (_cmd, _args, options) => {
          const run = (command) =>
            spawnSync(process.execPath, [controlledRuntime.wrapperPath, command], {
              cwd: repo,
              env: options.env,
              encoding: 'utf8',
            });
          const commit = run(
            `git add CHANGE.md && git -c user.email=a@b.c -c user.name=t commit -qm sandbox-direct-canary`,
          );
          attempts = {
            commit,
            currentRef: run(`test -s '${mainRef}'`),
            forgedRef: run(`/usr/bin/printf '${originalSiblingRef.trim()}\\n' > '${forgedRef}'`),
            removeReflog: run(`/bin/rm -f '${reflogHead}'`),
            siblingRef: run(`/usr/bin/printf '0000000000000000000000000000000000000000\\n' > '${siblingRef}'`),
          };
          return fakeChild(controlledFixture());
        },
      });
      const out = await runInvoke(svc, 'direct git boundary canary', { workingDirectory: repo });
      assert.ok(
        out.some((message) => message.type === 'done'),
        JSON.stringify(out),
      );
      assert.equal(attempts.commit.status, 0, attempts.commit.stderr);
      assert.equal(attempts.currentRef.status, 0, attempts.currentRef.stderr);
      assert.equal(attempts.forgedRef.status, 1, attempts.forgedRef.stderr);
      assert.equal(attempts.removeReflog.status, 1, attempts.removeReflog.stderr);
      assert.equal(attempts.siblingRef.status, 1, attempts.siblingRef.stderr);
      assert.equal(existsSync(forgedRef), false);
      assert.equal(existsSync(reflogHead), true, 'reflog must survive: append-only, deletion denied');
      assert.equal(readFileSync(siblingRef, 'utf8'), originalSiblingRef);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'L2: missing or redirected HOME still denies operator-home and runtime credentials',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = mkdtempSync(join(homedir(), '.qoder-l2-nohome-'));
    const workspace = join(tmpdir(), `qoder-l2-nohome-workspace-${process.pid}`);
    const controlledRuntime = makeControlledRuntime(root);
    const runtimeSecret = join(controlledRuntime.runtimeRoot, '.env');
    const runtimeCredential = join(controlledRuntime.runtimeRoot, '.cat-cafe', 'credentials.json');
    const runtimeNpmrc = join(controlledRuntime.runtimeRoot, '.npmrc');
    const runtimeRootCredential = join(controlledRuntime.runtimeRoot, 'credentials.json');
    const runtimeSqlite = join(controlledRuntime.runtimeRoot, 'event-memory.sqlite');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(dirname(runtimeCredential), { recursive: true });
    writeFileSync(runtimeSecret, 'DEPLOY_TOKEN=nohome-canary');
    writeFileSync(runtimeCredential, 'credential-canary');
    writeFileSync(runtimeNpmrc, '_authToken=npm-canary');
    writeFileSync(runtimeRootCredential, 'root-credential-canary');
    writeFileSync(runtimeSqlite, 'sqlite-canary');
    const savedHome = process.env.HOME;
    const attempts = [];
    try {
      for (const home of [undefined, controlledRuntime.runtimeRoot]) {
        if (home === undefined) delete process.env.HOME;
        else process.env.HOME = home;
        const svc = makeSvc({
          toolAccess: 'controlled',
          memoryMcpServerPath: controlledRuntime.memoryPath,
          runtimeRoot: controlledRuntime.runtimeRoot,
          shellSandboxWrapperPath: controlledRuntime.wrapperPath,
          sandboxBinary: '/usr/bin/sandbox-exec',
          spawnFn: (_cmd, _args, options) => {
            const run = (path) =>
              spawnSync(process.execPath, [controlledRuntime.wrapperPath, `/bin/cat '${path}'`], {
                cwd: workspace,
                env: options.env,
                stdio: 'ignore',
              }).status;
            attempts.push({
              credential: run(runtimeCredential),
              env: run(runtimeSecret),
              npmrc: run(runtimeNpmrc),
              rootCredential: run(runtimeRootCredential),
              sqlite: run(runtimeSqlite),
            });
            return fakeChild(controlledFixture());
          },
        });
        const out = await runInvoke(svc, 'HOME fence canary', { workingDirectory: workspace });
        assert.ok(
          out.some((message) => message.type === 'done'),
          JSON.stringify(out),
        );
      }
      assert.deepEqual(attempts, [
        { credential: 1, env: 1, npmrc: 1, rootCredential: 1, sqlite: 1 },
        { credential: 1, env: 1, npmrc: 1, rootCredential: 1, sqlite: 1 },
      ]);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(root, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  'L2: a shell-prefix wrapper that does not enforce the deny probe fails closed before qodercn spawn',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'qoder-l2-prefix-canary-'));
    const workspace = join(root, 'workspace');
    const controlledRuntime = makeControlledRuntime(root, '#!/bin/sh\nexit 0\n');
    mkdirSync(workspace, { recursive: true });
    let spawned = 0;
    try {
      const svc = makeSvc({
        toolAccess: 'controlled',
        memoryMcpServerPath: controlledRuntime.memoryPath,
        runtimeRoot: controlledRuntime.runtimeRoot,
        shellSandboxWrapperPath: controlledRuntime.wrapperPath,
        sandboxBinary: '/usr/bin/sandbox-exec',
        spawnFn: () => {
          spawned += 1;
          return fakeChild(controlledFixture());
        },
      });
      const out = await runInvoke(svc, 'prefix canary', { workingDirectory: workspace });
      assert.equal(spawned, 0);
      assert.equal(out.length, 1);
      assert.equal(out[0].type, 'error');
      assert.match(out[0].error, /sandbox.*canary/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('L2: route read-only policy is supported and launches the legacy empty surface', async () => {
  let seenArgs;
  let prepared;
  const svc = makeSvc({
    toolAccess: 'controlled',
    memoryMcpServerPath: '/runtime/packages/mcp-server/dist/memory.js',
    spawnFn: (_cmd, args) => {
      seenArgs = args;
      return fakeChild(fixtureLines('success'));
    },
  });
  assert.equal(svc.supportsToolExecutionPolicy({ mode: 'read_only', replayDeniedToolNames: [] }), true);
  const out = await runInvoke(svc, 'summarize only', {
    workingDirectory: '/tmp',
    toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    beforeProviderLaunch: async (request) => {
      prepared = request;
      return { requestGenerationId: 'rg', generationOrdinal: 1, sessionId: 's' };
    },
  });
  assert.ok(
    out.some((m) => m.type === 'done'),
    JSON.stringify(out),
  );
  assert.equal(seenArgs[seenArgs.indexOf('--tools') + 1], '');
  assert.ok(!seenArgs.includes('--mcp-config'));
  assert.equal(prepared.runtime.toolExecutionPolicy, 'read_only');
  assert.deepEqual(prepared.tools.declaredServerNames, []);
});

test('invoke: workingDirectory missing → fail closed, no spawn', async () => {
  let spawned = 0;
  const svc = makeSvc({
    spawnFn: () => {
      spawned++;
      return fakeChild([]);
    },
  });
  const out = await runInvoke(svc, 'hi', {});
  assert.equal(spawned, 0);
  assert.ok(out[0].type === 'error' && out[0].error.includes('workingDirectory'));
});

test('invoke: success fixture → done with real init model + billing; argv has no prompt text', async () => {
  let seenArgs;
  const lines = fixtureLines('success');
  const svc = makeSvc({
    spawnFn: (_cmd, args) => {
      seenArgs = args;
      return fakeChild(lines);
    },
  });
  const out = await runInvoke(svc, 'reply with exactly: ok', { workingDirectory: '/tmp' });
  assert.ok(!seenArgs.includes('reply with exactly: ok'), 'prompt not in argv');
  const done = out.find((m) => m.type === 'done');
  assert.ok(done, 'done emitted');
  assert.equal(done.metadata.model, 'Auto', 'actual init model in metadata');
  assert.ok(done.metadata.qoderBilling.credits > 0);
});

for (const dialect of [
  { name: 'plural', open: '<tool_calls>', close: '</tool_calls>' },
  { name: 'singular', open: '<tool_call>', close: '</tool_call>' },
]) {
  test(`invoke: ${dialect.name} text tool protocol with success result → explicit error, never done`, async () => {
    const lines = fixtureLines('success').map((line) => {
      const event = JSON.parse(line);
      const text = event.message?.content?.find((block) => block.type === 'text');
      if (text) {
        text.text = [
          '我先查一下再回。',
          dialect.open,
          '<tool><tool_name>bash</tool_name><command>gh auth status</command></tool>',
          dialect.close,
        ].join('\n');
      }
      if (event.type === 'result') {
        event.result = '我先查一下再回。';
        event.is_error = false;
        event.subtype = 'success';
      }
      return JSON.stringify(event);
    });
    const svc = makeSvc({ spawnFn: () => fakeChild(lines) });

    const out = await runInvoke(svc, 'inspect gh auth', { workingDirectory: '/tmp' });

    assert.ok(out.some((m) => m.type === 'text' && m.content === '我先查一下再回。'));
    assert.ok(!out.some((m) => m.type === 'done'), 'unexecuted tool request must not be accepted as done');
    assert.ok(
      out.some((m) => m.type === 'error' && /tool.+disabled|unavailable tool/i.test(m.error)),
      JSON.stringify(out),
    );
  });
}

test('invoke: result-only text tool protocol → explicit error, never done', async () => {
  const lines = fixtureLines('success')
    .filter((line) => {
      const event = JSON.parse(line);
      return !event.message?.content?.some((block) => block.type === 'text');
    })
    .map((line) => {
      const event = JSON.parse(line);
      if (event.type === 'result') {
        event.result = [
          '我先查一下再回。',
          '<tool_calls>',
          '<tool><tool_name>bash</tool_name><command>gh auth status</command></tool>',
          '</tool_calls>',
        ].join('\n');
        event.is_error = false;
        event.subtype = 'success';
      }
      return JSON.stringify(event);
    });
  const svc = makeSvc({ spawnFn: () => fakeChild(lines) });

  const out = await runInvoke(svc, 'inspect gh auth', { workingDirectory: '/tmp' });

  assert.ok(!out.some((m) => m.type === 'done'), 'result-only unexecuted tool request must not become done');
  assert.ok(
    out.some((m) => m.type === 'error' && /tool.+disabled|unavailable tool/i.test(m.error)),
    JSON.stringify(out),
  );
});

// round-3 P1④：未认证 CLI 回报小写 auto（auth-error 夹具实测）→ 精确匹配 fail closed。
// 旧契约（大小写宽容）会把这次漂移放行到 result error；精确匹配把它挡在 init 门。
test('invoke: auth-error fixture → init gate red on model drift (auto != Auto), never done (P1-D)', async () => {
  const svc = makeSvc({ spawnFn: () => fakeChild(fixtureLines('auth-error'), { exitCode: 1 }) });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  assert.ok(!out.some((m) => m.type === 'done'), 'no done for unauthenticated drift');
  assert.ok(
    out.some((m) => m.type === 'error' && /init gate failed[^\n]*model auto/i.test(m.error)),
    out[0]?.error,
  );
});

test('invoke: tool-use fixture (full tool surface) → init gate red, stream aborted', async () => {
  const svc = makeSvc({ spawnFn: () => fakeChild(fixtureLines('tool-use')) });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  assert.ok(!out.some((m) => m.type === 'done'));
  assert.ok(out.some((m) => m.type === 'error' && m.error.includes('init gate')));
});

test('invoke: assistant before init → fail closed', async () => {
  const assistantLine = fixtureLines('tool-use').find((l) => l.includes('"type":"assistant"'));
  const svc = makeSvc({ spawnFn: () => fakeChild([assistantLine]) });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  assert.ok(out.some((m) => m.type === 'error' && m.error.includes('before passing init gate')));
});

// round-3 P1①：raw stderr 不内联进用户可见错误（F212 AC-A9 对齐：humanized only）；
// exit code 如实透传。stderr 的脱敏/有界由共享 spawnCli 拥有（暴露面同步 sanitize、封顶尾窗）。
test('invoke: nonzero exit after successful result → error terminal with exit code, no raw stderr inlined', async () => {
  const svc = makeSvc({
    spawnFn: () => fakeChild(fixtureLines('success'), { exitCode: 3, stderr: ['boom plain diagnostics'] }),
  });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  const err = out.find((m) => m.type === 'error');
  assert.ok(err, 'error terminal');
  assert.ok(/code: 3/.test(err.error), `exit code surfaced: ${err.error}`);
  assert.ok(!err.error.includes('boom'), `raw stderr must not be inlined: ${err.error}`);
});

test('invoke: default profile fs works on real dirs (default-constructor path)', async () => {
  // 无 profileFs 注入：真实 fs + 真临时绿 profile（覆盖 defaultQoderProfileFs 路径）
  const root = mkdtempSync(join(tmpdir(), 'qoder-default-'));
  const prof = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'd1', authSourceDir: makeAuth(root, 'tok') });
  assert.equal(prof.audit.ok, true);
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: prof.profileDir,
    model: 'Auto',
    binary: '/usr/bin/true',
    spawnFn: () => fakeChild(fixtureLines('success')),
  });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  assert.ok(out.some((m) => m.type === 'done'));
  rmSync(root, { recursive: true, force: true });
});

// ══ round-2 P1 回归：全部走真实 invoke() ═════════════════════════════════

test('round2 P1-2: beforeProviderLaunch rejecting → 0 spawn, no prompt leaves', async () => {
  let spawned = 0;
  const svc = makeSvc({
    spawnFn: () => {
      spawned++;
      return fakeChild(fixtureLines('success'));
    },
  });
  const out = await runInvoke(svc, 'must-not-send', {
    workingDirectory: '/tmp',
    beforeProviderLaunch: async () => {
      throw new Error('recorder says no');
    },
  });
  assert.equal(spawned, 0, 'recorder rejection must prevent spawn');
  assert.ok(out.some((m) => m.type === 'error' && m.error.includes('recorder')));
});

test('round2 P1-3: pre-aborted signal → 0 spawn, prompt never written', async () => {
  let spawned = 0;
  const written = [];
  const ac = new AbortController();
  ac.abort();
  const svc = makeSvc({
    spawnFn: () => {
      spawned++;
      return fakeChild([], { stdin: { recorder: written } });
    },
  });
  const out = await runInvoke(svc, 'must-not-send', { workingDirectory: '/tmp', signal: ac.signal });
  assert.equal(spawned, 0, 'pre-aborted signal must prevent spawn entirely');
  assert.equal(written.length, 0);
  assert.ok(out.some((m) => m.type === 'error' && m.error.includes('aborted')));
});

test('round2 P1-4: streaming — messages yield before stream end (no full buffering)', async () => {
  // init + assistant 通过后，流保持打开：首个 next() 必须已能拿到 session_init
  const child = new EventEmitter();
  const ctrl = new Readable({ read() {} });
  child.stdout = ctrl;
  child.stderr = Readable.from([]);
  child.stdin = fakeStdin();
  child.kill = () => {
    child.emit('close', 0, null);
  };
  const svc = makeSvc({
    spawnFn: () => {
      const init = fixtureLines('hook-green-project').find((l) => l.includes('"subtype":"init"'));
      ctrl.push(init + '\n');
      return child;
    },
  });
  const iter = svc.invoke('hi', { workingDirectory: '/tmp' });
  const first = await iter.next();
  assert.ok(first.done !== true);
  assert.equal(first.value.type, 'session_init', 'init yielded while stream still open');
  // 终结流（result + EOF + close），迭代到 done
  ctrl.push(fixtureLines('success').find((l) => l.includes('"type":"result"')) + '\n');
  ctrl.push(null);
  child.emit('close', 0, null);
  let done = false;
  for await (const m of iter) if (m.type === 'done') done = true;
  assert.ok(done);
});

test('round2 P1-5: stderr secrets redacted before reaching user-visible error', async () => {
  const secret = 'Authorization: Bearer sk-proj-1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const svc = makeSvc({
    spawnFn: () => fakeChild(fixtureLines('auth-error'), { exitCode: 1, stderr: [secret] }),
  });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  const err = out.find((m) => m.type === 'error');
  assert.ok(err);
  assert.ok(!err.error.includes('sk-proj-1234567890'), 'raw token must not leak');
  assert.ok(err.error.includes('<redacted>') || !err.error.includes('Bearer sk-'), 'redaction applied');
});

test('round2 P1-7: swap rename failure leaves no staging orphan with credentials', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-fault-'));
  const authA = makeAuth(root, 'token-A');
  const authB = makeAuth(root, 'token-B');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  assert.equal(first.audit.ok, true);
  let renameCalls = 0;
  const fs = {
    ...base,
    renameSync: (f, t) => {
      renameCalls++;
      // 只打中 staging→live 那一步；回滚 rename 放行（真实单点故障）
      if (renameCalls === 2) throw new Error('EIO injected');
      base.renameSync(f, t);
    },
  };
  const failed = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authB, fs });
  assert.equal(failed.audit.ok, false, 'swap with injected EIO fails');
  // live 仍为 A（回滚），且不残留任何含 B 凭证的 staging 目录
  assert.equal(readFileSync(join(first.profileDir, '.auth', 'user'), 'utf8'), 'token-A');
  const leftovers = readdirSync(join(root, 'qoder-profiles')).filter((n) => n.includes('staging'));
  assert.equal(leftovers.length, 0, 'no staging orphan with new-account credentials');
  rmSync(root, { recursive: true, force: true });
});

// ══ round-3 P1①②③④⑥：Service 层红绿 ═══════════════════════════════════

// P1②：abort 检查先于 recorder —— 已取消的请求不落档（recorder 一次都不能被调）
test('round3 P1-2a: pre-aborted signal → recorder NOT invoked, 0 spawn', async () => {
  let recorderCalled = 0;
  let spawned = 0;
  const ac = new AbortController();
  ac.abort();
  const svc = makeSvc({
    spawnFn: () => {
      spawned++;
      return fakeChild(fixtureLines('success'));
    },
  });
  const out = await runInvoke(svc, 'must-not-send', {
    workingDirectory: '/tmp',
    signal: ac.signal,
    beforeProviderLaunch: async () => {
      recorderCalled++;
    },
  });
  assert.equal(recorderCalled, 0, 'pre-abort must precede recorder (no archive of a dead request)');
  assert.equal(spawned, 0);
  assert.ok(out.some((m) => m.type === 'error' && m.error.includes('aborted')));
});

// P1②：prepared request 深度冻结 —— recorder 试图改写落档字节直接 TypeError
test('round3 P1-2b: prepared request deep-frozen — recorder mutation throws', async () => {
  let prepared;
  const svc = makeSvc({ spawnFn: () => fakeChild(fixtureLines('success')) });
  const out = await runInvoke(svc, 'original-prompt', {
    workingDirectory: '/tmp',
    beforeProviderLaunch: async (req) => {
      prepared = req;
      assert.throws(
        () => {
          req.message.body = 'evil';
        },
        TypeError,
        'frozen request must reject mutation',
      );
    },
  });
  assert.ok(
    out.some((m) => m.type === 'done'),
    'clean recorder → invocation proceeds',
  );
  assert.equal(prepared.message.body, 'original-prompt', 'archived bytes immutable');
});

// P1④：done metadata 携带显式 -m provenance（requested 与 CLI 精确回报一致才走到这里）
test('round3 P1-4b: done metadata carries explicit -m provenance', async () => {
  const svc = makeSvc({ spawnFn: () => fakeChild(fixtureLines('success')) });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  const done = out.find((m) => m.type === 'done');
  assert.ok(done);
  assert.equal(done.metadata.modelProvenance, 'explicit-cli-flag');
  assert.equal(done.metadata.requestedModel, 'Auto');
  assert.equal(done.metadata.model, 'Auto', 'reported model equals requested (exact match)');
});

// P1③：共享 spawnCli 的 stdin EPIPE 守卫——prompt 写入遇 EPIPE 不得炸掉整个 invocation
test('round3 P1-3a: EPIPE on stdin write is contained (shared spawnCli EPIPE guard)', async () => {
  const svc = makeSvc({
    spawnFn: () => fakeChild(fixtureLines('success'), { stdin: { epipe: true } }),
  });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  assert.ok(
    out.some((m) => m.type === 'done'),
    'EPIPE during prompt write must not crash the invocation',
  );
});

// P1③：init 门红了之后走共享有界终止——invoke 立即返回，不再有 5s 非 unref 计时器
// + 250×20ms exit 轮询阻塞
test('round3 P1-3b: init-gate red aborts via shared bounded termination (prompt return, no 5s block)', async () => {
  const child = new EventEmitter();
  child.stdout = Readable.from(fixtureLines('tool-use').map((l) => l + '\n'));
  child.stderr = Readable.from([]);
  child.stdin = fakeStdin();
  child.pid = 4194304 + Math.floor(Math.random() * 1000);
  child.kill = () => {
    child.killed = true;
    // 忽略 SIGTERM：绝不 close —— 考验有界终止与调用方返回解耦
  };
  const svc = makeSvc({ spawnFn: () => child });
  const t0 = Date.now();
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  const elapsed = Date.now() - t0;
  assert.ok(out.some((m) => m.type === 'error' && m.error.includes('init gate')));
  assert.ok(elapsed < 3000, `invoke must return promptly on gate red (took ${elapsed}ms)`);
});

// P1③：raw NDJSON 事件经共享 sink 落档（#780 先例），payload 过 sanitizeRawEvent
test('round3 P1-3c: raw NDJSON events archived via shared sink when invocationId present', async () => {
  const archived = [];
  const rawArchive = {
    append: async (id, payload) => {
      archived.push([id, payload]);
    },
    getPath: (id) => `/tmp/arc-${id}.ndjson`,
  };
  const svc = makeSvc({ rawArchive, spawnFn: () => fakeChild(fixtureLines('success')) });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp', invocationId: 'inv-test-1' });
  assert.ok(out.some((m) => m.type === 'done'));
  assert.ok(archived.length >= 3, `init/assistant/result events archived (got ${archived.length})`);
  assert.ok(archived.every(([id]) => id === 'inv-test-1'));
});

// P1⑥：resume 是对 provider 已初始化 profile 的二次信任——session 必须真实存在于本 profile
test('round3 P1-6a: resume without session in runtime profile → fail closed, 0 spawn', async () => {
  let spawned = 0;
  const svc = makeSvc({
    spawnFn: () => {
      spawned++;
      return fakeChild(fixtureLines('resume'));
    },
  });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp', sessionId: 'sess-12345678' });
  assert.equal(spawned, 0, 'resume audit must gate spawn');
  assert.ok(out.some((m) => m.type === 'error' && m.error.includes('resume')));
});

test('round3 P1-6b: resume against provider-initialized profile (projects/<slug>/<sid>.jsonl) proceeds', async () => {
  const sid = 'f8a72ea8-b30d-44b8-82e0-48c0a7f020f5';
  const fs = memFs(
    new Map([
      ['/p/.auth/user', 't'],
      ['/p/.account-fingerprint', 'f'.repeat(16)],
      [`/p/projects/-tmp-wksp/${sid}.jsonl`, '{"x":1}'],
    ]),
  );
  const svc = makeSvc({ profileFs: fs, spawnFn: () => fakeChild(fixtureLines('resume')) });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp/wksp', sessionId: sid });
  assert.ok(
    out.some((m) => m.type === 'done'),
    'provider-initialized profile with matching session resumes',
  );
});

test('round3 P1-6c: unsafe sessionId charset rejected before spawn', async () => {
  let spawned = 0;
  const svc = makeSvc({
    spawnFn: () => {
      spawned++;
      return fakeChild(fixtureLines('success'));
    },
  });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp', sessionId: '../../evil' });
  assert.equal(spawned, 0);
  assert.ok(out.some((m) => m.type === 'error' && m.error.includes('charset')));
});

// ══ round-4（PR #24 review：砚砚 3×P1 + 1×P2）══════════════════════════════

// P1-1：provider 正常初始化产物不得误杀（L1 audit_auth 攻击面 = plugins/ 子树；
// 实测本机 .qoder-cn/security-resources/security-scan/bin/qodersec-launch.sh）
test('round4 P1-1a: provider-owned security-resources scripts do not fail the audit', () => {
  const fs = memFs(
    new Map([
      ['/p/.auth/user', 't'],
      ['/p/.account-fingerprint', 'f'.repeat(16)],
      ['/p/security-resources/security-scan/bin/qodersec-launch.sh', '#!/bin/sh'],
      ['/p/security-resources/security-scan/bin/qodersec-launch.cmd', 'x'],
      ['/p/security-resources/security-scan/.qoder-plugin/plugin.json', '{}'],
      ['/p/logs/session.log', 'x'],
    ]),
  );
  const a = auditQoderProfile('/p', fs);
  assert.equal(a.ok, true, JSON.stringify(a.violations));
});

test('round4 P1-1b: first invocation provider-owned profile → second invocation + resume stay green', async () => {
  const sid = 'f8a72ea8-b30d-44b8-82e0-48c0a7f020f5';
  const fs = memFs(
    new Map([
      ['/p/.auth/user', 't'],
      ['/p/.account-fingerprint', 'f'.repeat(16)],
      ['/p/security-resources/security-scan/bin/qodersec-launch.sh', '#!/bin/sh'],
      [`/p/projects/-tmp-wksp/${sid}.jsonl`, '{}'],
    ]),
  );
  const svc = makeSvc({ profileFs: fs, spawnFn: () => fakeChild(fixtureLines('resume')) });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp/wksp', sessionId: sid });
  assert.ok(
    out.some((m) => m.type === 'done'),
    'provider-initialized profile must stay invocable (no reseed, session preserved)',
  );
});

// P1-2：F089 seam——options.spawnCliOverride 优先于共享 spawnCli，且 cliOpts 带 rawArchivePath
test('round4 P1-2: options.spawnCliOverride takes precedence and receives rawArchivePath', async () => {
  let directSpawns = 0;
  let overrideCalls = 0;
  let overrideSawArchivePath = null;
  const lines = fixtureLines('success');
  const svc = makeSvc({
    spawnFn: () => {
      directSpawns++;
      return fakeChild(lines);
    },
    rawArchive: {
      append: async () => {},
      getPath: (id) => `/tmp/arc-${id}.ndjson`,
    },
  });
  const out = await runInvoke(svc, 'hi', {
    workingDirectory: '/tmp',
    invocationId: 'inv-r4',
    spawnCliOverride: (cliOpts) => {
      overrideCalls++;
      overrideSawArchivePath = cliOpts.rawArchivePath;
      return (async function* () {
        for (const l of lines) yield JSON.parse(l);
      })();
    },
  });
  assert.equal(overrideCalls, 1, 'override must be the spawn path');
  assert.equal(directSpawns, 0, 'shared spawnCli must not run when override present');
  assert.ok(out.some((m) => m.type === 'done'));
  assert.ok(
    typeof overrideSawArchivePath === 'string' && overrideSawArchivePath.includes('inv-r4'),
    `cliOpts carries rawArchivePath for timeout diagnostics, got: ${String(overrideSawArchivePath)}`,
  );
});

// P1-3：canonical cwd 绑定——session 在别的 workspace 项目目录下时必须拒绝
test('round4 P1-3a: resume across different cwd is rejected (canonical project dir binding)', async () => {
  let spawned = 0;
  const sid = 'f8a72ea8-b30d-44b8-82e0-48c0a7f020f5';
  const fs = memFs(
    new Map([
      ['/p/.auth/user', 't'],
      ['/p/.account-fingerprint', 'f'.repeat(16)],
      [`/p/projects/-tmp-workspace-a/${sid}.jsonl`, '{}'],
    ]),
  );
  const svc = makeSvc({
    profileFs: fs,
    spawnFn: () => {
      spawned++;
      return fakeChild(fixtureLines('resume'));
    },
  });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp/workspace-b', sessionId: sid });
  assert.equal(spawned, 0, 'cross-cwd resume must not spawn');
  assert.ok(out.some((m) => m.type === 'error' && m.error.includes('resume audit failed')));
});

test('round4 P1-3b: qoderProjectSlug matches the provider canonical mapping', () => {
  const qoderProjectSlug = profileModule.qoderProjectSlug;
  assert.equal(typeof qoderProjectSlug, 'function', 'exported canonical slug');
  assert.equal(qoderProjectSlug('/tmp/wksp-a'), '-tmp-wksp-a');
  assert.equal(qoderProjectSlug('/Users/yuhan/cat-cafe'), '-Users-yuhan-cat-cafe');
  assert.equal(qoderProjectSlug('/tmp/wksp a+b'), '-tmp-wksp-a-b');
  // >200 字符：截断到 200 + '-' + djb2-xor base36 后缀（provider MI() 同款形状）
  const long = `/${'x'.repeat(250)}`;
  const s = qoderProjectSlug(long);
  assert.ok(s.length > 200 && s.length <= 200 + 1 + 12, `truncated+hash shape, got len ${s.length}`);
  assert.ok(s.startsWith(`-${'x'.repeat(199)}`), 'prefix is the truncated dash form');
});

// P2-4：spawn 层同步异常 → typed error 终态，不从 iterable 逸出
test('round4 P2-4: sync spawn error surfaces as typed error message, not iterator rejection', async () => {
  const svc = makeSvc({
    spawnFn: () => {
      throw Object.assign(new Error('EACCES injected'), { code: 'EACCES' });
    },
  });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  assert.ok(Array.isArray(out) && out.length === 1, 'exactly one terminal message');
  assert.ok(out[0].type === 'error' && out[0].error.includes('spawn failed'), JSON.stringify(out));
});

// ══ round-5（PR #24 round-4 review：砚砚新 P1——顶节 symlink custody 回归）═══
// 真实文件系统复现砚砚的两条绕过：.auth → 外部目录、plugins → 外部空目录
// 都曾被 auditQoderProfile 判绿。I-11 §1：profile 由 runtime 拥有、用户个人目录不可达。
test('round5 P1: .auth root symlink to an external dir fails closed', async () => {
  const { base } = await realFsWrappers();
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'qoder-r5a-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  assert.equal(first.audit.ok, true);
  const external = mkdtempSync(join(tmpdir(), 'qoder-r5a-ext-'));
  writeFileSync(join(external, 'user'), 'external-credential');
  rmSync(join(first.profileDir, '.auth'), { recursive: true, force: true });
  symlinkSync(external, join(first.profileDir, '.auth'), 'dir');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false, '.auth symlink must be a violation');
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

test('round5 P1: plugins root symlink to an external dir fails closed (custody ≠ artifact scope)', async () => {
  const { base } = await realFsWrappers();
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'qoder-r5b-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  assert.equal(first.audit.ok, true);
  const external = mkdtempSync(join(tmpdir(), 'qoder-r5b-ext-'));
  symlinkSync(external, join(first.profileDir, 'plugins'), 'dir');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false, 'plugins root symlink must be a violation');
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

// 对照组：真实目录的 .auth / plugins 不误杀（custody 只拒链接与非目录节点）
test('round5 P1: real-dir .auth and plugins pass custody (no false positive)', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-r5c-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  mkdirSync(join(first.profileDir, 'plugins'), { recursive: true });
  writeFileSync(join(first.profileDir, 'plugins', 'notes.txt'), 'not executable');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, true, JSON.stringify(a.violations));
  rmSync(root, { recursive: true, force: true });
});

// ══ round-6（PR #24 round-5 review：砚砚 P1——dangling symlink 经 existsSync 绕过 custody）═══
test('round6 P1: dangling plugins symlink fails closed (no link-following existence gate)', async () => {
  const { base } = await realFsWrappers();
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'qoder-r6a-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  assert.equal(first.audit.ok, true);
  // 断链：目标此刻不存在（若审计后、CLI 启动前目标出现，即越过 runtime-owned 边界）
  symlinkSync(join(root, 'not-yet-existing-external'), join(first.profileDir, 'plugins'), 'dir');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false, 'dangling plugins symlink must be a violation');
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
});

test('round6 P1: regular file occupying the plugins root fails closed', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-r6b-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  writeFileSync(join(first.profileDir, 'plugins'), 'not a directory');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false, 'non-directory plugins root must be a violation');
  assert.ok(
    a.violations.some((v) => /not a real directory|non-directory/i.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
});

test('round6 P1: FIFO at the .auth position fails closed (non-directory node)', async () => {
  const { base } = await realFsWrappers();
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'qoder-r6c-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  rmSync(join(first.profileDir, '.auth'), { recursive: true, force: true });
  const fifo = join(first.profileDir, '.auth');
  const mk = spawnSync('mkfifo', [fifo]);
  assert.equal(mk.status, 0, 'mkfifo available on posix');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false, 'FIFO at custody position must be a violation');
  assert.ok(
    a.violations.some((v) => /not a real directory|non-directory/i.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
});

// ══ round-7（PR #24 round-6 review：砚砚 P1——profile custody 点状化，未按根因收口）═══
// 三条真实 fs 复现：settings 悬链 / 外置 projects（resume 也过）/ 外置 security-resources
test('round7 P1: dangling settings.json symlink fails closed (pre-execution hook gate stays in-profile)', async () => {
  const { base } = await realFsWrappers();
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'qoder-r7a-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  assert.equal(first.audit.ok, true);
  symlinkSync(join(root, 'not-yet-external-settings.json'), join(first.profileDir, 'settings.json'));
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false, 'dangling settings.json symlink must be a violation');
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
});

test('round7 P1: external projects symlink fails the profile audit even with a canonical session inside', async () => {
  const { base } = await realFsWrappers();
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'qoder-r7b-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  const sid = 'f8a72ea8-b30d-44b8-82e0-48c0a7f020f5';
  const externalProjects = mkdtempSync(join(tmpdir(), 'qoder-r7b-ext-'));
  mkdirSync(join(externalProjects, '-tmp-wksp'), { recursive: true });
  writeFileSync(join(externalProjects, '-tmp-wksp', `${sid}.jsonl`), '{}');
  symlinkSync(externalProjects, join(first.profileDir, 'projects'), 'dir');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false, 'external projects symlink must be a violation');
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(externalProjects, { recursive: true, force: true });
});

test('round7 P1: external security-resources symlink fails closed (provider exec path stays runtime-owned)', async () => {
  const { base } = await realFsWrappers();
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'qode-r7c-'.replace('qode-', 'qoder-')));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  const external = mkdtempSync(join(tmpdir(), 'qoder-r7c-ext-'));
  mkdirSync(join(external, 'security-scan', 'bin'), { recursive: true });
  writeFileSync(join(external, 'security-scan', 'bin', 'qodersec-launch.sh'), '#!/bin/sh\n');
  symlinkSync(external, join(first.profileDir, 'security-resources'), 'dir');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false, 'external security-resources symlink must be a violation');
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

// 对照：真实目录的 security-resources（含 .sh）不回杀——executable 判定仍只限 plugins/
test('round7 control: real-dir security-resources with scripts stays green', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-r7d-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  mkdirSync(join(first.profileDir, 'security-resources', 'security-scan', 'bin'), { recursive: true });
  writeFileSync(
    join(first.profileDir, 'security-resources', 'security-scan', 'bin', 'qodersec-launch.sh'),
    '#!/bin/sh\n',
  );
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, true, JSON.stringify(a.violations));
  rmSync(root, { recursive: true, force: true });
});

// ══ round-8（PR #24 round-7 review：点点 1×P1 + 2×P3——traversal 不查自己的起点）═══
test('round8 P1-a: profile root symlink to a sibling audit-green profile fails closed (per-cat ownership)', async () => {
  const { base } = await realFsWrappers();
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'qoder-r8a-'));
  const authA = makeAuth(root, 'token-A');
  const other = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'cat_other', authSourceDir: authA, fs: base });
  assert.equal(other.audit.ok, true);
  symlinkSync(other.profileDir, join(root, 'qoder-profiles', 'cat_victim'), 'dir');
  const victim = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'cat_victim', authSourceDir: authA, fs: base });
  assert.equal(victim.audit.ok, false, 'root symlink must not cross per-cat ownership');
  assert.ok(
    victim.audit.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(victim.audit.violations),
  );
  const direct = auditQoderProfile(join(root, 'qoder-profiles', 'cat_victim'), base);
  assert.equal(direct.ok, false, 'invocation-time audit (no expected fingerprint) must also reject');
  rmSync(root, { recursive: true, force: true });
});

test('round8 P1-b: profile root symlink to an external green dir fails the invocation-time audit', async () => {
  const { base } = await realFsWrappers();
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'qoder-r8b-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  const external = mkdtempSync(join(tmpdir(), 'qoder-r8b-ext-'));
  mkdirSync(join(external, '.auth'), { recursive: true });
  writeFileSync(join(external, '.auth', 'user'), 'token-A');
  writeFileSync(join(external, '.account-fingerprint'), 'f'.repeat(16));
  assert.equal(auditQoderProfile(external, base).ok, true, 'external dir itself is audit-green (control)');
  rmSync(join(first.profileDir, '.auth'), { recursive: true, force: true });
  writeFileSync(join(first.profileDir, 'x'), ''); // 保证非空占位
  rmSync(first.profileDir, { recursive: true, force: true });
  symlinkSync(external, first.profileDir, 'dir');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false, 'root link must fail the Service-level pre-invoke audit');
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

test('round8 P1-c: qoder-profiles root itself a symlink is rejected by ensure', async () => {
  const { base } = await realFsWrappers();
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'qoder-r8c-'));
  const authA = makeAuth(root, 'token-A');
  const externalRoot = mkdtempSync(join(tmpdir(), 'qoder-r8c-ext-'));
  symlinkSync(externalRoot, join(root, 'qoder-profiles'), 'dir');
  const res = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  assert.equal(res.audit.ok, false, 'profiles root escaping dataRoot must be rejected');
  assert.ok(
    res.audit.violations.some((v) => /symlink|custody/.test(v)),
    JSON.stringify(res.audit.violations),
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(externalRoot, { recursive: true, force: true });
});

test('round8 P1-d control: real-directory profile root stays green (realpath-normalized tmp dirs)', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-r8d-'));
  const authA = makeAuth(root, 'token-A');
  const res = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  assert.equal(res.audit.ok, true, JSON.stringify(res.audit.violations));
  assert.equal(auditQoderProfile(res.profileDir, base).ok, true);
  rmSync(root, { recursive: true, force: true });
});

test('round8 P1-e: dangling profile root link reports a symlink violation, not a misleading swap failure', async () => {
  const { base } = await realFsWrappers();
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'qoder-r8e-'));
  const authA = makeAuth(root, 'token-A');
  mkdirSync(join(root, 'qoder-profiles'), { recursive: true });
  symlinkSync(join(root, 'no-such-target'), join(root, 'qoder-profiles', 'c1'), 'dir');
  const res = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  assert.equal(res.audit.ok, false);
  assert.ok(
    res.audit.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(res.audit.violations),
  );
  assert.ok(
    res.audit.violations.every((v) => !/swap failed/.test(v)),
    'must not surface as swap failure',
  );
  rmSync(root, { recursive: true, force: true });
});

// P3-1：custody 先行、红即短路——外部字节不进 violation 文本
test('round8 P3-1: fingerprint symlink is reported as custody violation without echoing external bytes', async () => {
  const { base } = await realFsWrappers();
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'qoder-r8f-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  const external = mkdtempSync(join(tmpdir(), 'qoder-r8f-ext-'));
  writeFileSync(join(external, 'secret-marker'), 'EXTERNAL-SECRET-CONTENT-9f3a');
  rmSync(join(first.profileDir, '.account-fingerprint'));
  symlinkSync(join(external, 'secret-marker'), join(first.profileDir, '.account-fingerprint'));
  const a = auditQoderProfile(first.profileDir, base, 'deadbeefdeadbeef');
  assert.equal(a.ok, false);
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  assert.ok(
    a.violations.every((v) => !v.includes('EXTERNAL-SECRET')),
    'no external byte echo',
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

// ══ round-9（L2 生产实证：qodercn 在 profile 内建日志轮转软链 logs/latest -> runs/...）═══
// round-9 曾以 containment（解析后仍在 profile 内）放行全部非 plugins 内部软链；
// round-10 复审判过宽（见下方 round-10 组），收窄为正向窄 allowlist：仅
// logs/latest 且目标严格位于 logs/runs/ 下放行，其余回 round-7 fail-closed。
test('round9: provider log-rotation symlink INSIDE the profile must not fail the audit (L2 repro)', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-r9a-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  assert.equal(first.audit.ok, true, 'first invocation seeds green profile');
  // provider 首次运行后的真实产物形状（生产 20:32 实测）：
  const logsDir = join(first.profileDir, 'logs');
  mkdirSync(join(logsDir, 'runs', '2026-09-15T20-32-44-run1'), { recursive: true });
  writeFileSync(join(logsDir, 'runs', '2026-09-15T20-32-44-run1', 'events.jsonl'), '{}');
  symlinkSync('runs/2026-09-15T20-32-44-run1', join(logsDir, 'latest'), 'dir');
  // 第二次 invocation 前的洁净审计（生产 bug：symlink 误杀 → 每次调用被拒）
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, true, `internal rotation symlink must pass: ${JSON.stringify(a.violations)}`);
  rmSync(root, { recursive: true, force: true });
});

// round-10（CHANGES_REQUESTED）：containment 不是全局许可——这条原 round-9 绿测
// 断言的正是被否决的过宽语义（任意内部目录链放行），按新 allowlist 翻转为红。
test('round10: internal directory symlink outside the logs/latest allowlist is rejected', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-r10d-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  mkdirSync(join(first.profileDir, 'data-real'), { recursive: true });
  symlinkSync('data-real', join(first.profileDir, 'data-link'), 'dir');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false, 'only logs/latest is allowlisted; other internal links stay red');
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
});

test('round9: dangling internal symlink is still a violation (containment unprovable)', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-r9c-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  symlinkSync('no-such-target', join(first.profileDir, 'latest'), 'dir');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false);
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
});

test('round9: symlink escaping the profile is still rejected (round-7 boundary unchanged)', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-r9d-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  const external = mkdtempSync(join(tmpdir(), 'qoder-r9d-ext-'));
  symlinkSync(external, join(first.profileDir, 'escape-link'), 'dir');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false);
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

test('round9: plugins-subtree symlinks remain violations (L1 audit_auth attack surface)', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-r9e-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  mkdirSync(join(first.profileDir, 'plugins', 'real-dir'), { recursive: true });
  symlinkSync('real-dir', join(first.profileDir, 'plugins', 'link'), 'dir');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false, 'plugins symlinks stay red regardless of containment');
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
});

// ══ round-10（CHANGES_REQUESTED：containment ≠ 许可——三条 P1 内部软链绕过）═══
// 34cffef 以 inPlugins 为唯一例外放行所有非 plugins 内部软链，远宽于唯一 L2 证据
// （logs/latest -> runs/<ts>）。以下红测复现三条被击穿的安全语义，全部要求
// profile audit 红（fail-closed 回到 round-7，仅 logs/latest 窄 allowlist 除外）。
test('round10 P1-1: .auth internal symlink swapping accounts must fail the profile audit', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-r10a-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  assert.equal(first.audit.ok, true, 'first invocation seeds green profile');
  // 攻击（点点 DELTA-1）：根 .auth 整体替换为 profile 内链，指向 B 的凭证副本；
  // .account-fingerprint 仍是 A 的 marker 且匹配 expectedA——containment 成立、
  // marker 匹配，但 provider 透过链接实际读到 B 的凭证。
  const stolen = join(first.profileDir, 'auth-account-B');
  mkdirSync(stolen, { recursive: true });
  writeFileSync(join(stolen, 'user'), 'token-B');
  rmSync(join(first.profileDir, '.auth'), { recursive: true, force: true });
  symlinkSync('auth-account-B', join(first.profileDir, '.auth'), 'dir');
  // 攻击载荷就位：透过链接读到的已是 B 凭证（审计是唯一防线）
  assert.equal(readFileSync(join(first.profileDir, '.auth', 'user'), 'utf8'), 'token-B');
  const a = auditQoderProfile(first.profileDir, base, first.audit.accountFingerprint);
  assert.equal(a.ok, false, 'in-profile .auth swap must not pass with a matching fingerprint marker');
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
});

test('round10 P1-1b: .auth/user symlink to an in-profile file must fail the profile audit', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-r10f-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  assert.equal(first.audit.ok, true, 'first invocation seeds green profile');
  // 攻击（点点 DELTA-2）：.auth 保持真实目录，仅把 user 文件换成指向 profile 内
  // 另一文件的软链——marker 不变、containment 成立，但凭证路径 ≠ seed 路径，
  // 审计无法再证明"凭证路径 = seed 路径"。
  writeFileSync(join(first.profileDir, 'stolen-user'), 'token-B');
  rmSync(join(first.profileDir, '.auth', 'user'));
  symlinkSync(join(first.profileDir, 'stolen-user'), join(first.profileDir, '.auth', 'user'));
  assert.equal(readFileSync(join(first.profileDir, '.auth', 'user'), 'utf8'), 'token-B');
  const a = auditQoderProfile(first.profileDir, base, first.audit.accountFingerprint);
  assert.equal(a.ok, false, 'credentials path must stay the seeded real file, not an in-profile link');
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
});

test('round10 P1-2: root plugins symlink to an in-profile payload with an executable must fail', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-r10b-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  // 攻击：plugins -> payload（profile 内部）；symlink 分支 continue 后既不进入
  // plugins 语义也不扫目标，payload/evil.sh 以普通子树身份逃过 executable gate。
  const payload = join(first.profileDir, 'payload');
  mkdirSync(payload, { recursive: true });
  writeFileSync(join(payload, 'evil.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  symlinkSync('payload', join(first.profileDir, 'plugins'), 'dir');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false, 'plugins symlink must not dodge the plugin executable gate via containment');
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
});

test('round10 P1-3: projects slug internal symlink must not enable cross-cwd resume', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-r10c-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  assert.equal(first.audit.ok, true, 'first invocation seeds green profile');
  // 攻击：session 真实属于 cwdB（slugB）；projects/<slugA> -> <slugB> 内部 sibling
  // 链让 resume 审计的 existsSync/lstat 跟随链接命中——same-cwd 绑定失效。
  const qoderProjectSlug = profileModule.qoderProjectSlug;
  const auditQoderResumeSession = profileModule.auditQoderResumeSession;
  const slugA = qoderProjectSlug('/tmp/wksp-a');
  const slugB = qoderProjectSlug('/tmp/wksp-b');
  const sid = 'sess-12345678';
  mkdirSync(join(first.profileDir, 'projects', slugB), { recursive: true });
  writeFileSync(join(first.profileDir, 'projects', slugB, `${sid}.jsonl`), '{}');
  symlinkSync(slugB, join(first.profileDir, 'projects', slugA), 'dir');
  // resume 审计按契约（round-8 P3-2）不是 custody 检查，单看可能 ok——
  // same-cwd 绑定的守门人必须是 profile audit（invoke 顺序：先 profile 后 resume）。
  const resume = auditQoderResumeSession({
    profileDir: first.profileDir,
    sessionId: sid,
    workingDirectory: '/tmp/wksp-a',
    fs: base,
  });
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false, 'projects slug internal symlink must fail the profile audit');
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  assert.ok(!(a.ok && resume.ok), 'cross-cwd resume chain (profile audit && resume audit) must be broken');
  rmSync(root, { recursive: true, force: true });
});

// round-10 对照：allowlist 本身仍按 L2 证据放行 logs/latest，且要求真实目标严格
// 位于 canonical logs/runs/ 之下——指向 profile 内其它子树的 latest 同样红。
test('round10: logs/latest is allowed only when the real target is strictly under logs/runs', async () => {
  const { base } = await realFsWrappers();
  const root = mkdtempSync(join(tmpdir(), 'qoder-r10e-'));
  const authA = makeAuth(root, 'token-A');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: base });
  // 反例：latest 指向 profile 内非 runs 子树（containment 成立也不放行）
  mkdirSync(join(first.profileDir, 'logs'), { recursive: true });
  mkdirSync(join(first.profileDir, 'elsewhere'), { recursive: true });
  symlinkSync('../elsewhere', join(first.profileDir, 'logs', 'latest'), 'dir');
  const a = auditQoderProfile(first.profileDir, base);
  assert.equal(a.ok, false, 'logs/latest must resolve strictly under canonical logs/runs');
  assert.ok(
    a.violations.some((v) => /symlink/.test(v)),
    JSON.stringify(a.violations),
  );
  rmSync(root, { recursive: true, force: true });
});
