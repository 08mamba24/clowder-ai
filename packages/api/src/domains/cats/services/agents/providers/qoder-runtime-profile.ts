/**
 * F317 I-11: qoder runtime profile ownership / lifecycle
 *
 * L1 实证：qodercn 把 session 存在 config-dir 的 projects/<cwd-slug>/ 下，resume 要求
 * 同 config-dir + 同 cwd。生产不能逐 invocation 临时 clone（破坏 resume），也不能直接
 * 用用户个人 ~/.qoder-cn（越过 clean-profile 边界）。本模块实现提案 I-11 契约：
 * 归属（per-cat 持久目录，runtime 拥有）、原子 seed/swap、每次 invocation 前洁净审计、
 * 损坏或换绑时的原子替换（失败保留旧 profile）、account custody（fingerprint 绑定）。
 *
 * Slice 1 review 修正（砚砚 8xP1）：
 * - catId 单段安全字符 + resolve containment（杜绝 ../ 逃逸递归删除）
 * - 审计 fs 依赖全量可注入（测试与生产同一语义文件系统面）
 * - 换绑账号：fingerprint marker 不匹配 → 原子换绑（绝不沿用旧凭证）
 * - swap：stage 新副本审计绿后才替换；失败保留旧 profile（backup 回滚）
 *
 * Round-3 修正（砚砚 P1⑤/P1⑥）：
 * - swap 回滚/清理失败如实返回：不谎称 rolled back/cleaned，含凭证遗留点名路径；
 *   swap 已提交后 backup 清理失败进 warnings（ok 不翻转——新 profile 已生效）
 * - auditQoderResumeSession：resume 前 session 必须存在于本 profile projects/ 下
 *
 * Round-4 修正（PR #24 review，砚砚 2×P1）：
 * - P1-1 审计攻击面收窄到 plugins/ 子树（L1 audit_auth 语义，collect.sh:77）——
 *   provider 正常初始化的 security-resources/ 自带脚本不再误杀（否则首次初始化后
 *   每次调用被拒 + reseed 丢 session）
 * - P1-3 resume 审计按 qodercn canonical slug（qoderProjectSlug，provider 源码提取）
 *   精确定位 projects/<slug(cwd)>/<sessionId>.jsonl —— 跨 cwd 不再误放行
 *
 * Round-5 修正（PR #24 round-4 review，砚砚 P1）：
 * - 顶节 custody 与 artifact 扫描面分离：`.auth` / `plugins/` 根节点 lstat
 *   fail-closed（symlink / 非真实目录 / 不可 stat 一律 violation）——修复 round-4
 *   收窄时误删的 symlink custody（.auth→外部目录曾判绿，违反 I-11 §1）
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync as fsExistsSync,
  lstatSync as fsLstatSync,
  mkdirSync as fsMkdirSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  renameSync as fsRenameSync,
  rmSync as fsRmSync,
  statSync as fsStatSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

export interface QoderProfileFs {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string, opts: { withFileTypes: true }) => import('node:fs').Dirent[];
  lstatSync: (p: string) => { isFile(): boolean; isSymbolicLink(): boolean; mode: number };
  readFileSync: (p: string) => string;
  writeFileSync: (p: string, data: string) => void;
  copySync: (src: string, dest: string) => void;
  mkdirSync: (p: string, opts: { recursive: true }) => void;
  renameSync: (from: string, to: string) => void;
  rmSync: (p: string, opts: { recursive: true; force: true }) => void;
}

export function defaultQoderProfileFs(): QoderProfileFs {
  return {
    existsSync: fsExistsSync,
    readdirSync: (p, opts) => fsReaddirSync(p, opts),
    lstatSync: (p) => fsLstatSync(p),
    readFileSync: (p) => fsReadFileSync(p, 'utf8'),
    writeFileSync: (p, d) => fsWriteFileSync(p, d),
    copySync: (s, d) => cpSync(s, d, { recursive: true }),
    mkdirSync: (p, o) => fsMkdirSync(p, o),
    renameSync: fsRenameSync,
    rmSync: fsRmSync,
  };
}

/** 审计结果：ok 或违规明细（fail-closed，调用方拒发 invocation） */
export interface QoderProfileAudit {
  ok: boolean;
  violations: string[];
  /** 触发了原子替换（损坏或换绑）；session 丢失为 I-11 已知语义 */
  swapped?: 'reseed-pollution' | 'rebind-account';
  /** account fingerprint（.auth/user 内容 sha256 前 16 位） */
  accountFingerprint?: string;
  /**
   * round-3 P1⑤：swap 已提交（新 profile 已生效、审计绿）但收尾清理失败。
   * 不影响 ok —— 但可能含旧凭证的遗留目录必须被点名，不允许被静默吞掉。
   */
  warnings?: string[];
}

