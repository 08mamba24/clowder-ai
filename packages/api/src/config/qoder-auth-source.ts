/**
 * F317 Slice 2 round-2（砚砚 review P1）：类型化 account→auth-source resolver。
 *
 * 旧实现的违规点：把原始 accountRef 直接拼进 `<projectRoot>/.cat-cafe/qoder-auth/<ref>`，
 * 无账户记录校验、无安全段校验、无 realpath containment——`../../../personal` 穿越、
 * 任意 api_key/openai 账号都能拿到一个可注册的 auth source。
 *
 * 本 resolver 是注册链唯一的 auth-source 装配点（I-11 §2/§5）：
 * 1. ref 必须是单段安全字符（与 catId 同款约束，拒绝路径分量注入）；
 * 2. 必须解析到一个**存在的 Qoder OAuth 家族账户**（stale/missing/api_key/异家族一律拒）；
 * 3. auth source 目录必须真实存在于 durable auth root
 *    （`<projectRoot>/.cat-cafe/qoder-auth/`，由 operator onboarding 落位 OAuth `.auth/`——
 *    仓库内无程序化 producer，这是显式运维契约而非隐式约定）；
 * 4. realpath containment（双侧解析）：解析后的 auth source 不得逃出 durable root
 *    （macOS /tmp → /private/tmp 这类合法前缀链接不误杀）。
 */

import { realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { resolveForClient } from './account-resolver.js';

export const QODER_AUTH_ROOT_DIRNAME = 'qoder-auth';

/** 单段安全字符（与 isSafeCatIdSegment 同款语义；账户 ref 的路径分量注入防线） */
const SAFE_ACCOUNT_REF = /^[A-Za-z0-9_-]{1,128}$/;

export type QoderAuthSourceResolution =
  | { ok: true; authSourceDir: string; accountRef: string }
  | { ok: false; reason: string };

export interface QoderAuthSourceDeps {
  /** 注入 realpath（测试；默认真实 fs） */
  realpathSync?: (p: string) => string;
  /** 注入账户解析（测试；默认 resolveForClient） */
  resolveAccount?: (projectRoot: string, ref: string) => { authType: string; client?: string } | null;
}

export function qoderAuthRootFor(projectRoot: string): string {
  return join(resolve(projectRoot), '.cat-cafe', QODER_AUTH_ROOT_DIRNAME);
}

export function resolveQoderAuthSourceDir(input: {
  projectRoot: string;
  accountRef: string | undefined;
  deps?: QoderAuthSourceDeps;
}): QoderAuthSourceResolution {
  const ref = input.accountRef?.trim() ?? 'qoder';
  if (!SAFE_ACCOUNT_REF.test(ref)) {
    return { ok: false, reason: `unsafe qoder accountRef segment: ${JSON.stringify(ref.slice(0, 32))}` };
  }
  const projectRoot = resolve(input.projectRoot);
  const resolveAccount =
    input.deps?.resolveAccount ?? ((root: string, r: string) => resolveForClient(root, 'qoder', r));
  const account = resolveAccount(projectRoot, ref);
  if (!account) {
    return { ok: false, reason: `qoder account "${ref}" not found in the account store (stale or missing binding)` };
  }
  if (account.authType !== 'oauth') {
    return {
      ok: false,
      reason: `qoder account "${ref}" must be oauth (config-dir auth); got authType=${account.authType}`,
    };
  }
  if (account.client && account.client !== 'qoder') {
    return { ok: false, reason: `bound account "${ref}" belongs to provider "${account.client}", not qoder` };
  }
  const authRoot = qoderAuthRootFor(projectRoot);
  const authSourceDir = join(authRoot, ref);
  const realpath = input.deps?.realpathSync ?? realpathSync;
  try {
    const dirReal = realpath(authSourceDir);
    const rootReal = realpath(authRoot);
    if (dirReal !== rootReal && !dirReal.startsWith(rootReal + sep)) {
      return {
        ok: false,
        reason: `qoder auth source escapes the durable auth root (realpath ${dirReal} not under ${rootReal})`,
      };
    }
    return { ok: true, authSourceDir, accountRef: ref };
  } catch (err) {
    return {
      ok: false,
      reason: `qoder auth source missing or unresolved at ${authSourceDir} (operator onboarding required): ${String(err)}`,
    };
  }
}
