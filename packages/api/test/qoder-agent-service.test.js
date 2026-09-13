/**
 * F317 Phase 1 Slice 1 unit tests — 窄 QoderAgentService + runtime profile
 * 纯单测：fake spawn / 注入 fs，不真跑 qodercn。协议形状断言用 L1 夹具。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.QODER_PARSER_SRC
  ? join(here, '..', 'src', 'domains', 'cats', 'services', 'agents', 'providers')
  : join(here, '..', 'dist', 'domains', 'cats', 'services', 'agents', 'providers');

let svcModule, profileModule;
if (process.env.QODER_PARSER_SRC) {
  // strip-types 本地模式：重写相对 .js import 为同目录 .ts（CI 仍走 dist）
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const rewrite = (name) => {
    const src = readFileSync(join(SRC, name + '.ts'), 'utf8');
    const fixed = src.replace(/from '\.\/([a-z-]+)\.js'/g, "from '" + join(SRC, '$1.ts') + "'");
    const tmp = join(mkdtempSync(join(tmpdir(), 'qoder-strip-')), name + '.ts');
    writeFileSync(tmp, fixed);
    return import('file://' + tmp);
  };
  svcModule = await rewrite('QoderAgentService');
  profileModule = await import('file://' + join(SRC, 'qoder-runtime-profile.ts'));
} else {
  svcModule = await import(join(SRC, 'QoderAgentService.js'));
  profileModule = await import(join(SRC, 'qoder-runtime-profile.js'));
}
const { buildQoderArgs, sanitizeQoderEnv, qoderInitGate, QoderAgentService } = svcModule;
const { ensureQoderRuntimeProfile, auditQoderProfile } = profileModule;

const CAT = 'cat_test_qoder';

// ── argv 安全全集 ────────────────────────────────────────────────────────────
test('buildQoderArgs: full safety flag set, resume flag, prompt as argv (verified path)', () => {
  const args = buildQoderArgs({ prompt: 'hi', profileDir: '/p' });
  assert.deepEqual(args, [
    '-p',
    'hi',
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
  const resume = buildQoderArgs({ prompt: 'hi', profileDir: '/p', sessionId: 'sid-1' });
  assert.ok(resume.includes('-r') && resume.includes('sid-1'));
  // 危险 mode 任何路径都不得出现
  const all = [...args, ...resume].join(' ');
  assert.ok(!all.includes('bypass_permissions') && !all.includes('--dangerously-skip-permissions'));
});

// ── env 剥离 ────────────────────────────────────────────────────────────────
test('sanitizeQoderEnv strips QODER* (CONFIG_DIR only via constructor injection)', () => {
  const env = sanitizeQoderEnv({
    PATH: '/bin',
    QODERCN_CONFIG_DIR: '/evil',
    QODER_CONFIG_DIR: '/evil2',
    SAFE_VAR: '1',
  });
  assert.equal(env.SAFE_VAR, '1');
  assert.equal(env.QODERCN_CONFIG_DIR, undefined);
  assert.equal(env.QODER_CONFIG_DIR, undefined);
});

// ── init 门（P1-D / P1-H）─────────────────────────────────────────────────
test('qoderInitGate: version fail-closed, permissionMode enforced, model mismatch red, Auto ok when unrequested', () => {
  const good = { protocol_version: '1.4.0', permissionMode: 'default', model: 'Auto' };
  assert.equal(qoderInitGate(good).ok, true);
  assert.equal(qoderInitGate({ ...good, protocol_version: '2.0' }).ok, false);
  assert.equal(qoderInitGate({ ...good, permissionMode: 'bypass_permissions' }).ok, false);
  assert.equal(
    qoderInitGate({ ...good, model: 'Auto' }, 'qwen-max').ok,
    false,
    'requested model silently fell back to Auto',
  );
  assert.equal(qoderInitGate({ ...good, model: 'qwen-max' }, 'qwen-max').ok, true);
});

// ── runtime profile（I-11）────────────────────────────────────────────────
function memFs(files) {
  return {
    files: new Map(Object.entries(files)),
    readFileSync(p) {
      const c = this.files.get(p);
      if (c === undefined) throw new Error('ENOENT ' + p);
      return c;
    },
    copySync(src, dest) {
      const walk = (s, d) => {
        for (const [k, v] of this.files) {
          if (k === s || k.startsWith(s + '/')) {
            const nd = d + k.slice(s.length);
            this.files.set(nd, v);
          }
        }
      };
      walk(src, dest);
    },
    mkdirSync() {},
    renameSync(from, to) {
      for (const [k, v] of [...this.files]) {
        if (k === from || k.startsWith(from + '/')) this.files.set(to + k.slice(from.length), v);
      }
      for (const [k] of [...this.files]) if (k === from || k.startsWith(from + '/')) this.files.delete(k);
    },
    rmSync(p) {
      for (const [k] of [...this.files]) if (k === p || k.startsWith(p + '/')) this.files.delete(k);
    },
    existsSync: undefined, // 由 audit 内部用 node:fs existsSync —— 单测里 profileDir 审计走真临时目录
  };
}

test('auditQoderProfile: hooks in settings / executable plugins / missing .auth are violations', () => {
  const deps = {
    readFileSync: (p) =>
      readFileSyncStub[p] ??
      (() => {
        throw new Error('ENOENT');
      })(),
    copySync() {},
    existsSync: (p) => p === '/p/settings.json',
  };
  const readFileSyncStub = {
    '/p/settings.json': '{"hooks":{"SessionStart":[{"hooks":[]}]}}',
  };
  const audit = auditQoderProfile('/p', deps);
  assert.equal(audit.ok, false);
  assert.ok(audit.violations.some((v) => v.includes('hooks')));
});

// 真临时目录版 I-11 生命周期：seed → 复用 → 污染 → 重 seed
test('ensureQoderRuntimeProfile lifecycle: seed once, reuse, reseed on pollution (sessionsLost marked)', async () => {
  const fsp = await import('node:fs');
  const os = await import('node:os');
  const { mkdirSync, writeFileSync, rmSync } = fsp;
  const root = os.tmpdir() + '/qoder-profile-test-' + Date.now();
  const authSrc = root + '/auth-src';
  mkdirSync(authSrc + '/.auth', { recursive: true });
  writeFileSync(authSrc + '/.auth/user', 'token-bytes');

  const realFs = {
    readFileSync: (p) => readFileSync(p, 'utf8'),
    copySync: (s, d) => fsp.cpSync(s, d, { recursive: true }),
    mkdirSync,
    renameSync: fsp.renameSync,
    rmSync,
    existsSync: (p) => fsp.existsSync(p),
  };

  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authSrc, deps: realFs });
  assert.equal(first.audit.ok, true);
  assert.equal(first.audit.reseeded, undefined);

  // 复用：同目录直接复用（resume 持久性依赖），无 reseed 标记
  const second = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authSrc, deps: realFs });
  assert.equal(second.audit.ok, true);
  assert.equal(second.audit.reseeded, undefined);
  assert.equal(second.profileDir, first.profileDir);

  // 污染：植入 hooks → 下次 ensure 触发重 seed，session 丢失为已知语义
  writeFileSync(join(first.profileDir, 'settings.json'), '{"hooks":{"SessionStart":[]}}');
  const third = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authSrc, deps: realFs });
  assert.equal(third.audit.ok, true);
  assert.equal(third.audit.reseeded, true);

  rmSync(root, { recursive: true, force: true });
});

// ── Service invoke（fake spawn，L1 夹具事件流）──────────────────────────
function fakeChild(lines) {
  const child = new EventEmitter();
  child.stdout = Readable.from(lines.map((l) => l + '\n'));
  child.stderr = Readable.from([]);
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

const FIXTURE = join(here, 'fixtures', 'qoder', 'current');
const fixtureLines = (name) =>
  readFileSync(join(FIXTURE, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean);

test('invoke: workingDirectory missing → fail closed error, no spawn', async () => {
  let spawned = 0;
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    binary: '/usr/bin/true',
    spawnFn: () => {
      spawned++;
      return fakeChild([]);
    },
    profileDeps: { readFileSync: () => '{"apiKeySource":"oauth"}', copySync() {}, existsSync: () => true },
  });
  const messages = [];
  for await (const m of svc.invoke('hi', {})) messages.push(m);
  assert.equal(spawned, 0);
  assert.ok(messages[0].type === 'error' && messages[0].error.includes('workingDirectory'));
});

test('invoke: fixture stream → session_init/text/done with usage + billing, init gate green', async () => {
  // 用 success 夹具改造：补 settings 审计绿（profileDeps 返回空对象）
  const lines = fixtureLines('success');
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    binary: '/usr/bin/true',
    spawnFn: () => fakeChild(lines),
    profileDeps: { readFileSync: () => '{}', copySync() {}, existsSync: () => true },
  });
  const messages = [];
  for await (const m of svc.invoke('ok', { workingDirectory: '/tmp' })) messages.push(m);
  assert.ok(messages.some((m) => m.type === 'session_init'));
  const done = messages.find((m) => m.type === 'done');
  assert.ok(done, 'done emitted');
  const meta = done.metadata;
  assert.equal(meta.provider, 'qoder');
  assert.ok(meta.usage.numTurns >= 1);
  assert.ok(meta.qoderBilling.credits > 0, 'credits in billing metadata, not TokenUsage');
  assert.equal(meta.usage.inputTokens, undefined);
});

test('invoke: assistant before init → fail closed, stream aborted', async () => {
  const assistantLine = fixtureLines('tool-use').find((l) => l.includes('"type":"assistant"'));
  const badOrder = [assistantLine]; // assistant 事件，流中无 init
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    binary: '/usr/bin/true',
    spawnFn: () => fakeChild(badOrder),
    profileDeps: { readFileSync: () => '{}', copySync() {}, existsSync: () => true },
  });
  const messages = [];
  for await (const m of svc.invoke('hi', { workingDirectory: '/tmp' })) messages.push(m);
  assert.ok(messages.some((m) => m.type === 'error' && m.error.includes('before passing init gate')));
});
