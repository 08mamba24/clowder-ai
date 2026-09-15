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
import { EventEmitter } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, '..', 'dist', 'domains', 'cats', 'services', 'agents', 'providers');
const SRC = join(here, '..', 'src', 'domains', 'cats', 'services', 'agents', 'providers');

const svcModule = await import(join(DIST, 'QoderAgentService.js'));
const profileModule = await import(join(SRC, 'qoder-runtime-profile.ts'));
const { buildQoderArgs, qoderInitGate, QoderAgentService } = svcModule;
const { ensureQoderRuntimeProfile, auditQoderProfile, isSafeCatIdSegment } = profileModule;
const FIXTURE = join(here, 'fixtures', 'qoder');
const fixtureLines = (name) =>
  readFileSync(join(FIXTURE, 'current', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean);

const CAT = 'cat_test_qoder';

// ── argv：prompt 走 stdin，安全 flag 全集 ───────────────────────────────────
test('buildQoderArgs: stdin prompt channel, no prompt text in argv, full safety set', () => {
  const args = buildQoderArgs({ profileDir: '/p', model: 'qwen-max' });
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
  const resume = buildQoderArgs({ profileDir: '/p', model: 'qwen-max', sessionId: 'sid-1' });
  assert.ok(resume.includes('-r') && resume.includes('sid-1'));
  assert.ok(!args.join(' ').includes('bypass_permissions'));
});

test('argv carries explicit -m model (round-2 P1-1: model is a typed input, actually sent)', () => {
  const args = buildQoderArgs({ profileDir: '/p', model: 'qwen-max' });
  const i = args.indexOf('-m');
  assert.ok(i > 0 && args[i + 1] === 'qwen-max');
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
        const isDir = false;
        return { isFile: () => !isDir, isSymbolicLink: () => false, mode: 0o644 };
      }
      if ([...files.keys()].some((k) => k.startsWith(norm(p) + '/'))) {
        return { isFile: () => false, isSymbolicLink: () => false, mode: 0o755 };
      }
      throw new Error('symlink-or-missing (memfs treats unknown as symlink case)');
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
    ...overrides,
  });
}

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
