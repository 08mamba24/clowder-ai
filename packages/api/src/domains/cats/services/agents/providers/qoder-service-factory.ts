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

import { join } from 'node:path';
import type { CatConfig, CatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { qoderDurableConfigRoot, resolveQoderAuthSourceDir } from '../../../../../config/qoder-auth-source.js';
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
  /**
   * 有效 model 解析（测试注入）。默认 getCatModel(catId)——与 Kimi/OpenCode 同源，
   * 尊重 CAT_<ID>_MODEL env override > config > fallback（round-2 review P2-2：
   * 构造期直接读 config.defaultModel 会忽略 env override）。
   */
  modelResolver?: (catId: CatId) => string | undefined;
  /** Runtime binary root; defaults to CAT_CAFE_RUNTIME_ROOT, then process.cwd(). */
  binaryRoot?: string;
  /** Test seam for the split readonly memory MCP entrypoint. */
  memoryMcpServerPath?: string;
  /** Test seam for the runtime-owned Qoder shell-prefix sandbox wrapper. */
  shellSandboxWrapperPath?: string;
  /** Test seam for macOS Seatbelt. */
  sandboxBinary?: string;
}

export function createQoderAgentService(input: QoderServiceFactoryInput): QoderAgentService | null {
  const { catId, config } = input;
  const warn = input.log?.warn?.bind(input.log) ?? (() => {});
  void config;
  const model = (input.modelResolver?.(catId) ?? getCatModel(catId))?.trim() ?? '';
  if (!model) {
    warn(
      `[qoder-factory] cat "${catId}" has no effective model (CAT_${String(catId).toUpperCase()}_MODEL / config) — P1-D requires an exact model. Cat not registered (fail closed).`,
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
  const binaryRoot = input.binaryRoot ?? (process.env.CAT_CAFE_RUNTIME_ROOT?.trim() || process.cwd());
  const memoryMcpServerPath =
    input.memoryMcpServerPath ?? join(binaryRoot, 'packages', 'mcp-server', 'dist', 'memory.js');
  const shellSandboxWrapperPath =
    input.shellSandboxWrapperPath ?? join(binaryRoot, 'scripts', 'qoder-shell-sandbox.mjs');
  return new QoderAgentService({
    catId,
    profileDir: resolved.profileDir,
    model,
    toolAccess: 'controlled',
    memoryMcpServerPath,
    shellSandboxWrapperPath,
    ...(input.sandboxBinary ? { sandboxBinary: input.sandboxBinary } : {}),
  });
}

/**
 * round-4 P2（砚砚 review）：注册链接线的可测单一真相——index.ts 的 case 'qoder'
 * 只做薄调用，auth-source 解析 + durable dataRoot + 工厂全部在这里。分离拓扑 E2E
 * 直接消费本函数，防"测试测 resolver、生产却改 dataRoot"的错位回归。
 */
export interface RegisterQoderAgentServiceInput {
  catId: CatId;
  config: CatConfig;
  /** 注册链的 runtime project root（生产 = resolveActiveProjectRoot(process.cwd())） */
  projectRoot: string;
  /** 生产 = resolveBoundAccountRefForCat(projectRoot, catId, config) */
  accountRef?: string;
  log?: { warn: (msg: string) => void };
  fs?: QoderProfileFs;
  modelResolver?: (catId: CatId) => string | undefined;
  memoryMcpServerPath?: string;
  shellSandboxWrapperPath?: string;
  sandboxBinary?: string;
}

export type RegisterQoderAgentServiceResult = { ok: true; service: QoderAgentService } | { ok: false; reason: string };

export function registerQoderAgentService(input: RegisterQoderAgentServiceInput): RegisterQoderAgentServiceResult {
  const warn = input.log?.warn?.bind(input.log) ?? (() => {});
  const auth = resolveQoderAuthSourceDir({ projectRoot: input.projectRoot, accountRef: input.accountRef });
  if (!auth.ok) return { ok: false, reason: auth.reason };
  let dataRoot: string;
  try {
    // 与 auth 同拓扑：runtime-worktree 模式下 profiles 落持久 workspace
    dataRoot = join(qoderDurableConfigRoot(input.projectRoot), '.cat-cafe');
  } catch (err) {
    return { ok: false, reason: `qoder durable root unresolvable: ${String(err)}` };
  }
  const service = createQoderAgentService({
    catId: input.catId,
    config: input.config,
    dataRoot,
    authSourceDir: auth.authSourceDir,
    log: { warn },
    binaryRoot: process.env.CAT_CAFE_RUNTIME_ROOT?.trim() || input.projectRoot,
    ...(input.memoryMcpServerPath ? { memoryMcpServerPath: input.memoryMcpServerPath } : {}),
    ...(input.shellSandboxWrapperPath ? { shellSandboxWrapperPath: input.shellSandboxWrapperPath } : {}),
    ...(input.sandboxBinary ? { sandboxBinary: input.sandboxBinary } : {}),
    ...(input.fs ? { fs: input.fs } : {}),
    ...(input.modelResolver ? { modelResolver: input.modelResolver } : {}),
  });
  if (!service) return { ok: false, reason: 'factory rejected the member (see warnings: model or profile audit)' };
  return { ok: true, service };
}
