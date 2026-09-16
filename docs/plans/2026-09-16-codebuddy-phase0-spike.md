---
related_features: [F050, F161, F317]
topics: [codebuddy, acp, cli-integration, authentication, phase0]
doc_kind: spike
created: 2026-09-16
---

# CodeBuddy Phase 0 Spike: 双通道协议采样与认证门验证

> **Status**: pre-auth evidence summarized / auth-gated · **Owner**: 谱谱 (zcode, glm-5.3) · **创建**: 2026-09-16
> **任务球**: `0001789527368947-000043-eaf24cb0`（砚砚立球）
> **边界**: 只采样不改生产 registry、不搬用户凭据、不复制 Qoder 专属假设（Qoder F317 见 `2026-09-13-f317-qoder-phase0-spike.md`，独立提案另文）

## Why

评估 CodeBuddy（腾讯 `@tencent-ai/codebuddy-code`）作为家里新 coding 成员 / fallback provider 候选。上轮断点（2026-09-16 01:51 UTC）为 stream-json 采样 `exit=0` 但 `result.subtype=error_during_execution`，本轮从该断点续跑，补齐 stream-json 与原生 ACP 双通道脱敏证据，并定位认证门的精确形状。

## 已验证事实（全部一手采样，2026-09-16 02:5x UTC）

### C1 · CLI 面

- 入口 `/opt/homebrew/bin/codebuddy`（homebrew，`@tencent-ai/codebuddy-code`），**v2.151.0**，alias `cbc`
- 双通道都在：`--output-format stream-json`（+`--input-format stream-json` 双向、`--include-partial-messages` SSE 直通）与 **原生 `--acp`**（ndJsonStream；`--acp-transport stdio|streamable-http`）
- 隔离面存在：bundle 内实测 grep 到 **`CODEBUDDY_CONFIG_DIR`** env（与 Qoder 的 `QODER_CONFIG_DIR` 同构机制）；`--setting-sources user,project,local` / `--settings <file>` / `--strict-mcp-config` / `--tools` / `--allowedTools` / `--disallowedTools` / `--permission-mode` 全套
- 卫生面：`--no-session-persistence`、`--max-turns`、`--autocompact`、`-H` 自定义 header、`--sandbox container|E2B`、`install [target]` 版本 pin、`doctor` 自更新健康检查
- 多供应商路由表（`--model`）：alias `default/fast/balanced/primary/deep-model` + `gpt-5.6-sol/terra/luna`、`gpt-5.5`、`gpt-5.4`、`gpt-5.3-codex`、`gemini-3.5-flash`、`glm-5.3`、`glm-5.2`、`kimi-k3`、`kimi-k2.6`、`minimax-m3`；另有 `--fallback-model`（print 限定）原生回落链
- 产品变体：`product.internal.json` / `product.cloudhosted.json`（与认证方法 internal/selfhosted 呼应）

### C2 · stream-json 通道（未认证态）

采样命令：`codebuddy -p "…" --output-format stream-json`（本机临时产物 `/tmp/cb-l1/green.json`，6 帧；不是 canonical fixture，长期证据须由 H2 的脱敏夹具闭合）：

| 帧 | 字段要点 |
|---|---|
| `system/init` ×2 | `apiKeySource:"www.codebuddy.ai"`、`model:"default-model"`、`permissionMode:"default"`、`mcp_servers`、`slash_commands`、**56 个内置 tools**（含 WeChatReply/WeComReply/PushNotification/ImageGen/VideoGen/ComputerUse/Team*/Cron*/LSP 等） |
| `system/status` / `file-history-snapshot` | 常规生命周期帧 |
| `assistant` | 文本内容 = `Authentication required. Please use /login command to sign in to your account` |
| `result` | `subtype:"error_during_execution"`、`is_error:true`、`errors:[…]`、`usage` 全 0、`total_cost_usd:0`、`modelUsage.default-model{contextWindow:176000, maxOutputTokens:24000}`；**进程 exit=0**（错误在协议层不炸进程） |

### C3 · 原生 ACP 通道（ndJsonStream，未认证态）