/**
 * L1 audit_auth 攻击面（真相源 collect.sh:77：`find "$d/plugins" -type f ...`）：
 * 可执行/脚本/symlink 审计只针对 **plugins/ 子树**。provider 正常初始化会在
 * security-resources/ 等处生成自带脚本（实测本机
 * `.qoder-cn/security-resources/security-scan/bin/qodersec-launch.sh`）——那是
 * provider-owned 产物，不属于审计面；全根递归会误杀首次初始化后的每次调用
 * （PR #24 review P1-1：resume 被拒 + reseed 丢 session）。
 * plugins/ 内部遍历无深度上限；审计面内不可读/不可 stat 一律 violation（fail-closed）。
 */
function findExecutableArtifacts(profileDir: string, fs: QoderProfileFs): string[] {
  const offenders: string[] = [];
  const pluginsDir = join(profileDir, 'plugins');
  if (!fs.existsSync(pluginsDir)) return offenders;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      offenders.push(`unreadable dir ${dir}: ${String(err)}`);
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      try {
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) {
          offenders.push(`symlink: ${p}`);
          continue;
        }
        if (st.isFile()) {
          if (/\.(sh|js|mjs|cjs|py)$/.test(entry.name) || (st.mode & 0o111) !== 0) {
            offenders.push(`executable artifact: ${p}`);
          }
        } else {
          walk(p);
        }
      } catch (err) {
        offenders.push(`unstatable ${p}: ${String(err)}`);
      }
    }
  };
  walk(pluginsDir);
  return offenders;
}

/**
 * Round-5 P1（PR #24 round-4 review）：路径 custody 与 artifact 扫描面分离。
 * I-11 §1：profile 由 runtime 拥有、用户个人目录不可达——`.auth` 与 `plugins/`
 * 根节点必须是不经符号链接的真实目录。round-4 收窄扫描面时不得顺手删掉这层
 * custody（`.auth -> 外部目录` / `plugins -> 外部目录` 曾双双判绿）。
 * lstat fail-closed：不可 stat / symlink / 非目录一律 violation。
 */
function custodyViolations(profileDir: string, fs: QoderProfileFs): string[] {
  const violations: string[] = [];
  const nodes: readonly [label: string, path: string][] = [
    ['.auth', join(profileDir, '.auth')],
    ['plugins', join(profileDir, 'plugins')],
  ];
  for (const [label, p] of nodes) {
    if (!fs.existsSync(p)) continue; // 缺失由既有检查负责（.auth）/ 合法（plugins 可不存在）
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (err) {
      violations.push(`unstatable ${label}: ${p}: ${String(err)}`);
      continue;
    }
    if (st.isSymbolicLink()) {
      violations.push(`symlink at profile root: ${p}`);
      continue;
    }
    if (st.isFile()) {
      violations.push(`${label} is a regular file, expected a real directory: ${p}`);
    }
  }
  return violations;
}

/** settings*.json 出现非空 hooks 键即违规（hooks:{} 视为空，不算违规） */
function settingsHooksViolations(profileDir: string, fs: QoderProfileFs): string[] {
  const violations: string[] = [];
  for (const name of ['settings.json', 'settings.local.json'] as const) {
    const p = join(profileDir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(p)) as Record<string, unknown>;
      const hooks = parsed.hooks;
      if (hooks != null && typeof hooks === 'object' && Object.keys(hooks as object).length > 0) {
        violations.push(`${name}: non-empty hooks key`);
      }
    } catch {
      violations.push(`${name}: unparseable`);
    }
  }
  return violations;
}

/** catId 必须是单段安全字符（字母/数字/-/_），从根上杜绝路径逃逸 */
export function isSafeCatIdSegment(catId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(catId);
}

/** resume sessionId 的有界字符集（collect.sh 同款校验：杜绝路径分量注入搜索） */
const SAFE_SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * qodercn canonical project slug —— 从 provider 运行时源码提取（PR #24 review P1-3），
 * 不是猜测。`MI(cwd)`：cwd 每个非 [a-zA-Z0-9] 字符替换为 '-'；结果 >200 字符时
 * 截断到 200 并追加 '-' + |djb2-xor(cwd)| 的 base36。provider 用同一函数定位
 * `projects/<slug>/` 下的 session 文件。
 */
