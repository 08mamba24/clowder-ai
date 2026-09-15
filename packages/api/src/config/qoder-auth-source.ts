/**
 * F317 Slice 2 round-3（砚砚 review 2×P1）：类型化 account→auth-source resolver v2。
 *
 * round-2 的三个绕过（全部按 verdict 修复）：
 * 1. resolveForClient 对 builtin ref 会**合成** OAuth profile——没有任何存储账户记录时
 *    也能过。v2 直接读 account store snapshot 的 resolved verdict：必须存在**真实存储
 *    记录**，无合成回退。
 * 2. `client && client !== 'qoder'` 放过 familyless OAuth（rogue:{authType:'oauth'}）。
 *    v2 要求账户记录**显式声明 clientId 'qoder'**（严格家族同一性）。
 * 3. containment 只把 child 锚到 realpath(authRoot)，authRoot 自身没锚——
 *    `.cat-cafe/qoder-auth` 整体 symlink 到外部目录曾判绿。v2 对 authRoot 节点自身做
 *    lstat custody（symlink/非目录拒）+ realpath 锚定到 durable parent（双侧解析）。
 *
 * 拓扑（I-11 持久归属）：durable root = account store topology 的 primaryRoot——
 * runtime-worktree 模式下（CAT_CAFE_RUNTIME_ROOT + CAT_CAFE_WORKSPACE_ROOT）账户
 * 元数据与 qoder auth/profiles 同落**持久 workspace**，而非可弃置的启动 checkout
 * （后者重建会删 OAuth seed 与 sessions）。operator onboarding 契约：在 durable root
 * 写入 qoder OAuth 账户记录（clientId:'qoder'）并把 `.auth/` 落位
 * `<durable>/.cat-cafe/qoder-auth/<ref>/`。
 */

import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readAccountStoreSnapshot } from './account-store-snapshot.js';
import { resolveAccountStoreTopology } from './account-store-topology.js';

export const QODER_AUTH_ROOT_DIRNAME = 'qoder-auth';

/** 单段安全字符（与 isSafeCatIdSegment 同款语义；账户 ref 的路径分量注入防线） */
const SAFE_ACCOUNT_REF = /^[A-Za-z0-9_-]{1,128}$/;

export type QoderAuthSourceResolution =
  | { ok: true; authSourceDir: string; accountRef: string }
  | { ok: false; reason: string };

export interface QoderAuthSourceDeps {
  realpathSync?: (p: string) => string;
  lstatSync?: (p: string) => { isDirectory(): boolean; isSymbolicLink(): boolean };
  /** 注入账户存储读取（测试；默认 readAccountStoreSnapshot 的 inspect verdict） */
  readSnapshot?: (projectRoot: string) => {
    inspect: (ref: string) => {
      accountRef: string;
      state: string;
      entry?: { account?: { authType?: string; clientId?: string } };
    };
  };
}

/** qoder durable root：与账户元数据同一持久拓扑（workspace > 可弃置 runtime checkout） */
export function qoderDurableConfigRoot(projectRoot: string): string {
  return resolveAccountStoreTopology(projectRoot).primaryRoot;
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
  const deps = input.deps ?? {};
  const realpath = deps.realpathSync ?? realpathSync;
  const lstat = deps.lstatSync ?? lstatSync;

  let durableRoot: string;
  let record: { authType?: string; clientId?: string } | undefined;
  try {
    durableRoot = qoderDurableConfigRoot(projectRoot);
    const snapshot = (deps.readSnapshot ?? readAccountStoreSnapshot)(projectRoot);
    // inspect 的 rejected verdict（torn/divergent store）同样视为无有效记录（fail-closed）
    const verdict = snapshot.inspect(ref);
    record = verdict.state === 'resolved' ? verdict.entry?.account : undefined;
  } catch (err) {
    return { ok: false, reason: `qoder account store unresolvable: ${String(err)}` };
  }
  // 1) 真实存储记录（无合成回退）
  if (!record) {
    return {
      ok: false,
      reason: `qoder account "${ref}" has no stored account record — synthetic builtin fallback is not accepted (operator onboarding required)`,
    };
  }
  // 2) 严格家族同一性：显式 clientId 'qoder'（familyless OAuth 一律拒）
  if (record.clientId !== 'qoder') {
    return {
      ok: false,
      reason: `qoder account "${ref}" must declare clientId "qoder" (got ${JSON.stringify(record.clientId)})`,
    };
  }
  if (record.authType !== 'oauth') {
    return {
      ok: false,
      reason: `qoder account "${ref}" must be oauth (config-dir auth); got authType=${record.authType}`,
    };
  }
  // 3) authRoot 节点自身 custody + 锚定 durable parent
  const configRoot = join(durableRoot, '.cat-cafe');
  const authRoot = join(configRoot, QODER_AUTH_ROOT_DIRNAME);
  try {
    const rootSt = lstat(authRoot);
    if (rootSt.isSymbolicLink()) {
      return { ok: false, reason: `qoder auth root is a symlink: ${authRoot}` };
    }
    if (!rootSt.isDirectory()) {
      return { ok: false, reason: `qoder auth root is not a real directory: ${authRoot}` };
    }
  } catch (err) {
    return { ok: false, reason: `qoder auth root missing at ${authRoot}: ${String(err)}` };
  }
  const authSourceDir = join(authRoot, ref);
  try {
    const dirReal = realpath(authSourceDir);
    const rootReal = realpath(authRoot);
    const parentReal = realpath(configRoot);
    if (rootReal !== parentReal && !rootReal.startsWith(parentReal + sep)) {
      return {
        ok: false,
        reason: `qoder auth root escapes the durable config root (realpath ${rootReal} not under ${parentReal})`,
      };
    }
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