采样命令：`codebuddy --acp --no-session-persistence`，ACP `initialize` → `initialized` → `session/new` → `session/prompt`（本机临时产物 `/tmp/cb-l1/acp/raw-frames.json`；不是 canonical fixture，长期证据须由 H2 的脱敏夹具闭合）：

- **`initialize` 免认证成功**：`protocolVersion:1`；`agentCapabilities`：`promptCapabilities{image,embeddedContext}`、`mcpCapabilities{http,sse}`、`loadSession:true`、`delegateToolsSupport:true`、`mainAgentSupport:false`、`multitaskSupport:true`
- **`authMethods` 四法**（initialize 即暴露）：`iOA`（腾讯 SSO）/ `external`（Google/Github）/ `internal`（WeChat）/ `selfhosted`（Enterprise Domain）
- `session/new` → 结构化错误 `{"code":-32000,"message":"Authentication required","data":{"category":"auth"}}`（**结构化 auth 错误，非崩溃**）
- `session/prompt`（伪 sessionId）→ `-32603 Session not found`；SIGTERM 干净退出
- 语义推论：**auth 门是 ACP 协议一等公民**（错误带 category、方法表带 authMethods），接入侧可做结构化处理；ACP `authenticate` 方法本轮未探测（P0.5 项）

### C4 · 认证与隔离门（当前红线）

- 本机（含我的 spawn 环境）**未登录**：`codebuddy login status` → 同一 auth-required 文案；两通道在上游同一点汇合（**12:5x 修正：凭证仓库实际在 `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/`，认 HOME——本条当时以 CONFIG_DIR 视角的推断见下方 Phase 0.5 终判**）
- HOME 分离实测：我的沙箱 HOME（app-server-home）与 operator 真实 `~/.codebuddy`（有 history/projects/sessions/settings.json，operator 本人在用）是两棵树 → **默认 spawn 看不到 operator 登录态 = 天然隔离**，专用 `CODEBUDDY_CONFIG_DIR` 预登录是可复用的设计（同构 Qoder S3，但须独立重验，不搬结论）
- `apiKeySource:"www.codebuddy.ai"` 暗示 API-key 认证路径可能存在（`-H` 自定义 header 也支持）→ P0.5 验证，若成立可走 F161 env-map `${api_key}` 模板，连 OAuth 交互都省掉

## Phase 0.5 收尾门禁（operator 登录后，进入实现的前置）

> **2026-09-16 12:5x H1 终判：绿（经一轮误判修正，谱谱，一手采样）。**
> 登录**真实完成**：凭证文件 `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info`（明文 JSON、0600、含 accessToken/refreshToken，token 12:19:37 刷新、长效有效）。operator 交互 TUI 正常对话、headless 注入后正常对话，均为一手验证。
> **认证注入面 = `HOME`，不是 `CODEBUDDY_CONFIG_DIR`**：bundle 源码 `getAuthSavePath()=join(sharedDataPath,"auth",authId+".info")`，`sharedDataPath=homedir()/Library/Application Support/CodeBuddyExtension/Data/Public`。`CONFIG_DIR` 只管 settings/plugins/marketplace 等配置树，**不管凭证**。
> 12:3x 第一轮误判（红）的根因：①把 `CODEBUDDY_CONFIG_DIR` 当凭证注入面（Phase 0 C4 的同构假设不成立）；②把 12:18-19 的 TUI 启动副作用误读为"登录痕迹"（这半边结论仍对——那些确实不是登录产物；真登录产物在 Application Support，12:19:37 刷新）。
> 12:24 `login status` 之谜的解释：那次是 TUI 派生的 headless 子进程（日志 `print:true, socketRemoteAddress:127.0.0.1`），子进程凭证策略为内存态（`CODEBUDDY_CREDENTIALS_IN_MEMORY`），不读文件凭证 → 报 auth-required。交互 TUI 靠进程内存会话继续工作，形成"同机一登录一未登录"的分裂表象。
> **Phase 1 隔离设计影响（重要）**：专用 `CODEBUDDY_CONFIG_DIR` **不足以**隔离凭证；要隔离必须专用 HOME（重）或走 `CODEBUDDY_AUTH_TOKEN` env（bundle 里该 storage 优先级最高，条件仅 `process.env.CODEBUDDY_AUTH_TOKEN` 存在——比 OAuth 更适合 F161 env-map）。
> **认证态双通道最小采样已通过（12:41-12:45）**：
> - stream-json（HOME 注入）：`result.subtype=success`、回复 `ok`、`total_cost_usd:0`、`modelUsage` 全 token 字段；
> - 原生 ACP：initialize（protocolVersion 1，authMethods 四法）→ session/new 成功 → session/prompt 回复 `ok`、`stopReason:"end_turn"`；update 词表实测：`config_option_update` / `available_commands_update` / `session_info_update` / `usage_update` / `agent_thought_chunk` / `agent_message_chunk` + 非标准扩展帧 `_codebuddy.ai/command`；
> - 计费（H3 部分）：`usage_update._meta["codebuddy.ai/usage"]` 带 `credit` 字段（本次调用 `credit:0`）+ `usageByCategory`（systemPrompt/conversation/tools/mcp/skills）——**credits 制确认**，账户级余额待查。
> 副作用披露：HOME 注入的采样会写 operator 真实 `~/.codebuddy`（user-state/sessions/trace，`--no-session-persistence` 不覆盖）；本轮还触发了一次凭证文件刷新（12:44 mtime，token 轮换属正常 refresh 生命周期）。正式 fixture 采样应改用专用 HOME + 复制凭证或 env-token 路线。

