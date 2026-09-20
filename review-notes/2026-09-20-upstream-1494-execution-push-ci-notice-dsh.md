# upstream #1494 执行线 — push / rebase 到当前 base / CI / 维护者通报（点点/@dsh-v41-flash）

- **触发**: 谱谱（glm-5.3）交执行球（家内 review 闭环 APPROVED，verdict 落盘 main `7f6ddd5ee`）
- **对象**: zts212653/clowder-ai **#1494**（fork `08mamba24/clowder-ai` 分支 `fix/mcp-strict-readonly-union`；PR head repo = fork，upstream 无同名分支）
- **结果**: 新 exact HEAD `4cb04f7e0ec23d260b900289e35b320ac6af6d32`，CI 全绿，维护者通报已发 `issuecomment-5749491340`

## 一、执行序列与坐标

| 步骤 | 结果 |
|---|---|
| 核远端 | fork `origin` 分支停在 `d1f8d6b0b`（维护者所审 HEAD）；`gh pr view` 确认 head repo = `08mamba24/clowder-ai` |
| push ① | `12e3afc07` 快进推送（`d1f8d6b0b..12e3afc07`），PR head 切换、CI 起 |
| 发现 base 漂移 | `mergeStateStatus: BEHIND`（main 前进 `9bca5ae2f` = #1394）。规则集 `Protect main for private beta`：`strict_required_status_checks_policy: true` + `required_linear_history` + `dismiss_stale_reviews_on_push` + `bypass_actors: null` ⇒ **verdict 后 rebase 会作废 approval，必须在 review 落地前更新 base**（与 `4ae79026b` 结论一致） |
| rebase | `12e3afc07` → **`4cb04f7e0`**（4 commits 线性重放到 `9bca5ae2f`，全自动无冲突） |
| patch 同一性 | `git range-diff 6291ff079..12e3afc07 9bca5ae2f..4cb04f7e0` 四条全 **`=`**；逐文件 `+/-` 行集合 **21/21 SAME**；差异仅 `index` 行与 hunk 行号 |
| 唯一交集文件 | `packages/mcp-server/src/tools/callback-tools.ts`：main 改 wait-predicate schema/import 区，本分支改 helper 下沉 + rich-block 凭证判定 → 自动合并，**双方内容均在**（已断言：#1394 的 `pr_conversation_comment_added` / `GITHUB_PR_WAIT_PREDICATE_LIMIT` 与本分支 `hasUsableAgentKeyCredentials` / 共享 helper 共存，本地旧 helper 已移除） |
| force-push | `--force-with-lease=refs/heads/...:12e3afc07` → fork `4cb04f7e0`；远端树 `2536f9a3d` 与本地逐位一致 |
| PR 状态 | `headRefOid=4cb04f7e0`、`mergeable=MERGEABLE`、`mergeStateStatus` **BEHIND → BLOCKED**（剩余原因仅 review required） |

## 二、本地门禁（CI 同款，Node 24.18.0，洁净 env）

- `pnpm biome check . --diagnostic-level=error`：**8632 文件 0 error / exit 0**
- tsc：shared / mcp-server / api `pnpm run build` 均 0 退出
- mcp-server 全量（`env -i` 洁净）：**829 tests / 828 pass**，唯一红 = `test/evidence-tools.test.js:549` 既有 #1493-lane coverage regex（该文件本分支 **未触碰**，`git diff` 为空；维护者亦独立认定与本 PR 无关）
- mcp-server 受影响批 181/181；api（`mcp-config-adapters` + `antigravity-mcp-tool-executor`）**72/72**；shared `agent-key-credentials` **9/9**
- 仓库级 check：`check:env-registry` / `check:env-example` / `check:env-ports` 三项 PASS（本 PR 改了 `env-registry.ts`，属相关面）

### 环境坑（复现要点，已留痕）

在**本会话 shell** 里直跑 mcp-server 测试会假红：ambient `CAT_CAFE_CREDENTIAL_FILE`（连同 16 个 `CAT_CAFE_*`）把真实 invocation 凭证注入回调层，`callback-tools.test.js` 两条 parse 断言 actual = 真实 UUID、expected = `test-invocation`。用 `env -i PATH=... HOME=... node --import tsx --test ...` 洁净后 **181/181 全绿**。⇒ 结论：mcp-server 测试必须在洁净 env 下跑，否则会把环境注入误判成代码回归。

## 三、CI 与维护者通报

- **CI（新 HEAD）全绿**：Lint / Build / Test (Public) / Directory Size Guard / Test (Windows) / Public contract surfaces / 六个 public-test shard 全 pass（runs `35507180462`、`35507180434`，`gh pr checks --watch` exit 0）。
- **PR 评论**：`https://github.com/zts212653/clowder-ai/pull/1494#issuecomment-5749491340` —— 三条 finding 修复映射、base 更新原因、patch 同一性证据、新 exact HEAD、本地证据 + CI 结果。措辞保持 contributor 口吻（无家内称谓）。
- **结构化等待**：`register_pr_tracking` (#1494) → task `0001789886365167-000158-59dbd6ea` generation 5，predicates = `pr_review_result_available` / `pr_review_decision_changed` / `pr_ci_terminal` / `pr_became_conflicting`，expiry 2026-10-04。

## 四、待办 / 风险

1. **家内 review 绑定需 re-pin**：砚砚的 APPROVED 绑在 `12e3afc07`，rebase 后推送面是 `4cb04f7e0` —— 已按 patch 同一性（range-diff `=` + 逐文件 +/- 集合）请砚砚确认 re-pin；新增面（与 #1394 合并后的 `callback-tools.ts` 合体状态）在请求里点名。
2. **#1493（lane B）若先合入 main** ⇒ 本分支再次 behind，需再 rebase + 重跑 CI（approval 会失效）。#1494 tracking 的 `pr_became_conflicting` / `pr_head_changed` 覆盖该情况。
3. **共享 main 分歧未处理**：本地 main `ahead 15 / behind 3`（15 条 receipt 未推、origin/main 3 个 commit 走 PR 合入），本轮**未**擅自 rebase/push 共享工作树（存在他人在途的 `pnpm-lock.yaml` 改动 `+46/−151`）；本回执按既有模式落本地 main。`cat-cafe` remote 已失效（repository not found）。→ 建议 operator 决定 main 的同步方式。

[点点/deepseek-flash🐾]
