# upstream #1494 已合入 → #1493 rebase 到新 main（点点/@dsh-v41-flash）

- **触发**: `PR wait satisfied` — `zts212653/clowder-ai#1494` state=**merged**（2026-09-20 16:35:15Z，merge commit `bec58eeb6e44a4b78f41b4ccfbd2970f63366a29`）。
- **前序**: `2026-09-20-upstream-1493-1494-wait-recheck-1303z-dsh.md`（该轮结论：「合入后立刻把另一条 rebase 到新 main」）。

## 一、本轮动作：按既定计划把 #1493 rebase 到新 main

- 事实：`upstream/main` `9bca5ae2f` → `bec58eeb6`（#1494 squash 合入）；#1493 head 仍是 `96b487baf`、base `9bca5ae2f` → `mergeStateStatus` 由 `BLOCKED` 变 **`BEHIND`**。
- 操作：在 `clowder-ai-wt-1493-rebase` 执行 `git rebase upstream/main` → 新 head `8f7b9bf3d9574b3be1e8d64aebf73f70a507367e`，**无冲突**（#1494 未触碰 `packages/mcp-server/test/evidence-tools.test.js`）。
- 纯重放证据（本地实跑，非转述）：
  - `git range-diff 9bca5ae2f..96b487baf upstream/main..8f7b9bf3d` → `=`；
  - `git diff upstream/main..HEAD | sha256sum` = `f1287c2709915965a5d4cfe4de3204c857a5fe0c382e5ecf3ede8957420dcab1`（与 PR body 原先记录的值**完全一致**）；`1 file changed, 1 insertion(+), 1 deletion(-)`。
- 推送：`git push --force-with-lease=refs/heads/fix/mcp-evidence-coverage-regex:96b487baf… origin HEAD:refs/heads/fix/mcp-evidence-coverage-regex` → `+ 96b487baf...8f7b9bf3d (forced update)`（fork 头分支在 `origin`=`08mamba24/clowder-ai`，PR 目标在 `upstream`=`zts212653/clowder-ai`）。
- 推送后 PR 面：`headRefOid=8f7b9bf3d`、`mergeStateStatus=BLOCKED`（**不再 BEHIND**）、`mergeable=MERGEABLE`、`reviewDecision=REVIEW_REQUIRED`——本 PR formal review 数为 0，force-push 没有 dismiss 任何 verdict。

## 二、新 base 上的红→绿（不只沿用旧数字）

- 方法：该 test 文件只 import node 内建，但内部 `await import('../dist/tools/evidence-tools.js')`，故用主仓已构建 `dist` + 同版 `node_modules` 搭临时运行目录 `/tmp/dsh-1493-run`（不改任何共享 worktree）。
- **绿**：本 head 的 test 文件 → `tests 31 / pass 31 / fail 0`。
- **红对照**：`upstream/main`（pre-fix）版 test 文件 → `tests 31 / pass 30 / fail 1`，唯一 fail 是 `intent=coverage formats CoverageSearchResult matrix instead of crashing (P1-2)`，与 #1495 描述一致。
- 变量唯一性：两次跑的是同一份 `dist`；`packages/mcp-server/src/tools/evidence-tools.ts` 在主仓与 `upstream/main` 内容一致（`sha256 60e8a631…`），唯一变量就是被 escape 的那一行。

## 三、tracking 与分工同步

- `#1493` task `0001789886359591-000157-5e679774`：await **generation 10 → 11**，baseline head 换成 `8f7b9bf3d`；谓词 = `pr_ci_terminal` + `pr_review_decision_changed` + `pr_became_conflicting`。新增 `pr_ci_terminal` 的理由：head 变了、新 CI 无任何覆盖（旧轮 CI 全绿只对旧 head 成立）；**未新增请审、未新建 task、未新增重复轮询**。
- `#1494` task `0001789886365167-000158-59dbd6ea`：`status=done`（terminal `merged`），其 `continuation.then` 已含新分工，本轮不再改动。
- 分工按 Astra 的收口：新的 `CHANGES_REQUESTED` → 交 **astra** 分析与登记（推进任务 owner=astra），代码实现交 **zcode**，点点只做 push/rebase/CI 与上游跟进。
- PR body 的 head/base pin 与 range-diff 证据已同步更新为 `8f7b9bf3d` / `main@bec58eeb6`。

## 四、下一步：2b 纯事件驱动

- 三个谓词都有结构化回调 → **不 hold_ball、不 @ 本地 proxy、不在 PR 上重复请审**（维护者 review 是外部条件，家内无可投射的猫）。
- `APPROVED` → 核 required 四门全绿且 head 仍含最新 main（若 main 又动，先 rebase 再请 approve）→ 交维护者 squash merge（家内非 admin，不自 merge）。
- CI 红 → 点点按 job 日志定位：属本 PR 范围自修，属实现面退回 zcode。`conflicting` → 点点 rebase 重推重跑。

[点点/deepseek-flash🐾]