| # | 任务 | 验收 |
|---|---|---|
| H1 | operator 选定 authMethods 四选一完成登录 | 登录态可被 headless spawn 复用 · **状态：绿——凭证在 Application Support（认 HOME），HOME 注入复用成功；`CODEBUDDY_CONFIG_DIR` 非凭证面（见上）** |
| H2 | 认证态双通道重采：`session/new`+`session/prompt` 全帧、`session/update` 形状、tool_call 形状、stopReason 词表、cancel 夹具；**+ MCP 注入面探针（2026-09-16 补，dsh-v41-flash 指出）：`session/new` 带非空 `mcpServers` 观察收/拒收/忽略——Phase 0 全帧零提及 `mcpServers`，此项完全未测** | 脱敏 golden transcript 入 `packages/api/test/fixtures/codebuddy/` + manifest；**mcpServers 行为结论落字：收 → F161 纯配置成立；拒收 → `omitSessionMcpServers`（弃家里 MCP 面）或 bootstrap+overlay 量级（DSH 前例：官方 demo 拒非空 → `dsh-acp-bootstrap.ts` 287 行）** |
| H3 | 计费语义：token/credit/订阅？一次真实调用的账面 | 结论 + 风险标注（Qoder 是 credits 制，此项**不预设**） |

### H3 计费证据汇总（2026-09-16，谱谱实测 + 瞳瞳本地读图）

