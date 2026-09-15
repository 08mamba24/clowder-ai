/**
 * F317 Slice 2: QoderAgentService 的注册链工厂（syncAgentRegistry 唯一入口）。
 *
 * 点点 round-8 review 的 P2 硬验收（plan 修订日志 2026-09-15 已钉死）：
 * resolver 必须在 **Service 构造期** 经 `ensureQoderRuntimeProfile` 解析 profileDir，
 * 并对 `realpath(dataRoot)` 做 containment 断言——ensure 内部的 rootNodeViolations
 * 对 qoder-profiles 根与 profile 根做双侧 realpath containment。只缓存字符串、或
 * 只依赖每次 invocation 的 audit，都视为 fail-open，不得过验收。
 *
 * fail-closed 语义：model 缺失（P1-D：显式 model 是硬输入）或 ensure 审计红
 * （custody 违规 / auth source 不可读）→ 返回 null，调用方 `continue` 不注册——
 * 注册链不留半注册态。ensure 的 warnings（如 committed swap 的 backup 清理失败）
 * 如实上报但不阻断（新 profile 已生效）。
 */

import type { CatConfig, CatId } from '@cat-cafe/shared';
import { QoderAgentService } from './QoderAgentService.js';
import { ensureQoderRuntimeProfile, type QoderProfileFs } from './qoder-runtime-profile.js';

export interface QoderServiceFactoryInput {
  catId: CatId;
  config: CatConfig;
  /** runtime 数据根；runtime profile 落在 <dataRoot>/qoder-profiles/<catId>/ */
  dataRoot: string;
  /** accountRef 绑定的 OAuth auth source 目录（内含 .auth/）——由调用方经 catalog 解析 */
  authSourceDir: string;
  log?: { warn: (msg: string) => void };
  fs?: QoderProfileFs;
}

export function createQoderAgentService(input: QoderServiceFactoryInput): QoderAgentService | null {
  const { catId, config } = input;
  const warn = input.log?.warn?.bind(input.log) ?? (() => {});
  const model = config.defaultModel?.trim() ?? '';
  if (!model) {
    warn(
      `[qoder-factory] cat "${catId}" has no explicit defaultModel — P1-D requires an exact model. Cat not registered (fail closed).`,
    );
    return null;
  }
  // P2 硬验收：构造期 ensure（custody + seed/swap + realpath containment 断言）
  const resolved = ensureQoderRuntimeProfile({
    dataRoot: input.dataRoot,
    catId,
    authSourceDir: input.authSourceDir,
    ...(input.fs ? { fs: input.fs } : {}),
  });
  if (!resolved.audit.ok) {
    warn(
      `[qoder-factory] runtime profile audit failed for "${catId}": ${resolved.audit.violations.join('; ')}. Cat not registered (fail closed).`,
    );
    return null;
  }
  if (resolved.audit.warnings?.length) {
    warn(`[qoder-factory] runtime profile audit warnings for "${catId}": ${resolved.audit.warnings.join('; ')}`);
  }
  return new QoderAgentService({ catId, profileDir: resolved.profileDir, model });
}
