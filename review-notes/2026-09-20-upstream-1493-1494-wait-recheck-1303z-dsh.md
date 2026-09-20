# upstream #1494 / #1493 — 持球到期复核（13:03Z）：无新 verdict，改纯事件驱动（点点/@dsh-v41-flash）

- **触发**: `hold_ball` 定时唤醒（2026-09-20 13:03 UTC）。上一轮 hold 的自我描述就是「本 hold 只做球权收口，不新增轮询」——本轮到期即收口。
- **前序**: `2026-09-20-upstream-1494-execution-push-ci-notice-dsh.md`、`2026-09-20-upstream-1493-ci-terminal-green-dsh.md`

## 一、复核事实（gh api 实查，非转述）

| 面 | #1494 | #1493 |
|---|---|---|
| state | OPEN，`mergeable: true` | OPEN，`mergeable: true` |
| HEAD | `743cfc5232062cc3b9464ebbf69c4680e98db1c3`（未动） | `96b487bafcb15ca1cfe9edd14667d59a6c7a9c54`（未动） |
| base | `main@9bca5ae2f6e83391d5a560764e28372af4073b1b`（= 当前 main 顶端，未 BEHIND） | 同上（= 当前 main 顶端，未 BEHIND） |
| checks | 16 项全 pass（`serial bootstrap` skipped，与 main 同 lane 条件） | 15 pass / 1 skipped / 0 fail |
| review 面 | 最新 formal review 仍是 **12:17:49Z COMMENTED**（id 5260545372），PR 级 `reviewDecision` 仍 **CHANGES_REQUESTED** | formal reviews **0 条**，`reviewDecision: REVIEW_REQUIRED` |
| 阻塞项 | 只剩维护者 formal decision（`mergeStateStatus: BLOCKED`） | 只剩维护者 exact-HEAD review |

- 远端 main 仍是 `9bca5ae2f`，两个 PR 都基于它 → **无 rebase 需求**（本轮不产生任何 push）。
- 13:03Z 距离我 12:28Z 的 CI 终态帖仅 35 分钟，维护者无任何新动作。

## 二、本轮决策：走 2b（结构化回调），不续 hold、不重复贴

- `#1494` tracking task `0001789886365167-000158-59dbd6ea` = **generation 10 / todo**，谓词 `pr_review_decision_changed` / `pr_became_conflicting`，基线 `decisionCursor 5260545372`。
- `#1493` tracking task `0001789886359591-000157-5e679774` = **generation 9 / todo**，同谓词。
- 两个待等条件都已有 EYES>0 的结构化回调覆盖 → 按 KD-27 **纯事件驱动，不调用/不续约 `hold_ball`**（再持一次只是把冗余定时唤醒叠在事件回调之上）。
- **在 PR 上不重复贴请审帖**：12:28Z 那条已请维护者出 decision-bearing review，重复 ping 是噪声，且不会改变外部裁决时刻。

## 三、唯一未变的本地尾巴（非本球可解）

三条谱谱名下修复球功能面早已闭环，状态仍 `todo`（本轮复核再次确认）：

- round-1 `0001789891992618-000203-7c3fd40f`（`7ed9de46b`）、round-2 `0001789903731003-000226-c1743771`（`00b6f21b2`）、round-3 `0001789905524611-000243-90e1c964`（`743cfc523`，维护者 12:17:49Z LGTM/APPROVE）。

`update_task` 关不动（403 owner-only，前轮实测），已升级 operator；本轮状态无变化，不重复升级。

## 四、裁决到达后的动作（不变）

- **APPROVED** → 核 required 四门（Lint / Build / Test (Public) / Directory Size Guard）全绿 + head 仍 up-to-date → 交维护者 squash merge（家内非 admin，不自 merge）。
- **#1493 先合入 main** → 立刻把 #1494 rebase 到新 main 并重推（否则 #1494 立即 BEHIND；若它已握 approval，这次 push 还会 dismiss 掉它）。
- **CHANGES_REQUESTED** → 取 review body 判 finding 归属，回 thread 派修 `@zcode`。
- **conflicting** → fork rebase 重推 + 重跑 CI，旧 review 失效。

[点点/deepseek-flash🐾]
