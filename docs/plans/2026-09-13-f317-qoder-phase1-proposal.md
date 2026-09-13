# F317 Phase 1 提案: qodercn CLI 正式接入

> **Status**: proposal（待砚砚 + 点点 review）· **Owner**: 谱谱 (zcode/glm-5.3) · **创建**: 2026-09-13
> **前置**: Phase 0 spike `2026-09-13-f317-qoder-phase0-spike.md`（S1–S4/S7 绿）+ 双猫协议复核（砚砚 4 P1、点点 5 P1，均已合并进本文）

## Why

qodercn（Qoder 中国版 CLI，`@qodercn-ai/qoderclicn@1.1.51`）headless spawn 已验证可行，事件形状与 Claude Code 大面积兼容，接入成本低于 Kimi/Gemini 先例，可作为家里新 coding 成员。

## 复核合并结论（方向的共识基础）

**骨架保留、方言层独立、S4/S5/S6 补夹具落仓、usage 走 credits。**

核心修正（点点实测，probe 原始 transcript 在 `/tmp/qoder-probe/*.jsonl`）：「同构」只成立一半——事件形状兼容（绿），但**直接复用 `claude-ndjson-parser` 不成立（红）**，需要 Qoder 方言层。

### P1 清单（Phase 1 必须全部处理）

| # | 来源 | 问题 | Phase 1 对策 |
|---|---|---|---|
| P1-A | 点点 | `stream_event` 部分消息完全不存在（help 无 `--include-partial-messages`）→ F153 agent_loop 遥测、context health `lastTurnInputTokens`、partialText 去重全部死路径 | 方言层显式声明「不支持 partial」：agent_loop 计数降级为 assistant 事件近似；`lastTurnInputTokens` 不设置并在 context health 标注数据源缺失 |
| P1-B | 点点 | result.usage token 字段全 0；真账是 `total_credits` + `usage.context_usage_ratio`；`modelUsage` camelCase；`contextWindow: 0` 会穿透 `!= null` 判断污染 `contextWindowSize` | usage 提取走 credits/`context_usage_ratio`；`contextWindow` 加 `> 0` 守卫；**authoritativeUsage 不得宣称 true**（砚砚） |
| P1-C | 点点 | MCP status 词汇 `disconnected` 不在 `CLAUDE_MCP_STATUSES`；qoder 自带插件 MCP（`plugin:qoder-context`）默认出现在 mcp_servers | 方言层映射 status 词表；S6 实测 strict 过滤该插件 |
| P1-D | 点点 | 错误路径难触发：无效 `-m` 被**静默回落 Auto** 成功返回 | spawn 后在 init 事件断言实际 `model` 与请求一致；错误夹具用权限拒绝/禁工具构造，不用无效模型 |
| P1-E | 点点 | qoder 独有事件被丢弃：`system/hook_*`、`artifacts_update`、`context_management` | 方言层解析并透传；`context_management` 作为 F296 `compact_boundary` 的 qoder 对应物接入 |
| P1-F | 砚砚（点点转述） | cat-template.json 不得直写 | 新成员条目走本提案 PR 一次变更 |
| P1-G | 砚砚（点点转述） | authoritativeUsage 语义 | 见 P1-B |
| P1-H | 砚砚（点点转述） | 实施顺序 | 见下方 Phase 切分 |

> 砚砚 4 P1 中另有 1 项由其本人在 review 时补充指认，落 review 记录。

## What（Phase 1 交付物）

1. **`qoder-ndjson-parser.ts`**（独立文件，不改共享 `claude-ndjson-parser`——后者有 4 个消费方，参数化 blast radius 过大；循 Kimi/Gemini/OpenCode 独立 parser 先例）
   - 复用 Claude 同构块：assistant text/thinking/tool_use、user tool_result、result 成功路径、session_id
   - 方言点：usage 走 credits + `context_usage_ratio`（P1-B）；status 词表映射（P1-C）；独有事件透传 + `context_management`→compact_boundary（P1-E）；partial 显式不支持（P1-A）
   - 按 init 的 `protocol_version`（实测 1.4.0）+ `qodercli_version` 做版本断言与漂移告警
2. **`QoderAgentService.ts`**：仿 `ClaudeAgentService`，spawn 固定 `~/.local/bin/qodercn` + `--config-dir /Users/yuhan/.qoder-cn`（S3 教训：app-server HOME 与用户 HOME 两套）+ `-o stream-json`
3. **安全硬编码**：permission mode 禁 `bypass_permissions`/`auto`/`--dangerously-skip-permissions`；断言 init.permissionMode 与请求一致；断言 init.model（P1-D）；MCP 双层 allowlist（`--strict-mcp-config` + `--allowed-mcp-server-names` 只开 `cat-cafe-memory`）；`--tools ""` 禁全部内置工具（qoder 内置 Bash/Write/Edit/WebFetch/WebSearch/ImageGen/VideoGen 是独立于 MCP 的危险面）
4. **clientId 新增 `qoder`**：注册进 AgentService 工厂
5. **`cat-template.json` 新成员条目**：随本提案 PR 一次变更，不直写
6. **S4 夹具落仓**：8 类脱敏 golden fixture（成功/工具调用/tool_result/错误/权限拒绝/resume/cancel/压缩）→ `packages/api/test/fixtures/qoder/`，以 `/tmp/qoder-probe/*.jsonl` 为底补采

## Phase 1 前置门禁（spike 收尾，谱谱执行）

- **S5（升级版）**：恶意 settings 负向测试必须覆盖 **hooks/plugins 注册面**（SessionStart hook 实测会执行任意命令 = 代码执行入口），不能只测 permission override；断言 `--setting-sources` 受控下 project/local settings 被忽略
- **S6（升级版）**：strict 下 `plugin:qoder-context` 不出现；`--tools ""` 生效验证
- 任一红 → 停止，不进 Phase 1

## 出口条件

- 双猫 review 通过（砚砚：架构/门禁；点点：协议/解析，按其 P1 清单逐项核）
- 夹具驱动测试全绿；S5/S6 红绿记录落 spike 文档

## 边界

- CodeBuddy 是独立提案，不混入 F317
- 第三方 `opencode-qoder-bridge` 不作终态
- 计费为 credit 制（一次 ok 调用 ~1.15 credits），额度耗尽行为待长期观察，计入运行时告警项
