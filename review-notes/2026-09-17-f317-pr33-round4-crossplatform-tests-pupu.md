# F317 PR #33 round-4 现场与跨平台测试修复 — 谱谱/glm-5.3

- 分支：`fix/pr33-round4`（worktree `clowder-ai-wt-pr33-r4`）
- round-4 主体 commit：`6498dabf1`（砚砚/gpt-5.6-sol，9-16 19:58 +0800，已推 PR #33）
- 本轮 commit：`20dd7cd72`（谱谱/glm-5.3，**本地待 operator push**：`git push origin fix/pr33-round4`；取代已被 dsh 复审过的 `c55190f1b`——复审后按其 P3-1/P3-2/事实纠正 amend，需重绑 verdict）

## round-4 主体（6498dabf1）交付面 — 我读 diff 复核

对应 dsh rereview 的 P2-A / P2-B / P3-D / P3-E / P3-F：

- **P2-A（冻结 branch identity）**：`gitRefWriteLiterals()` 读 `gitDir/HEAD` 一次，只把**当前分支 ref**（+ `.lock`）与 `refs/stash` 加进 writeLiterals；`refs` 整树从 writeRoots 移除。worktree 拓扑另收 `worktreeLocalGitWriteLiterals()`（index/HEAD/COMMIT_EDITMSG 等）。直接 checkout 拓扑用 `workspaceWriteExclusions` 把 `.git` 从 workspace 递归写里剔掉，走 require-not 子句。
- **P2-B（guarded gh / pnpm）**：`controlledToolPath()` fail-closed 重写——xcrun 解析失败/守卫 gh 缺失直接 throw；guarded-bin 与 pnpm bin 进 PATH 与 allowedReadRoots；inherited PATH 中位于 operator home 下的条目被剔除。probe 新增 guarded gh resolution + execution canary。
- **P3-F**：`--allowed-tools` 补 `Write/Glob/Grep(workspace)`，六工具预授权齐了。
- **P3-D**：runtime 凭证 deny 扩到 `.npmrc` / 根 `credentials.json` / `evidence.sqlite` / `event-memory.sqlite`。
- **P3-E**：lease 构造期 try/catch + 失败清理 mcp-config 残留。

## 跨平台测试根因（Linux CI 红）

- CI 公共测试 lane 全部 `ubuntu-latest`，跑全量 API 测试；Windows smoke 只跑指定文件（不含 qoder）。
- 结构测试 `L2: controlled invoke delivers six basic tools...` 传字面量 `sandboxBinary: '/usr/bin/sandbox-exec'`：macOS 存在 → 绿；**Linux ENOENT → `validateQoderControlledRuntimePaths` fail-closed → done 断言红**。
- **红始于 round-2 `1c15358de`**（该轮引入 validate + sandboxProbe seam；dsh 复审纠正，我已独立 grep 验证：round-1 `6bc9ad2e7` src 无 validate、test 无 sandboxProbe，字面量从未被 stat）。我初版 note/commit 写的「自 round-1 起」是把「测试文件存在」误推成「红存在」，已修正。
- 该测试 probe 已被桩掉、从不执行 sandbox-exec，本不需要真二进制。

## 修复（20dd7cd72，2 文件 57+/2-）

1. `makeControlledRuntime()` 生成假 `sandbox-exec`——只为通过 isFile+X_OK 校验；**fail-loud**（stderr + exit 70）：将来若有人取消 probe 桩，桩执行即响亮失败，不会把「假沙箱放行 canary」误当绿灯（dsh P3-1）。
2. 新增非 skip 回归：`sandboxBinary` 路径缺失 → 0 spawn + `/runtime sandbox asset unavailable/`——fail-closed 契约钉在**所有平台**（dsh 变异 B 已证非空测）。
3. **P3-2**：`buildSeatbeltPolicy` 新增 `deniedWriteUnlinkRoots` slot，末位输出 `(deny file-write-unlink (subpath <logs>))`；direct-checkout 与 worktree 两拓扑都把 git `logs` 根纳入——**shared reflog 变 append-only**（正常 commit 追加不受影响，删除被拒）。两拓扑探针 + 字节存活断言。
4. darwin-only 真沙箱用例保持 `/usr/bin/sandbox-exec` 字面量不变（它们要真跑 Seatbelt）。

## dsh 复审（2026-09-17，绑定 c55190f1b）已闭合的部分

- **APPROVE**：82/82 + 42/42 + biome 0 error（与 HEAD~1 同噪）；P2-A/P2-B 活体确认（真 Seatbelt：改/删 shared main ref=1、伪造 ref=1、planted 指针全拒；guard bin 缺失即 throw，读面最小）。
- 变异 A（validate 强制 fail-closed = Linux 真实分支）→ 结构测试红，Linux 症状本地复现；变异 B（强制 ok）→ 新回归红，断言精确。dist 已还原。
- 事实纠正（round-2 起红）→ 本 note 与 commit message 均已修正。

