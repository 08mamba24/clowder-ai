# F280 hold_ball 503：owner fence 跨猫 @ 交接修复（删 targetCats 合取项）— 谱谱/glm-5.3

- 分支：`fix/hold-owner-fence-cross-cat-handoff`（worktree `clowder-ai-wt-holdfence`，base = `origin/main` `98a1858a1`）
- 上游：点点定罪档 `review-notes/2026-09-18-f280-hold-owner-fence-a2a-handoff-rootcause-dsh.md`（3/3 live 样本 + 机理证明），毛线球 `0001789660832109-000080-31e0f479`
- **性质：安全栅栏语义放宽**，按治理协议必须跨族 review（已交 @砚砚m）

## 根因（采信点点定罪，我独立复核代码）

`resolveHoldWaitOwnerFence`（`callback-hold-ball-routes.ts:382-403` 修前）四合取项之四：`!stored.targetCats.includes(record.catId)`。`parentInvocationId` 是**因果父**（产出触发消息的那次 invocation），父记录的 `targetCats` 记的是**触发父回合的猫**（上一跳），而断言拿它比对**子回合的猫**（下一跳的接球者）。@ 单猫交接时父回合属于传球者（`targetCats=["zcode"]`）、子是接球者（`catId="dsh-v41-flash"`）→ 恒 false → 503 `HOLD_OWNER_FENCE_UNAVAILABLE`。它只在退化自链上放行。**家里最常见的传球形态必 503**，canonical full gate 因此连续降级（PR #37/#38 两次）。

## 方向决策：②（删除该合取项 + 论证），① 与 ③ 不取

- **①（查派发记录）不取**：点点实测子 invocation 下无独立 a2a dispatch 键——要先补记录基建，成本前置；且新记录同样只是把"路由层已做过的裁决"换个地方再存一份。
- **③（显式跨猫合法分支）不取**：要正确校验"父的输出消息确实路由给了我"，需要消息级路由数据（消息 store 访问 + mention 解析复刻）——在 fence 里二次实现路由判定，正是这次 bug 的生成模式（用存储快照重推导上游真相，快照口径与真相漂移）。
- **②（删除）论证**——该合取项想挡的是"不是我的球我也能持"：
  1. **它查错了跳**：比较对象是上一跳的 targets，不是父输出的去向。一个不能区分"合法接球"与"抢球"、却在全部合法跨猫交接上拦截、在退化自链上放行的断言，不提供它声称的防护。
  2. **产权的真裁点在上游**：猫 invocation 只在被路由消息命中该猫时由系统创建——"球传给了我"由 invocation 创建（路由层）权威决定。fence 用错跳的存储快照重推导，制造了这类事故。
  3. **删除后的残余防护**：父记录存在 + 同 thread + 同 user（合取 1-3，全部保留）——会话域 scope 完整；action-successor lease 继承仍要求父记录显式携带 carrier。
  4. **风险面**：若 invocation 管线出现跨猫错挂 parent 的 bug，fence 不再按猫拦截——但该场景要求管线级 bug，且后果限于同 thread/user 内的 custody 混淆（可观测、可恢复），严格小于现状（canonical gate 载体对全部 @ 接球猫 100% 不可用）。

## 改动

- `resolveHoldWaitOwnerFence`：删第 4 合取项，错误信息不变；函数内注释完整记录事故与论证（含诊断档引用）
- `callback-hold-ball-wakewhen.test.js` 新增 3 用例：跨猫交接 → `containing_task`；跨猫交接 + 父带 action lease → `action_successor` 继承（custody 连续性，F280 本意）；异 user 父 → 仍拒

## 红→绿与回归（macOS 本地，base 98a1858a1，正规 build 后对 dist 实跑）

- **红（修前 dist）**：两个跨猫用例红（`["zcode"].includes("dsh-v41-flash")` 路径精确复现事故），既有 2 例 F280 与异 user 用例绿
- **绿（修后）**：wakewhen 全文件 **23/23**（原 20 + 新 3）；callback-hold-ball 家族（route / counter / route-scheduling / wakewhen-environment / c1-sample / ball-custody-hold-events）**27/27**；ball-custody invocation-events **3/3**；`tsc` 0 error；biome 改动文件 error 级 0（2 条 complexity 警告与 main 基线同数同位，零新增）；`git diff --check` 干净；`pnpm install --frozen-lockfile` 零漂移

## 验收判据（合入 + 重启后）

跨猫 @ 接球的猫调用 `cat_cafe_hold_ball({wakeWhen})` 返回 200（不再 503），canonical full gate 恢复猫 CLI 可用。live 生效需走 runtime 同步 + 重启窗口（operator 授权，ADR-039）。

## 下一棒

@砚砚m 跨族 review（安全栅栏语义放宽，论证在上方「方向决策」节，可直接挑战）；approve 后走代推通道。另：点点本地有一笔未推 commit `bbf12e339`（定罪诊断档），可随本 PR 一起代推或单独走。

`[谱谱/glm-5.3🐾]`
