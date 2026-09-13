/**
 * F317 I-11: qoder runtime profile ownership / lifecycle
 *
 * L1 实证：qodercn 把 session 存在 config-dir 的 projects/<cwd-slug>/ 下，resume 要求
 * 同 config-dir + 同 cwd。因此生产不能逐 invocation 临时 clone（破坏 resume），也不能
 * 直接用用户个人 ~/.qoder-cn（越过 clean-profile 边界）。本模块实现提案 I-11 契约：
 * 归属（per-cat 持久目录，runtime 拥有）、原子 seed、每次 invocation 前洁净审计、
 * 损坏重 seed（session 丢失为已知代价）。
 */

import { existsSync as existsSyncDefault, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 审计结果：ok 或违规明细（fail-closed，调用方拒发 invocation） */
export interface QoderProfileAudit {
  ok: boolean;
  violations: string[];
  /** 重 seed 后 session 丢失（I-11 已知语义，调用方记录日志） */
  reseeded?: boolean;
}

/** profile 目录内被禁止的可执行/脚本形态（L1 collector audit_auth 语义移植） */
function findExecutableArtifacts(profileDir: string): string[] {
  const offenders: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'plugins') {
          for (const bad of findExecutableArtifacts(p)) offenders.push(bad);
        } else {
          walk(p, depth + 1);
        }
      } else if (
        /\.(sh|js|mjs|cjs|py)$/.test(entry.name) ||
        (entry.isFile() &&
          (() => {
            try {
              return (statSync(p).mode & 0o111) !== 0;
            } catch {
              return false;
            }
          })())
      ) {
        offenders.push(p);
      }
    }
  };
  walk(profileDir, 0);
  return offenders;
}

/** settings*.json 中出现非空 hooks 键即违规（SessionStart hook = 任意命令执行入口） */
function settingsHooksViolations(
  profileDir: string,
  readFileSync: (p: string) => string,
  existsSync: (p: string) => boolean,
): string[] {
  const violations: string[] = [];
  for (const name of ['settings.json', 'settings.local.json'] as const) {
    const p = join(profileDir, name);
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p)) as Record<string, unknown>;
      if (parsed.hooks) violations.push(`${name}: non-empty hooks key`);
    } catch {
      violations.push(`${name}: unparseable`);
    }
  }
  return violations;
}

export interface QoderProfileDeps {
  readFileSync: (p: string) => string;
  copySync: (src: string, dest: string) => void;
  /** 存在性探测（默认 node:fs；测试注入内存映射） */
  existsSync: (p: string) => boolean;
}

/**
 * 审计已有 profile：.auth 存在、无 settings hooks、无 plugins 可执行物。
 * 纯函数（fs 依赖注入），调用方在每次 invocation 前执行，红即拒发。
 */
export function auditQoderProfile(profileDir: string, deps: QoderProfileDeps): QoderProfileAudit {
  const violations: string[] = [];
  const existsSync = deps.existsSync ?? (existsSync as (p: string) => boolean);
  if (!existsSync(join(profileDir, '.auth'))) violations.push('missing .auth');
  violations.push(...settingsHooksViolations(profileDir, deps.readFileSync, existsSync));
  violations.push(...findExecutableArtifacts(profileDir).map((p) => `executable artifact: ${p}`));
  return { ok: violations.length === 0, violations };
}

/**
 * 原子 seed：从 accountRef 绑定的 auth source（只含 .auth）构建临时目录后 rename。
 * 已存在且审计绿则复用（resume 依赖持久性）；审计红则重 seed 并标记 sessionsLost。
 */
export function ensureQoderRuntimeProfile(input: {
  dataRoot: string;
  catId: string;
  authSourceDir: string;
  deps: QoderProfileDeps & { mkdirSync: typeof mkdirSync; renameSync: typeof renameSync; rmSync: typeof rmSync };
}): { profileDir: string; audit: QoderProfileAudit } {
  const { dataRoot, catId, authSourceDir, deps } = input;
  const profileDir = join(dataRoot, 'qoder-profiles', catId);
  const existsSync = deps.existsSync ?? existsSyncDefault;
  if (existsSync(profileDir)) {
    const audit = auditQoderProfile(profileDir, deps);
    if (audit.ok) return { profileDir, audit };
    // I-11 恢复路径：损坏/污染 → 重 seed；profile 内 session 丢失为已知语义
    deps.rmSync(profileDir, { recursive: true, force: true });
    const seeded = seedAtomic(profileDir, authSourceDir, deps);
    return { profileDir, audit: { ...seeded, reseeded: true } };
  }
  return { profileDir, audit: seedAtomic(profileDir, authSourceDir, deps) };
}

function seedAtomic(
  profileDir: string,
  authSourceDir: string,
  deps: QoderProfileDeps & { mkdirSync: typeof mkdirSync; renameSync: typeof renameSync; rmSync: typeof rmSync },
): QoderProfileAudit {
  const staging = `${profileDir}.seed-${process.pid}-${Date.now()}`;
  deps.mkdirSync(staging, { recursive: true });
  try {
    deps.copySync(join(authSourceDir, '.auth'), join(staging, '.auth'));
    deps.mkdirSync(join(profileDir, '..'), { recursive: true });
    deps.renameSync(staging, profileDir);
  } catch (err) {
    deps.rmSync(staging, { recursive: true, force: true });
    return { ok: false, violations: [`seed failed: ${String(err)}`] };
  }
  return { ok: true, violations: [] };
}