export function qoderProjectSlug(cwd: string): string {
  const dashed = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (dashed.length <= 200) return dashed;
  // 与 provider 字节等价：`A = A * 33 ^ charCodeAt`（JS float 乘法 + ^ 的 ToInt32 截断）
  let hash = 5381;
  for (let i = 0; i < cwd.length; i++) hash = (hash * 33) ^ cwd.charCodeAt(i);
  return `${dashed.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/**
 * round-3 P1⑥ / round-4 P1-3：provider 初始化后的二次 resume 审计。
 * L1 实证（collect.sh/提案 I-11）：qodercn 把 session 存在 config-dir 的
 * `projects/<qoderProjectSlug(cwd)>/<sessionId>.jsonl`，resume 要求同 config-dir
 * + 同 cwd。审计按 **canonical 项目目录精确路径**检查（不是整个 projects/ 子树
 * 按文件名模糊匹配——那只能证明同 profile，跨 cwd 会误放行）；路径必须是常规文件
 * （symlink/目录/不可 stat 一律拒绝）。
 */
export function auditQoderResumeSession(input: {
  profileDir: string;
  sessionId: string;
  /** 本次 invocation 的 spawn cwd（必须与 provider 计算 slug 的输入是同一字符串） */
  workingDirectory: string;
  fs: QoderProfileFs;
}): { ok: true } | { ok: false; reason: string } {
  if (!SAFE_SESSION_ID.test(input.sessionId)) {
    return { ok: false, reason: `unsafe session id charset: ${JSON.stringify(input.sessionId.slice(0, 16))}` };
  }
  const sessionFile = join(
    input.profileDir,
    'projects',
    qoderProjectSlug(input.workingDirectory),
    `${input.sessionId}.jsonl`,
  );
  if (!input.fs.existsSync(sessionFile)) {
    return {
      ok: false,
      reason: `resume session ${input.sessionId} not found at canonical project path ${sessionFile} (I-11: resume requires same config-dir + same cwd; cross-profile/cross-cwd resume rejected)`,
    };
  }
  try {
    if (!input.fs.lstatSync(sessionFile).isFile()) {
      return { ok: false, reason: `resume session path is not a regular file: ${sessionFile}` };
    }
  } catch (err) {
    return { ok: false, reason: `resume session path unstatable: ${String(err)}` };
  }
  return { ok: true };
}

/** resolve containment：target 必须严格位于 parent 内（或等于） */
function assertContained(parent: string, target: string, label: string): void {
  const rp = resolve(parent);
  const rt = resolve(target);
  if (rt !== rp && !rt.startsWith(rp + sep)) {
    throw new Error(`profile path escapes ${label}: ${target}`);
  }
}

export function computeAccountFingerprint(authSourceDir: string, fs: QoderProfileFs): string | null {
  try {
    const bytes = fs.readFileSync(join(authSourceDir, '.auth', 'user'));
    return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/** 审计：.auth 在、fingerprint marker 在且匹配、无 settings hooks、无深层可执行物/symlink */
export function auditQoderProfile(
  profileDir: string,
  fs: QoderProfileFs,
  expectedAccountFingerprint?: string,
): QoderProfileAudit {
  const violations: string[] = [];
  if (!fs.existsSync(join(profileDir, '.auth'))) violations.push('missing .auth');
  let fingerprint: string | undefined;
  if (fs.existsSync(join(profileDir, '.account-fingerprint'))) {
    try {
      fingerprint = fs.readFileSync(join(profileDir, '.account-fingerprint')).trim();
    } catch {
      violations.push('unreadable .account-fingerprint');
    }
    if (expectedAccountFingerprint && fingerprint !== expectedAccountFingerprint) {
      violations.push(`account fingerprint mismatch (profile=${fingerprint} expected=${expectedAccountFingerprint})`);
    }
  } else {
    violations.push('missing .account-fingerprint');
  }
  violations.push(...custodyViolations(profileDir, fs));
  violations.push(...settingsHooksViolations(profileDir, fs));
  violations.push(...findExecutableArtifacts(profileDir, fs));
  return { ok: violations.length === 0, violations, accountFingerprint: fingerprint };
}

/** 原子替换：stage(seed+fingerprint) → 审计 staging 绿 → swap（旧→backup→回滚保护）
 *  round-3 P1⑤：回滚/清理的每一步成败都如实进入返回值——swap 失败不谎称 "rolled back"，
 *  清理失败点名含凭证的遗留目录；swap 已提交后 backup 清理失败不翻转 ok，进 warnings。 */
function atomicSwap(input: {
  profileDir: string;
  authSourceDir: string;
  fs: QoderProfileFs;
  swapReason: 'reseed-pollution' | 'rebind-account';
}): QoderProfileAudit {
  const { profileDir, authSourceDir, fs, swapReason } = input;
  const staging = `${profileDir}.staging-${process.pid}-${Date.now()}`;
  const backup = `${profileDir}.old-${process.pid}-${Date.now()}`;
  /** 收尾失败如实上报（可能含凭证遗留，必须点名路径） */
  const late: string[] = [];
  const tryCleanStaging = (): void => {
    try {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    } catch (err) {
      late.push(`staging cleanup FAILED — new credentials may remain: ${staging}: ${String(err)}`);
    }
  };
  try {
    fs.mkdirSync(staging, { recursive: true });
    fs.copySync(join(authSourceDir, '.auth'), join(staging, '.auth'));
    const fingerprint = computeAccountFingerprint(authSourceDir, fs);
    if (!fingerprint) {
      tryCleanStaging();
      return { ok: false, violations: ['auth source unreadable', ...late] };
    }
    fs.writeFileSync(join(staging, '.account-fingerprint'), fingerprint);
    const stagingAudit = auditQoderProfile(staging, fs, fingerprint);
    if (!stagingAudit.ok) {
      tryCleanStaging();
      return { ok: false, violations: [`staging audit failed: ${stagingAudit.violations.join('; ')}`, ...late] };
    }
    if (fs.existsSync(profileDir)) fs.renameSync(profileDir, backup);
    try {
      fs.renameSync(staging, profileDir);
    } catch (err) {
      // 回滚 + 清 staging：每一步成败如实上报（round-3 P1⑤：不谎称 rolled back/cleaned）
      let rollback: 'restored' | 'not-needed' | 'failed' = 'not-needed';
      if (fs.existsSync(backup)) {
        rollback = 'failed';
        try {
          fs.renameSync(backup, profileDir);
          rollback = 'restored';
        } catch (rbErr) {
          late.push(`rollback FAILED — previous profile NOT restored: ${String(rbErr)}`);
        }
      }
      tryCleanStaging();
      return { ok: false, violations: [`swap failed: ${String(err)} (rollback: ${rollback})`, ...late] };
    }
    // swap 已提交：新 profile 已生效。backup 清理失败不翻转真相（ok 仍 true），进 warnings
    const warnings: string[] = [];
    if (fs.existsSync(backup)) {
      try {
        fs.rmSync(backup, { recursive: true, force: true });
      } catch (err) {
        warnings.push(`backup cleanup failed — OLD credentials remain at ${backup}: ${String(err)}`);
      }
    }
    return {
      ok: true,
      violations: [],
      swapped: swapReason,
      accountFingerprint: fingerprint,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (err) {
    for (const leftover of [staging, backup]) {
      try {
        if (fs.existsSync(leftover)) fs.rmSync(leftover, { recursive: true, force: true });
      } catch (cleanErr) {
        late.push(`cleanup FAILED — ${leftover}: ${String(cleanErr)}`);
      }
    }
    return { ok: false, violations: [`swap aborted: ${String(err)}`, ...late] };
  }
}

/**
 * ensure：catId 安全段 + containment 校验后——
 * 不存在 → 原子 seed；存在且审计绿 → 复用；污染/换绑 → 原子替换（失败保留旧 profile）
 */
export function ensureQoderRuntimeProfile(input: {
  dataRoot: string;
  catId: string;
  authSourceDir: string;
  fs?: QoderProfileFs;
}): { profileDir: string; audit: QoderProfileAudit } {
  const fs = input.fs ?? defaultQoderProfileFs();
  if (!isSafeCatIdSegment(input.catId)) {
    throw new Error(`unsafe catId segment: ${JSON.stringify(input.catId)}`);
  }
  const base = join(input.dataRoot, 'qoder-profiles');
  const profileDir = join(base, input.catId);
  assertContained(base, profileDir, 'qoder-profiles root');
  const fingerprint = computeAccountFingerprint(input.authSourceDir, fs);
  if (!fingerprint) return { profileDir, audit: { ok: false, violations: ['auth source unreadable'] } };

  if (fs.existsSync(profileDir)) {
    const audit = auditQoderProfile(profileDir, fs, fingerprint);
    if (audit.ok) return { profileDir, audit };
    const isRebind = audit.violations.some((v) => v.includes('fingerprint mismatch'));
    return {
      profileDir,
      audit: atomicSwap({
        profileDir,
        authSourceDir: input.authSourceDir,
        fs,
        swapReason: isRebind ? 'rebind-account' : 'reseed-pollution',
      }),
    };
  }
  fs.mkdirSync(base, { recursive: true });
  return {
    profileDir,
    audit: atomicSwap({ profileDir, authSourceDir: input.authSourceDir, fs, swapReason: 'reseed-pollution' }),
  };
}