- **服务端逐调用计费字段**：ACP `usage_update._meta["codebuddy.ai/usage"]` 带 `credit` 字段，hy4-preview-f 最小调用实测 **`credit: 0`**（服务端自报，当前最硬证据）。
- **CLI `/stats` 两页（Overview/Models，14:00 CST 截图，瞳瞳 macOS Vision 全本地 OCR）无任何费用/费率/credits/free UI**——CLI 侧只有用量：5 sessions、24.9k tokens（In 24.8k/Out 110）、Hy4 preview 占 100%。
- **⚠️ 用量归属**：上述 24.9k tokens / peak 13:00-14:00 CST 大概率主要是谱谱 12:18-12:45 的登录+采样流量，不代表 operator 日常用量。
- **账户侧（operator 截图，WorkBuddy 桌面客户端"套餐与积分"，产品归属为 operator 口述、图内无标题栏）**：体验版；总剩余积分 785.39 = 套餐基础 500（已用 0/500，2026/10/01 刷新）+ 平台奖励 300（已用 **14.61**，2026/09/22 10:04 到期）+ 购买 0。
- **判别实验 + 对账闭环（2026-09-16 15:1x-15:2x CST，H3 关闭）**：operator 指路"用不免费的模型对照"后，同口径最小调用（"Reply with exactly: ok"，ACP 通道，HOME 注入）三组实测——**hy4-preview-f：`usage.credit = 0`（免费期实锤，server 自报）**；**deepseek-v4.1-flash：`credit = 0.67`**（23,465 tokens）；**glm-5.3：`credit = 2.48`**（22,684 tokens，≈ ds41 的 3.7 倍）。`usage_update.cost.amount` 与 `usage.credit` 同值，**计价单位即积分**（与 WorkBuddy 积分面板同币种）；粗费率（单样本、completion 极小、cached=0）：ds41 ≈ 0.029 积分/1k tokens，glm-5.3 ≈ 0.109 积分/1k tokens，hy4-preview-f = 0。**面板对账**：operator 实读平台奖励积分 285.39 → **282.01**（Δ3.38），协议侧两次计费调用合计 **3.15**，预测 282.24 vs 实读 282.01，**残差 0.23（≈7%）**；残差归因已排除 operator 的 clowder-ai TUI 会话（其 `/cost` 自报 hy4-preview-f 0 计费，转录核实），候选为桌面端后台用量 / 计费粒度取整，量级不影响结论，不追。**H3 关闭。**
- 附注：本机时区 CST +0800；hub 消息时间戳为 UTC，两处差 8 小时。
| H4 | 提权红→绿：project/local settings hook、`--setting-sources` 阻断、`--tools`/`--permission-mode` 断言、禁 `-y`/`auto`/`bypassPermissions` | 红先行记录 + 绿证据（同 Qoder S5 方法论，**全部重跑不搬结论**） |
| H5 | 版本漂移防线：spawn 路径不自更新实证（homebrew 自动更新 vs `install [target]` pin） | 复现脚本 + pin 方案 |
| H6 | 进程卫生：prewarm/daemon socket 残留行为（本机已见 `codebuddy-prewarm-wb-pool-*.sock`） | spawn 生命周期内无孤儿进程结论 |

## 出口条件

- **operator 决策（2026-09-16 15:31 CST，三题已拍）**：
  - **D1 = a 新猫成员**（占 roster 位；命名/头像/故事另走共创流程）；
  - **D2 = 默认模型直接 hy4-preview-f，禁止静默换模**——不得配 `--fallback-model` 自动链，模型变更只经 operator 显式指令（实证注意：无 settings 的隔离环境默认回落 `hy3`，故 variant 必须显式 `--model hy4-preview-f`；已测请求 `requestModelId` 忠实透传）；
  - **D3 = a `CODEBUDDY_AUTH_TOKEN` 环境变量路线**，且**已端到端实证**（15:3x CST）：仅注入 env token、沙箱 HOME、`CODEBUDDY_CREDENTIALS_IN_MEMORY=1`，最小调用 `subtype=success` 回复 `ok`，沙箱 Application Support 无凭证残留——隔离成立，凭证面最小。token 取自凭证文件 `auth.accessToken`（JWT，~1.5k 字符）；注意：该次实测在无 settings 环境跑在 `hy3`（默认回落），账面影响未单测，视为小于 1 积分级。**token 生命周期**：accessToken ~57 天 / refreshToken ~87 天（凭证文件 `expiresIn/refreshExpiresIn` 实测值），到期前需从凭证文件重取或 operator 重登录续期——Phase 1 落"到期提醒"而非自动刷新。
- H1-H6 全绿 → 按 `2026-09-16-codebuddy-phase1-proposal.md` 走 F161 配置路径立项
- 任一 P1 红（认证不可隔离 / ACP 行为与 hub 期望不达 / 提权防线破）→ 停止，落 lessons

## 复现命令

```bash
codebuddy -p "reply with exactly: ok" --output-format stream-json          # C2（未认证态）
# ACP 握手见 /tmp/cb-l1/acp/raw-frames.json 的驱动脚本；登录态采样待 H1
```
