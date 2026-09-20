# upstream #1493 — CI 终态全绿，回帖 + 重登记 tracking（点点/@dsh-v41-flash）

- **触发**: PR wait `pr_ci_terminal` 命中 — zts212653/clowder-ai#1493「CI pending → pass (0 blockers)」（2026-09-20 12:41 UTC）
- **前序**: `2026-09-20-upstream-1493-1494-rebase-to-current-base-dsh.md`（本轮是该轮 §六「等 verdict」的 CI 面收口）

## 一、地面真相（gh api 实查，非转述）

| 面 | 值 |
|---|---|
| HEAD | `96b487bafcb15ca1cfe9edd14667d59a6c7a9c54`，base = `main@9bca5ae2f6e83391d5a560764e28372af4073b1b`（= 当前 main，`compare` 显示 head 未落后） |
| checks | 16 项：**15 pass / 1 skipped / 0 fail / 0 pending**；required 四门（Lint / Build / Test (Public) / Directory Size Guard）全绿 |
| 唯一非 pass | `Public test (serial bootstrap)` = skipped，**当前 main 的 run 35499026038 同为 skipped** → lane 条件，非失败、非本分支特有 |
| merge 面 | `mergeable: MERGEABLE`；`mergeStateStatus: BLOCKED`（剩余原因只有 review）；`reviewDecision: REVIEW_REQUIRED` |
| review 面 | formal reviews **0 条**、inline comments **0 条**；球完全在维护者侧的 exact-HEAD review |

## 二、本轮动作

1. **修 PR body 的过期 pin**（真实缺陷，非美化）：body `## Verified` 仍写着 head `cd9b92b5d` / base `main@6291ff079` —— 12:30 第二次 rebase 时只发了评论、漏改 body。已改为 `96b487baf` / `main@9bca5ae2f`，并诚实标注「测试数字测于原始内容 `486241a87`，两次 base 更新都是纯重放故沿用」。复核：`bodyHead` = `96b487baf…`。
2. **回帖上报 CI 终态**：issuecomment-**5749877435**（16 检查表 + skipped 项与 main 对照 + patch 同一性 + 剩下唯一门是 review 记录），措辞只说事实，不再要求 re-review。
3. **重登记 tracking**：旧登记在 `pr_ci_terminal` 命中后任务已被判 `done` —— 若不重登记，剩下的「等 verdict」就没有回调覆盖。重新登记后 task `0001789886359591-000157-5e679774` 复用同一 id、generation 9、`todo`，谓词 `pr_review_decision_changed` / `pr_became_conflicting`，expiry 2026-09-27T12:41Z。

## 三、patch 同一性（本轮自跑复核，不引用二手结论）

- `git range-diff 6291ff079..cd9b92b5d upstream/main..96b487baf` → `1: cd9b92b5d = 1: 96b487baf`
- `git diff upstream/main..HEAD | sha256sum` = `f1287c2709915965a5d4cfe4de3204c857a5fe0c382e5ecf3ede8957420dcab1`（与 rebase 前一致）
- `git diff --stat` = 1 文件 +1/−1，内容仍是 `evidence-tools.test.js` 的 `\\(sacred\\)` 单行

## 四、球权与记账

- **球权：纯外部**（维护者对 #1493 exact HEAD 的 formal verdict）。已按 KD-27 走结构化回调，**不调 hold_ball**、不占球空转。
- **本地尾巴（已升级 operator）**：谱谱名下三条修复球功能面全部闭环，但状态仍是 `todo`——
  - round-1 `0001789891992618-000203-7c3fd40f`（`7ed9de46b`，维护者 round-1 三条全 FIXED）
  - round-2 `0001789903731003-000226-c1743771`（`00b6f21b2`，维护者 round-3 review 确认全 FIXED）
  - round-3 `0001789905524611-000243-90e1c964`（`743cfc523`，维护者 12:17:49Z LGTM/APPROVE，收口三条件 push+CI 全绿+维护者确认**已全部到齐**）
  - 本轮再次实测核销：`update_task` → **403 `Task is owned by another cat`**。owner-only 权限模型下只有 owner 或 operator 能关；谱谱全部 carrier 无 `cat_cafe_*` 工具与凭证（前轮审计）→ 唯一可行路径是 operator 从任务板关闭，已升级。
  - 危害不是账面好看：这三条 `todo` 已经造成过一次**过期重投**（谱谱收到「round-2 派修」重复唤醒，需要额外一轮纠偏），继续挂着会持续制造假球。

## 五、下一步（裁决到达后）

- **APPROVED** → 先核 head 是否仍含最新 main（strict 规则）：main 已动先 rebase、后请 approve（顺序反了会被 `dismiss_stale_reviews_on_push` 吃掉）→ 交维护者 squash merge（家内不代 merge）。
- **#1493 合入 main 后第一件事**：把 #1494 rebase 到新 main 并重推 —— 否则 #1494 立即 `BEHIND` 不可合，而它若已拿到 approval，这次 push 又会 dismiss 掉它。
- **CHANGES_REQUESTED** → 取 review body 回 thread 派修 @zcode。

[点点/deepseek-flash🐾]
