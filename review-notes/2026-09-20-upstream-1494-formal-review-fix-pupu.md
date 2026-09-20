# upstream #1494 formal review 三条 finding 修复 — 谱谱/glm-5.3

- **分支**: `fix/mcp-strict-readonly-union`，修复 commit `7ed9de46bb4e7c8887229b7afa95bb7071d4cd23`（父 = 被 review 的 `d1f8d6b0b380184348b68d4997acc09134ee1219`；新增 commit，未 amend/force）
- **来源**: 维护者 zts212653 CHANGES_REQUESTED（2026-09-20 08:09:40Z，P1×2 / P2×1）；点点逐条核源码后派修（毛线球 `0001789891992618-000203-7c3fd40f`，owner 谱谱）

## Finding → 修复映射

| # | 位置 | 根因 | 修复 |
|---|---|---|---|
| P1-1 | `McpToolExecutor.ts` `buildMcpEnv` | 任一 agent-key 变量非空即写死 `UNION='true'`，覆盖显式 `false`/`''`/`'TRUE'` | 仅当开关**缺席**且凭证**可用**才合成；显式值原样保留（`false` = 严格只读） |
| P1-2 | `mcp-config-adapters.ts` 合成判据 + `server-toolsets.ts:57` + `callback-tools.ts` `hasAgentKeyCreds` | 「变量非空」≠「凭证可用」：`'{}'`/坏 JSON/空路径/不存在 sidecar 全算有凭证 | 权威语义从 callback-tools 抽到 `@cat-cafe/shared/utils` `agent-key-credentials`（FILES 非空即唯一来源不回落 → SECRET 非空 → FILE 读到非空内容）；**四处决策点全部接线同一基线**（server 判据、executor、adapters 合成、rich-block 路由），callback-tools 本地实现改为 re-export |
| P2 | `server-toolsets.ts` 五族 | `registerTools(server, buildXTools(env))` 缺第三参 → 重新 `parseToolsetEnv()` 读 `process.env`，parse-once 不成立 | 六族全部 collab 范式：`const e = env ?? parseToolsetEnv()` 贯穿 selection 与 registration |

## 点点两条前置约束的结论（均已写进 commit body）

1. **Sidecar 时序**：api 启动在 `index.ts` ~L794 `ensureAntigravityAgentKeySidecar` 落盘 sidecar 并设置 `CAT_CAFE_AGENT_KEY_FILES`，`regenerateStartupCliConfigs` 在 ~L6816 —— 配置写入时文件必已存在，两个合法 antigravity 并集消费者行为不变。
2. **第五处判据**：`remote-spike.ts` cloud-pro-phase0 启动校验器语义更严（FILES map 强制、SECRET-alone 拒绝）且不发放任何东西——不同决策，判定不改，理由在 commit body。

## 维护者四条验收口径 ↔ 测试编码（`agent-key-credential-usability.test.ts` + executor/adapters 测试）

- strict ambient-secret mount（无 opt-in）→ READONLY ∪ limb（集合精确断言）；
- 显式合法 opt-in + 真实 sidecar → READONLY ∪ AGENT_KEY ∪ limb（含 `cross_post_message`）；
- 显式 opt-in + `_FILES='{}'` → 严格面（红→绿）；
- `registerFullToolset(server,{readonly:true})` + ambient 非法 profile → 不抛（红→绿）；
- executor 显式 `false`/`''`/`'TRUE'` 三态保留 + 不可用凭证负例（红→绿）。

## 证据（Node 24，先红后绿）

- 红阶段：mcp-server 新测试 6 红（假路径/`'{}'`/无回落 parse 行、opt-in+`'{}'` 挂载行、parse-once 抛出行）、api 3 红（executor 覆盖与不可用 map、writer `'{}'` 合成）——与三条 finding 一一对应；正例守卫全程绿。
- 绿阶段：shared vitest 新模块 9/9；mcp-server 目标批 126/126；api `mcp-config-adapters` + executor 72/72、兄弟 executor 套件 5/5；**mcp-server 全量 clean env（真实 HOME + 清洗 CAT_CAFE_*）810 tests / 809 pass，唯一红 = 既有 evidence coverage regex（#1493 lane，未折入）**；tsc 三包 0 退出；biome 14 文件干净；`git diff --check` 干净。
- shared 全量 vitest 的 2 个 dossier 红在主仓（无本改动）同样复现——基线既红，与本 delta 无关。
- Fixture 现代化（仅限把旧语义写成断言的测试）：`desktop-mode`「detects agent-key via any of the 3 env vars」改写为可用性断言；`tool-registration` / `callback-tools.test.js` 两处 rich-block / adapters sidecar 测试改用真实落盘 sidecar。

## 下一步

球回 @dsh-v41-flash：push 前独立复跑四条口径（不采信本自述）→ push 分支 A 新 HEAD → 盯 CI → PR #1494 回帖通报维护者复审 delta。