## P3-3（记录不改，生产不可达）

- darwin 分支 pnpm 解析失败非 fail-closed（仅不加 PATH）；非 darwin `controlledToolPath` 短路返回 inherited PATH——生产 Linux 上 controlled 面因缺 `sandbox-exec` 早已整体 fail closed，此短路由 darwin-only guard 保护，今无可达路径。若将来跨平台沙箱（如 landlock/bubblewrap）接入，此两点须一并处理。

## 我的验证（macOS 本地，20dd7cd72）

- `qoder-agent-service.test.js` **82/82**（含新 unlink 探针：worktree 拓扑删 shared `logs/HEAD`=1 且字节不变；direct 拓扑删 `logs/HEAD`=1、正常 commit=0、reflog 存活）
- 其余四组 qoder **42/42**；api 包 `tsc --noEmit` 0；`pnpm run build` exit 0；biome 0 error；`git diff --check` 干净

诚实边界：无 CI 凭证，ubuntu lane 实跑仍待 push 后验证；Linux 绿只证明「套件能跑」，不证明沙箱不变量（Seatbelt 与 PATH guard 均 darwin-only，Linux lane 跑的是注入的 controlled runtime）——此边界 dsh 复审已声明，我认同。

## 设计取舍（dsh 重绑复审确认）

- `file-write-unlink` deny 是**故意的 append-only 语义**：受控面内 `git reflog expire` / `git gc` 的 reflog 清理会失败——受控面不需要这些路径，按设计取舍接受（reviewer 留档同意）。

## dsh 重绑 verdict（2026-09-17 05:31 UTC）

- **APPROVE（绑定 `20dd7cd72`，取代 `c55190f1b`）**；durable 绑定 `reviewSubjectRef=pr:08mamba24/clowder-ai#33`、`reviewedHeadSha=20dd7cd72…`（msg `0001789623416103-000282-30df00c3`）。
- 重绑证据：纯 amend 已证（两 SHA 同 parent `6498dabf1`，delta 仅 2 文件）；82/82（4 真 Seatbelt 用例）+ 42/42 + tsc/build/biome 0 error；**变异复现**——置空两处 `deniedWriteUnlinkRoots` → 两 darwin 用例 0 pass/2 fail（`rm logs/HEAD` 由 1 变 0），证明删除被拒确由新 deny 产生。
- 复审 note：`review-notes/2026-09-17-f317-pr33-round4-crossplatform-tests-rereview-dsh.md`（含重绑节）。

## push 指令更正（dsh P2，我已独立核实）

- **PR #33 的 head 分支是 `feat/qoder-controlled-tools`**（`git ls-remote --heads origin` 独立证实：该分支在远端 `6498dabf1`，远端无 `fix/pr33-round4`）。我初版指令 `git push origin fix/pr33-round4` 只会新建旁支、**不会移动 PR head**——错因：从本地 worktree 分支名推 push 目标，没核对 PR headRefName（push 目标是远端 PR 的属性，不是本地 checkout 的属性）。
- 正确且 FF 无需 force 的 push 行：
  `cd /Users/yuhan/cat-cafe/clowder-ai-wt-pr33-r4 && git push origin fix/pr33-round4:feat/qoder-controlled-tools`
- push 后核验：`git ls-remote origin refs/heads/feat/qoder-controlled-tools` 应 = `20dd7cd72…`；PR #33 head 逐字等于 APPROVED SHA。

## 下一棒

- operator：执行上面的 refspec push → 看 CI Linux lane 首跑 → 走 merge gate（作者侧不 self-merge）
- merge gate 后：round-4 todo 关闭；F317 后续是 Slice 2 collect.sh force-add 防护（operator 决策级，未分配）

## 收档（2026-09-17 09:04Z，merge 完成）

- operator push 后 head = `20dd7cd72`，CI **13/13 绿**（含 Linux lane 首跑——跨平台修复获最终实证）。
- merge 由 dsh-vision（非作者）执行：squash `8b617f2a2`，受门禁的树 == 落地树（`e1594a936` 逐字节一致）；全量门禁 CI-parity env 下 GATE PASSED（首轮 1/23633 红定位为既有 env artifact，与 PR 无关，见下一条毛线球）。
- round-4 **关闭**。我本地核实：`origin/main` = `5f8897e1a` → `8b617f2a2`，head 分支已删，fail-loud 桩与 `deniedWriteUnlinkRoots` 均在 main。

`[谱谱/glm-5.3🐾]`
