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
