# merge-gate 证据脚本 gh 串仓修复（pin --repo 到 origin）— 谱谱/glm-5.3

- 分支：`fix/merge-gate-gh-repo-pin`（worktree `clowder-ai-wt-ghpin`，base = `origin/main` `f04205eec`）
- 毛线球：导航残留两条未分配 todo（gh 解析到 upstream 的根因确认 + merge-gate 脚本串仓修复），2026-09-17 由我接手
- 性质说明：修复对象是 merge-gate 证据工具本身，非线上事故止血；按跨猫 review 铁律走 review，不 self-merge

## 根因（机制 + 实证）

本 clone 同时跟踪 `origin=08mamba24/clowder-ai`（我们 PR 所在仓）与 `upstream=zts212653/clowder-ai`。`git config gh.repo` 未设（`git config --get gh.repo` exit=1），gh CLI 回落到 git remote 解析且 **`upstream` 优先于 `origin`** → 所有裸 `gh pr ...` 打到 upstream。

全仓扫描（scripts/ + packages/，排除测试/生成物/intake 链）确认裸调用执行点共 3 处：

| 处 | 调用 | 类型 |
|---|---|---|
| `scripts/check-hotfix-pattern.mjs:51`（修前行号） | `gh pr view ${n} --json title` | 读 |
| `scripts/check-hotfix-pattern.mjs:103` | `gh pr edit ${n} --add-label hotfix` | **写**（会误标 upstream 仓的 PR） |
| `scripts/classify-merge-outcome.mjs:169` | `gh pr view ${n} --json state,...`（merge 真相） | 读 |

后果面：classify 读到错误仓库的 PR truth → merge 结果误判；hotfix 标签写到别人仓库的 PR。

## 修法（P4 单一真相 + fail closed）

新 helper `scripts/lib/merge-gate-gh-repo.mjs`：`resolveMergeGateRepository()` 从 `git remote get-url origin` 解析 `owner/repo`（纯函数 `parseGitHubRepository` 支持 https/ssh/带不带 `.git`），解析不出**抛 `merge_gate_repo_unresolved`**。三处调用点全部加 `--repo <解析值>`：

- classify `readPrTruth`：解析失败落入既有 catch → PR truth 不可得 → 分类器沿既有路径 fail closed（indeterminate）
- check-hotfix-pattern 写入路径：解析失败**拒绝执行** `gh pr edit`（`labelApplied=false` + `labelError` 上报 JSON），绝不做裸写
- check-hotfix-pattern 标题扫描：解析失败降级为仅 commit 扫描 + stderr 警告（commit 关键词检测不依赖 gh）

设计取舍：**运行时从 origin 推导，不硬编码仓名**——本仓上游同步场景下硬编码 `08mamba24/...` 会把 bug 换个方向带给 upstream clone；origin 才是"本 clone 的 PR 所在仓"这一不变量的唯一真相。**不加 env 覆盖层**：env 覆盖正是这次 bug 的 drift 类根源，纯函数测试面已由 `parseGitHubRepository` 提供。

## 红→绿证据（macOS 本地，base f04205eec）

- **红（修前）**：`node --test scripts/lib/merge-gate-gh-repo.test.mjs` → 3 个 pin 测试全红，红因正是 bug 本身——PATH 桩 gh 捕获的 argv 为 `["pr","view","42","--json","state,..."]`，**无 `--repo`**；`labelApplied` 在无 origin 时仍为 `true`（裸写放行）
- **绿（修后）**：同命令 15/15（lib 解析 12 + 跨脚本 pin 3）；classify 回归 `classify-merge-outcome.test.mjs` 23/23（fixture 路径不受影响）；合计 **38/38**
- 测试策略：临时 git 仓 + `origin=https://github.com/example-owner/example-repo.git` + PATH 桩 gh 记录 argv——零凭据、零网络，断言 view/edit 双调用都带 `--repo` 且不触 `zts212653/clowder-ai`；无 origin 用例断言 gh **零调用**
- biome：format 后 0 error；`git diff --check` 干净

## 范围边界（不动，均有既有 pin）

- `scripts/clowder-merge-execution.mjs`：`CLOWDER_REPOSITORY='zts212653/clowder-ai'` 是开源 intake 链（对 upstream 仓操作），pin 正确，不属本修
- `scripts/intake-from-opensource.sh`：全部经 `$SOURCE_REPO`/`$TARGET_REPO` 显式传参
- `scripts/guarded-bin/gh`：只对 verdict PR create 强制 `--repo`，透传其余——是否把"所有 pr 子命令强制 --repo"下沉进 wrapper 属 P3 增强，留给 reviewer 立场
- SOP.md 用法零变化（repo 自动推导，无需新参数）

## 残留风险（如实记录）

- 标题扫描在 origin 不可解析时降级为 commit-only——hotfix 判定仍有 commit 关键词兜底，且 stderr 有警告
- check-hotfix-pattern 既往无测试文件，本次新增的 3 个跨脚本 pin 测试放在 `scripts/lib/merge-gate-gh-repo.test.mjs`（主题 = repo pin，一个 harness 覆盖两脚本）

## 下一棒

- 跨族 review（缅因猫安全域）→ approve 后代推分支 + PR + merge gate（本 shell 无 GitHub 凭据，`git push` 实测 `could not read Username`；同日 main 上还有我 1 个待推 docs commit `bac54b34f`）
- review verdict 请绑 `reviewedHeadSha`（我已按 C7 规则在作者侧要求自己）

