# upstream #1454 救援终局 — 双 PR 合并，任务闭环 — 谱谱/glm-5.3

- **记录动机**: #1493 的合并无人落盘（共享 notes 中 #1493 最新记录停在 2026-09-20），补齐任务终态（W4/P4）。本 note 证据全部来自 2026-09-28 13:57 UTC 后的 GitHub 公开 API 实查。

## 终局状态

| 事项 | 状态 |
|---|---|
| PR #1494（strict-readonly，原分支 A） | **MERGED 2026-09-20 16:35:15Z** @ `743cfc523`（含全部四轮修复） |
| Issue #1492（readonly 扩面报告） | CLOSED 16:35:16Z（随 #1494 合并自动关闭） |
| PR #1493（evidence regex，原分支 B） | **MERGED 2026-09-27 15:28:31Z** @ `9bcc921e2`（09-22 纯重放到 main@36b5eeabe 后的 HEAD） |
| Issue #1495（regex 测试 bug） | CLOSED 15:28:32Z（随 #1493 合并自动关闭） |
| 原 PR #1454 | 2026-09-20 已按维护者整改门槛关闭（superseded by #1493/#1494） |

## 时间线要点（谱谱视角）

- 09-20 01:33 UTC operator「动手」→ 双分支重建 → 跨族复审双 APPROVED → 点点执行 push/issue/PR。
- #1494 历经维护者三轮 formal review（三轮 5 条 finding 全部修复：executor 显式开关覆盖、可用性语义、parse-once、bound-principal parity、空白 SECRET 回归）+ 家内砚砚两轮 delta 复审 → 维护者 14:4x LGTM（COMMENTED 形态）→ 16:35 合并。
- #1493 单行 regex carrier：等待期两次随 main 推进纯重放（patch-id 不变）→ 09-27 维护者 comment review → 15:28 合并。
- 三条修复毛线球已由 operator 从任务板关闭（本轮活跃列表已无）。

## 方法论回流（W5，供家里复用）

- 「变量非空 ≠ 凭证可用」的边界修复，终态是** resolver 核心下沉 shared、availability 全分支委托**——parity 不是补齐判据清单，而是消灭第二份实现（P4）。
- 维护者多轮 review 的生存法则：exact-HEAD 绑定、不 amend 留 delta、红先绿后且红必须可自跑（round-2 的「红不可自跑」豁免在 round-3 被合理拒绝）、**测试跟着契约走而不是跟着实现走**（round-3 回归的直接教训）。
- 验证面必须与 CI 完全同一条命令（`biome check --diagnostic-level=error`，round-1 教训）；跨包改动先重建 dist 再测（点点预检兜住的假红）。
