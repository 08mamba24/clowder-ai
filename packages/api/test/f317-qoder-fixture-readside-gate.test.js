/**
 * F317 夹具门（read-side 机械闸）：把 MANIFEST.md 的人工契约变成可执行门。
 *
 * 契约（packages/api/test/fixtures/qoder/MANIFEST.md）：
 * - `current/` 是唯一活跃 generation 指针，读方一律经 `verify.py` fail-closed 校验
 * - generation 与 `collect.sh` 指纹绑定（collector 变了，旧 generation 不再自洽）
 * - 仓库固定并跟踪经复核的 `.gen-<hash>/` 与 `current`；collector 的新代默认被 .gitignore
 *   隔离，只有复核后才连同 `current` 一起显式 force-add
 *
 * 本文件只把这两条变成实测门，不复制 verify.py 的 manifest/哈希逻辑
 * （单一真相源 = verify.py 本身，Node 侧只负责调用与断言）：
 * 1. verify.py 必须真的通过 —— 否则 qoder-ndjson-parser.test.js 读到的 current/ 并非已验证的一代
 * 2. 被消费的一代必须已被 git 跟踪 —— 未 force-add 的本地采集（悬空 current / 半个 generation）
 *    在推送前就变红，而不是靠人记得
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures', 'qoder');
const VERIFY = join(FIXTURES, 'verify.py');

const gitAt = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const REPO_ROOT = gitAt(FIXTURES, 'rev-parse', '--show-toplevel').trim();
// pathspec 相对 cwd 解析：一律在仓库根执行 + 传仓库根相对路径，
// 否则路径匹配不到任何文件，断言会静默空通过（vacuous green）。
const git = (...args) => gitAt(REPO_ROOT, ...args);
const rel = (p) => relative(REPO_ROOT, p);

const isTracked = (p) => {
  try {
    git('ls-files', '--error-unmatch', '--', rel(p));
    return true;
  } catch {
    return false;
  }
};

// verify.py 的诊断必须原样上抛：红的时候要能直接看出是哪条契约破了
const runVerify = () => {
  try {
    return execFileSync('python3', [VERIFY, FIXTURES], { cwd: FIXTURES, encoding: 'utf8' });
  } catch (err) {
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    throw new Error(
      `verify.py 未通过（夹具门 fail-closed）：${stderr || err.message}\n` +
        'generation 与 collect.sh 指纹绑定：若有意修改 collect.sh，必须重采集并复核后 force-add 新 generation。',
    );
  }
};

test('verify.py 通过：current/ 是 fail-closed 校验过的一代', () => {
  const out = runVerify();
  assert.match(out, /^verified generation \.gen-[0-9a-f]{12}: /);
});

test('被消费的 generation 已 force-add：current 目标与其全部文件都在 git 索引内', () => {
  const target = readlinkSync(join(FIXTURES, 'current'));
  assert.match(target, /^\.gen-[0-9a-f]{12}$/, `current 目标不是规范 generation 名: ${target}`);
  const genDir = join(FIXTURES, target);

  assert.ok(isTracked(join(FIXTURES, 'current')), 'current symlink 未跟踪：干净 checkout 会失去活跃代指针');

  const untracked = readdirSync(genDir)
    .map((f) => join(genDir, f))
    .filter((f) => !isTracked(f));
  assert.deepEqual(
    untracked.map(rel),
    [],
    '被消费的 generation 含未跟踪文件：force-add 漏了 .gen-* 目录，干净 checkout / CI 会读到不存在的夹具',
  );
});

test('夹具目录无未提交改动：本地重采集不得冒充仓库夹具', () => {
  const dirty = git('status', '--porcelain', '--', rel(FIXTURES)).trim();
  assert.equal(
    dirty,
    '',
    `夹具目录有未提交改动，读方会消费到未复核的一代：\n${dirty}\n` +
      '若是有意重采集：复核后连同 current 一起 force-add；否则先丢弃本地代。',
  );
});
