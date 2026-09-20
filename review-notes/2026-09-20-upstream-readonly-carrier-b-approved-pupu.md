# upstream #1454 救援 — 分支 B carrier 跨族 review APPROVED — 谱谱/glm-5.3

- **对象**: `fix/mcp-evidence-coverage-regex` @ `486241a87699d72e893fa3ecf56913124558c650`（基座 `upstream/main@9ab0eaf28`，单 commit，`packages/mcp-server/test/evidence-tools.test.js` 1 文件 +1/−1）
- **Verdict**: **APPROVED，无 P1/P2/P3 finding**（经 @zcode 送达；runbook §八 指定的跨族 reviewer）
- **链路**: operator 2026-09-20 01:33 UTC「动手」→ 工程完成（runbook）→ 跨族 review → 本 verdict

## Reviewer 独立验证（verdict 要点）

1. 相对同一基座 `9ab0eaf28` 仅把正则中的字面括号改为 `\(sacred\)`，断言意图与渲染文本一致。
2. `git diff --check` 干净；carrier 与分支 A（`fix/mcp-strict-readonly-union`）相互独立。
3. 在 exact HEAD 上重建 mcp-server 并独立复跑 `evidence-tools.test.js`：**31/31 通过**。
4. 结论：该小 carrier 不受分支 A 的 P1 阻塞影响，可按 runbook 单独推进。

## 谱谱本地复核（2026-09-20，verdict 后）

- HEAD 无漂移：`git rev-parse fix/mcp-evidence-coverage-regex` = `486241a87699d72e893fa3ecf56913124558c650`，与被审 SHA 逐位一致；commit 即 `test(mcp): escape literal parens in evidence coverage regex (pre-existing test bug)`，stat 1 file +1/−1。
- 未三跑测试：SHA 逐位一致 + reviewer exact-HEAD 复跑 31/31 + 上一 epoch 本地全量 794/794（runbook §二.3）已构成三重证据。

## 分支 A 状态

- Verdict 提及分支 A 存在 **P1 阻塞**；P1 详情在本 carrier 内不可恢复（`cat_cafe_*` MCP 工具目录缺失 + invocation callback 凭证缺失，仅 `event-memory` 可读且无聊天原文）。
- 已在最终回复行首 @砚砚 请求重发 P1 finding 原文；A 的修复 → 复审 → issue/PR A → 关 #1454 依次顺延。

## Operator 下一步（仅 B；GitHub 凭证按 2026-09-16 安全 review 归 operator 终端）

```bash
# 在 /Users/yuhan/cat-cafe/clowder-ai
git push origin fix/mcp-evidence-coverage-regex
```

开 PR B：<https://github.com/zts212653/clowder-ai/compare/main...08mamba24:clowder-ai:fix/mcp-evidence-coverage-regex>

**Title**: `test(mcp): escape literal parens in evidence coverage regex`

**Body**（paste-ready；已把 runbook §六 里悬空的 `#PR-A` 引用改为"companion carrier 随后"）：

> ## What
>
> One-line fix: escape the literal parentheses in the evidence coverage assertion regex.
>
> ## Why
>
> `/^\[matchType:direct\] Redis production Redis (sacred)$/m` treats `(sacred)` as a capture group, so it can never match the literal `(sacred)` in the rendered output — `evidence-tools.test.js` fails deterministically on current main (verified in isolation on a clean checkout: single file 30/31, only this assertion red; the regex mismatch is env-independent). Escaping makes the test assert its clear intent and the mcp-server suite goes green on main.
>
> Split out of #1454 per its review thread: unrelated pre-existing test bug, own carrier. A companion strict-readonly carrier will follow separately; landing this first keeps its CI green.
>
> ## Verified
>
> - Single file 31/31; full mcp-server suite on this branch 794/794; `biome format` clean.

## 执行面缺口（F223 备注）

本 carrier（zcode/glm-5.3）无 `cat_cafe_*` MCP 工具目录且无 invocation callback 凭证，`complete_a2a_dispatch` / `hold_ball` 不可调用；按 `/api/callbacks/instructions` 的 sanctioned fallback 走最终回复行首 `@` 路由。缺口已在此留痕。

## 共享状态

- 本 note 与 runbook 状态行更新 commit 到本地 main；`git push`（含 main 与分支）与 PR/issue 开立均等 operator 终端凭证，谱谱不持有 GitHub 凭证（2026-09-16 安全 review 禁止）。
