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

## 复审轮（砚砚，2026-09-20）

- **Round 1 verdict**: CHANGES_REQUESTED——P1：6 个 touched 文件 import 顺序未过 CI 强制门禁 `biome check --diagnostic-level=error`（`organizeImports` assist 不在 `biome format` 覆盖内，此前的验证漏了这一面）；P3：executor 两个新测试 `mkdtempSync` 未清理。功能面确认三条 maintainer finding 全部关闭（独立实跑 34/80/34/34、显式 false 保留、`'{}'` 不合成、sidecar 时序、remote-spike 独立判据合理）。
- **修复**: `12e3afc07e318cc6722b4f575ca0b9056a57d2ea`（父 = `7ed9de46b`，新增 commit 未 amend，7 文件 +50/−38）——biome safe-fix 定点整理 6 文件 import + 两测试补 `finally rmSync`。复验：repo 级 error 门禁 **8621 文件 0 error（exit 0）**、biome format 干净、tsc 三包 0 退出、executor 10/10 + 目标批 131/131 + shared 9/9。教训：format ≠ check——**今后 touched 文件的验证面必须含 `biome check --diagnostic-level=error`（与 CI 同一条命令）**。
- **Round 1 终审**: **APPROVED，无 P1/P2/P3**（砚砚 2026-09-20，机械 delta `7ed9de46b..12e3afc07`：仅 import 排序 + tmp 清理；全仓 8621 文件 exit 0、executor 10/10、worktree 干净；功能面沿用上轮已通过结论）。家内 review 闭环：分支 A 最终 exact HEAD = **`12e3afc07e318cc6722b4f575ca0b9056a57d2ea`**。

## Round 2（维护者 delta re-review `5260442223`，2026-09-20 11:16 UTC）

- **verdict**: CHANGES_REQUESTED，剩一条 P1——usable-credential parity **PARTIALLY FIXED**：helper 未实现 bound-principal 分支（`BOUND_CAT_ID` 指向的 identity 在 map 无条目时，helper 仍把无关可读 key / 未绑定 SECRET 算作凭证，真实 resolver 返回 null，stdio 仍暴露 80 工具应 34）；单 FILE 路径 helper 做 trim 而 resolver 按字面量读。31/31 原检查全过，新增 parity 检查 2 过 5 挂。
- **修复**: `00b6f21b2f603ee2307e05f07abda951b08c84b0`（父 = rebase 后 HEAD `4cb04f7e0`，未 amend，6 文件 +357/−53）。**结构性同源**：resolver 核心下沉 shared 为 `resolveAgentKeySecretFromEnv`，callback-tools 的 `resolveAgentKeySecret` 改为委托；availability 按分支全委托（bound 身份只认自己 map 条目；无绑定共享 map = 任一可选 identity 可解即算——维护者认可的正向；否则 SECRET 真值 → 单 FILE 字面路径）。SECRET 真值语义（空格保留）与单 FILE 不 trim 均与 resolver 对齐并在测试注明。
- **红证据归属**：维护者 fixtures（2 PASS/5 FAIL @ 4cb04f7e0）+ 点点独立复现表；自跑红不可行——修复本体就是新 shared 导出（旧 dist 无法加载委托 import），commit body 已如实说明。
- **回归**：shared 13/13（bound/归一化新行 + resolver 前置直接断言）；mcp-server 挂载级 parity 矩阵（`hasUsableAgentKeyCredentials` ↔ `getCallbackConfig({forceAgentKey:true})` 同断言，含 mismatch/own-entry/secret-only/padded-path/无绑定 map 三态）；executor bound 合成行；tool-registration 真 stdio spawn：bound 不可用 → 严格面（无 cross_post/teleport/schedule/verdict）。
- **验证**：mcp-server 凭证+注册批 194/194；全量 clean env **836/837**（唯一红 = #1493 lane regex 基线）；api 78/78；tsc 三包 0；全仓 biome error 级 8632 文件 exit 0；format 干净；`git diff --check` 干净。
- **本轮自我教训（已当场套用）**：新增 import 后先跑 `biome check --write` 再收工——round-1 的教训这轮差点再犯一次（自己新加的 import 又触发 organizeImports，check 阶段抓到后定点修复）。

## Round 3（维护者 review `5260508977`，2026-09-20 11:55:45Z，inline `4056879336`）

- **verdict**: CHANGES_REQUESTED，唯一 P1 = **round-2 修复自己引入的回归**：空白 SECRET 被重新算作可用（旧门禁 `SECRET?.trim()`；round-2 委托 resolver 后变成 truthy 判断，且两条负向断言被翻转跟随新语义——绿测试不关闭 finding 的教科书案例）。维护者同时确认前两轮 38 条检查全过、真实 stdio 不可用 bound 身份已是严格 34，并明确要求 **keep** shared-resolver 结构性同源修法。
- **修复**: `743cfc5232062cc3b9464ebbf69c4680e98db1c3`（父 = `00b6f21b2`，未 amend，5 文件 +68/−10）。`resolveAgentKeySecretFromEnv` 的 SECRET 分支改为 **trim 门禁 + 返回原值**（非空白 key 传输字节不变；空白 secret = 缺材料，HTTP header 传输归一为空值）；语义注释第 4 条同 commit 更新，杜绝口径与实现漂移。采纳点点 stance。
- **红证据（本轮自跑真红）**：先只还原两条负向断言、不动实现 → 当前 HEAD 精确红（shared 1 红 / mcp-server 1 红），再修再绿。
- **覆盖**：两条负向断言还原（注释写明传输归一依据）+ resolver 直接行（空白→undefined、非空白带空格→原样返回）+ 挂载级 parity 行（helper false 且 `getCallbackConfig` null）+ executor 行（空白 SECRET 不合成 / 带空格非空白保持）+ 真 stdio spawn（readonly+opt-in+空白 SECRET → 严格面）。
- **验证**：shared 14/14；mcp-server 凭证+注册批 193/193；全量 clean env **838/839**（唯一红 = #1493 lane 基线）；api 78/78；tsc 三包 0；全仓 biome error 级 exit 0；format 零修复；`git diff --check` 干净。
- round-2 毛线球 `0001789903731003-000226-c1743771`（维护者已确认 FIXED）：任务板为 owner-only 权限模型（点点实测 403 `Task is owned by another cat`），谱谱全部 carrier 均无 `cat_cafe_*` 工具与凭证（本 session epoch 5-19 均 carrier_unsupported，`~/.cat-cafe/agent-keys/` 无 zcode key）→ 无法自关，已请点点升级 operator 从任务板关闭；round-3 球 `…-000243-90e1c964` 按收口条件（push + CI 全绿 + 维护者确认）到齐后再关，现在关违反 P5。

## 下一步

球交 @砚砚 复审 round-3 delta `00b6f21b2..743cfc523`；APPROVED 后 @dsh-v41-flash push（exact HEAD `743cfc523`）→ 盯 CI → PR #1494 通报维护者复审。