`[谱谱/glm-5.3🐾]`

## Round 2（应砚砚m CHANGES_REQUESTED，review 绑 reviewedHeadSha=e5f419a9371cb83a8f5b72f7f1f7d9805bcc801f）

四条 finding 全部采纳。上一轮我犯的扫描面错误在此勘误：**「裸调用执行点共 3 处」只扫了 scripts/ + packages/，漏了 cat-cafe-skills/ 的可执行 runbook 面**——merge-gate/SKILL.md 才是 canonical 执行链，它的裸 `gh pr comment`/`gh pr merge` 写入路径比脚本面更常被真实触发。教训：扫描"执行面"必须覆盖人/猫实际照着跑的 runbook，不只机器代码。

### P1-1 修法：全链共享同一解析器（不进通用 guarded wrapper，遵 reviewer 约束）

- lib 增加 CLI 入口：`node scripts/lib/merge-gate-gh-repo.mjs` 打印 `owner/repo`，解析失败 exit 1 + `merge_gate_repo_unresolved`（runbook 可直接 `$()` 捕获）
- `cat-cafe-skills/merge-gate/SKILL.md` 两个可执行块头各加一步（幂等）：`MERGE_GATE_REPO="$(node scripts/lib/merge-gate-gh-repo.mjs)" || { …exit 1; }`
- 以下调用点全部加 `--repo "$MERGE_GATE_REPO"`：Step7 前置 CURRENT_HEAD 读、E1 表格命令、`gh pr create`（PR 注册写入路径）、`gh pr checks`（含验收表）、PR body 防呆读、`gh pr comment`（×2：cloud 触发 + 降级 reviewer 触发 :680）、hotfix 手动 label 提示、author/reviews 读、`gh pr merge --squash`（merge 写入路径）、merge_pending 轮询/诊断 echo 提示（含 wakeWhen 指引）
- intake 链不动（合法 upstream 目标）；`guarded-bin/gh` 不做无差别强制（reviewer 立场，P3 增强仍留给他）

### P1-2 修法：结构化解析 + host 白名单

`parseGitHubRepository` 从子串搜索改为三种 URL shape 白名单（`https?://github.com[:port]/`、`ssh://[user@]github.com[:port]/`、`git@github.com:`），host 必须恰为 github.com（大小写不敏感），path 必须 `owner/repo[.git][/]`。新增负例：`https://evil.example/path/github.com/owner/repo.git`、`git@evil.example:github.com/owner/repo.git`、`ssh://git@evil.example/github.com/a/b`、`https://github.com.evil.com/a/b` 全部返回 null；`.git/` 尾斜杠边界返回 `owner/repo`（正例锁定）；port/大小写正例锁定。

### P2-1 修法：title fail-closed

- `check-hotfix-pattern.mjs`：PR_NUMBER 给定但 title 不可得（origin 解析失败 **或** gh view 空/失败）→ JSON 增 `prTitleError` + `indeterminate` 字段；无 commit 关键词证据时 **exit 3**（indeterminate），不再输出可被放行的干净 `hotfix:false`。commit 关键词已命中时仍 exit 2（正向证据自足，title 未知不改变 hotfix 定性，prTitleError 作信息附带）
- SKILL.md 6.8 消费端同步：`IS_HOTFIX != true && PR_TITLE_ERROR 非空` → 阻断 merge-gate（fail-closed）
- 新测试三场景：clean commits + 无 origin → exit 3；clean commits + gh 失败 → exit 3（prTitleError=`merge_gate_pr_title_unreadable`）且 view 仍带 `--repo`；clean commits + title 可读 → exit 0 基线

### P2-2 修法：接入 canonical suite

`package.json` `check:pre-merge-gate` 追加本测试文件；测试内自断言该接线（`check:pre-merge-gate` 必须包含本文件——从 pre-merge-check.test.mjs 的 contract 风格学来，防止将来被静默摘除）。

### Round 2 证据（macOS 本地，base e5f419a）

- 过程红：首次跑 5 个 hotfix 用例红（`const isHotfix` 重复声明 SyntaxError，stdout 空 → JSON.parse 炸）——当轮抓住修正，复跑全绿
- 新测试 29/29（host 白名单负例 5 + 接受形态 12 + resolve 3 + CLI 2 + pin 2 + fail-closed 3 + suite wiring 1 + classify pin 1）；classify 回归 23/23
- **canonical `check:pre-merge-gate` 全量：143 tests / 130 pass / 0 fail / 13 skip**（reviewer 基线 114 + 本文件 29，skip 数一致）
- skill contracts：`check-external-review-closure.mjs` PASS、`check-skill-first-party-surfaces` PASS（SKILL.md 编辑未破坏既有断言）
- biome 0 error；`git diff --check` 干净

### 相邻发现（不在本修范围，如实上报）

- `cat-cafe-skills/feat-lifecycle/SKILL.md:363`：`gh pr list` 裸调用（交付物核实指引）——非 merge-gate 链，建议单独毛线球处理
- receive-handoff-grounding refs 中的 `gh api repos/<repo>/...` 均带 path 参数，无串仓面

### 下一棒

@砚砚m re-review exact new HEAD（本 commit）；仍不推、不建 PR、不 merge，等 verdict。

`[谱谱/glm-5.3🐾]`
