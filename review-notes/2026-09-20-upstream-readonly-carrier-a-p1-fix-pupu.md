# upstream #1454 救援 — 分支 A P1 修复 — 谱谱/glm-5.3

- **对象**: `fix/mcp-strict-readonly-union`，P1 修复 commit `a71b70c0e1df5e501f0865b14f2647c97c0a6dd4`（父 commit 即被审 exact HEAD `c55345affbd833a6c348066e68f608884f0e02de`，单一 delta）
- **P1 来源**: 缅因猫/砚砚 durable CHANGES_REQUESTED（消息 `0001789869531567-000114-a7ef865f`，evidenceRef `local-review:0001789869531567-000114-a7ef865f:changes_requested`，2026-09-20 02:12 UTC 重发全文）

## P1 要点（reviewer 原文归档）

Antigravity writer 的 union opt-in 按 `cat-cafe*` **名称**而非 managed **provenance** 发放：

1. `buildAntigravityCatCafeEnvBaseline()` 在 ambient key file 存在时直接合成 `CAT_CAFE_READONLY_AGENT_KEY_UNION=true`（原 `mcp-config-adapters.ts:151-166`）；
2. `ensureAntigravityCatCafeEnv(name, ...)` 只做 name check（原 218-232）；
3. 写入后第二轮对所有保留的 `cat-cafe*` 项重复执行（原 532-538）。

独立复现（reviewer）：preserved `/opt/third-party/cat-cafe-server` + 仅 fake `CAT_CAFE_AGENT_KEY_FILE=/tmp/fake-agent-key` → 输出 `{ keyFile, readonly:"true", union:"true" }`。仓库测试明确要求保留 user-owned/fork-like/third-party `cat-cafe` entry → key path + opt-in 一起写给第三方挂载，绕回本 PR 要封的边界。

## 修复设计（对齐四项验收条件）

union 合成从 name-gated baseline 撤回（baseline 回到基座形态），移入 `ensureAntigravityCatCafeEnv`，三重门控：

1. **provenance**：仅 `source === 'cat-cafe'` 的 managed descriptor 可自动合成（条件 1）。签名从 `(name, env)` 改为 `(server: Pick<McpServerDescriptor,'name'|'source'>, env)`；二轮循环对文件保留项传 `{ source: 'external' }`（F213 原则：无法证明所有权 → 按非 managed 处理；被禁用的 managed 项在一轮循环已按名删除，二轮只剩 user-owned/fork-like/third-party）。
2. **最终交付凭证**：合成判断放在 baseline/descriptor/enforced 三层合并**之后**，看 final merged env 是否真有 `CAT_CAFE_AGENT_KEY_FILE`/`FILES`（ambient 或 descriptor 显式带来均可）（条件 3）。
3. **显式值优先**：`CAT_CAFE_READONLY_AGENT_KEY_UNION` 已定义（含显式 `'false'` → 强制严格只读）则不合成；保留项上用户自己写的 opt-in 原样保留（条件 2/3）。

**范围边界**：ambient key-path 交付给 name 匹配的 entry 是基座（`9ab0eaf28`）既有行为，branch A 的 delta 只是往 baseline 加了 union 合成那一行（`git diff 9ab0eaf28..c55345aff -- <file>` 仅此一个 hunk）。本修复只回收 union 合成，不动基座既有 key-path 交付——四项验收条件均只针对 opt-in 标志；若 reviewer 认为key-path 交付也该收窄，另开独立 carrier。

## 证据（先红后绿，Node 24，worktree `clowder-ai-wt-upstream-readonly`）

- **红**（修复前，仅加测试）：`#1454 P1: ambient agent-key creds must not synthesize … preserved third-party` ✖、`#1454 P1: external-source descriptor with a cat-cafe-* name gets no synthesized union` ✖（即 reviewer 复现的两个入口：文件保留项 + descriptor 路径）；显式 false / 用户显式 opt-in 两个守卫 ✔（58/60）。
- **绿**（修复后）：`mcp-config-adapters.test.js` **60/60**（56 既有 + 4 新增）；`antigravity-mcp-tool-executor.test.js` **8/8**（另一 union 消费者 `McpToolExecutor.buildMcpEnv` 未动、保绿）；`biome format` 2 文件干净；`git diff --check` 干净；`tsc` 退出 0。
- 既有 managed+creds→union=true 断言（sidecar 测试）与 deepEqual 无 union 键断言（无 creds 时）均不变绿。

## 下一步

- @砚砚 复审 P1 delta（exact new HEAD `a71b70c0e1df5e501f0865b14f2647c97c0a6dd4`）。
- 复审通过后 operator 按 runbook §三 ②④⑤ 推进（push A、开 issue、开 PR A、关 #1454）；B 线 operator 步骤（§三①B+③）仍待执行。
