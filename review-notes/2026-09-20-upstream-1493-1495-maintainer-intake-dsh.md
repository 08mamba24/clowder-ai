# upstream intake 回执 — PR #1493 / #1494 维护者反馈与响应（点点/@dsh-v41-flash）

- **对象**: zts212653/clowder-ai #1493（PR B: evidence coverage regex carrier）、#1494（PR A: strict-readonly carrier）、#1495（新建 issue）
- **触发**: 2026-09-20 06:44 UTC 维护者（zts212653）对两个 PR 的 intake 评论 + PR wait 回调
- **执行者**: 点点/@dsh-v41-flash（承接 thread_mu6ddfoyrngc9l7s 的 §三 GitHub 序列）

## 一、维护者 intake 裁决（原文要点）

| PR | 裁决 | 要求 |
|---|---|---|
| #1493（B） | `triaged` + `needs-info`，**不可进入 formal review** | 开一个 narrow 的 accepted bug issue 并 link；**明确点名不要复用 #1492**（那是授权边界的 issue） |
| #1494（A） | 方向 **WELCOME**，link 的 #1492 已 accepted | 路由到 exact HEAD `a71b70c0e` 的 formal review；同时指出 CI 未终态、branch behind base；**非 formal review verdict，非 merge 授权** |

两个 PR 均为 `mergeStateStatus: BEHIND`（base 已推进到 `6291ff079`）。

## 二、响应动作（本轮）

1. **开 issue #1495**（new，仅 `bug` 无 triage label，等维护者裁决）：
   `test(mcp): evidence coverage assertion regex treats literal parens as a capture group — deterministic failure on main`
   - 内容 = observed / expected / scope / reproduction steps / fix，全部带 exact 证据坐标。
   - **独立核验（非转述 runbook），在 /tmp 干净 clone `zts212653/clowder-ai@6291ff079` 上做**：
     - 断言在 `packages/mcp-server/test/evidence-tools.test.js:605`，当前 main 仍是未转义版本（`git show origin/main:...` 逐行核对，避免工作树污染误判）。
     - 渲染源 `packages/mcp-server/src/tools/evidence-coverage-response.ts:112` `[matchType:${...}] ${boundField(item.title)}`；`boundField`（同文件 :192）对短标题不加不减括号 ⇒ 标题里的括号原样出现在输出里，期望串本身写错。
     - 缺陷由 `ffa73bb8f`（sync #1282）引入，`base 9ab0eaf28` 与当前 main 都存在；env 无关、确定性、非 flaky。
     - 一行反证：`escaped.test(line) === true` / `buggy.test(line) === false`。
2. **link 到 PR #1493**：body 顶部加 `Fixes #1495`，并把「companion carrier 随后」的悬空措辞改为实号 `#1494`；GitHub 已识别 `closingIssuesReferences=[1495]`。
3. **CI 终态复核**：#1493 = 15 pass / 1 skip；**#1494 = 15 pass / 1 skip（已转绿，维护者说"CI 未终态"的那一项已不成立）**。
4. **SHA 对齐**：本地分支 A `a71b70c0e` / B `486241a8` 与两个 PR head 逐位一致，无本地漂移。

## 三、有意**没有**做的事（留给维护者裁决）

- **没有 rebase**：两个 PR 都 BEHIND，但 rebase 会改 HEAD，直接作废维护者正在路由的 exact-HEAD review（A）与刚 intake 的 B。分支 `MERGEABLE` 且 CI 全绿，"behind" 不阻塞走查。**等维护者选择"要求 rebase"还是"允许 behind 合并"**，不自作主张。
- **没有推本地 main**：docs commit（含本回执）继续留在本地，与上一轮一致（main 同步归 operator/整合阶段，不夹带进 upstream carrier）。
- **没有改 #1493 的已验证 HEAD**：该 HEAD 已获跨族 APPROVED（砚砚在 exact SHA 复跑 31/31）。

## 四、剩余 = 纯外部条件

| 线 | 等什么 | 谁 |
|---|---|---|
| B（#1493 → #1495） | issue #1495 被维护者 triage/accepted → 才能进 formal review | 维护者 zts212653 |
| A（#1494） | exact HEAD `a71b70c0e` 的 formal review verdict（+ 是否要求 rebase） | 维护者 zts212653 |

等待方式：`register_pr_tracking` 结构化谓词（`pr_review_result_available` / `pr_head_changed` / `pr_ci_terminal` / `pr_became_conflicting`），不靠口头续约。
