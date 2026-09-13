# F317 Phase 1 提案: qodercn CLI 正式接入

> **Status**: proposal r2（按点点 05:08 UTC review 修订；待砚砚（9 项架构侧）+ 点点复审）· **Owner**: 谱谱 (zcode/glm-5.3) · **创建**: 2026-09-13 · **r2**: 2026-09-13
> **前置**: Phase 0 spike `2026-09-13-f317-qoder-phase0-spike.md` + 双猫协议复核（砚砚 9 项架构侧、点点 5 P1 + 复审收紧，均已合并进本文）
> **r1 review**: 点点 CHANGES REQUESTED（协议侧逐项核对，证据源 `/tmp/qoder-probe/{stream,tooluse,err}.jsonl` + 源码）；砚砚 CHANGES REQUESTED（9 项，点点交叉验证 #3/#5/#6/#7 无异议）

## Why

qodercn（Qoder 中国版 CLI，`@qodercn-ai/qoderclicn@1.1.51`）headless spawn 已验证可行，事件形状与 Claude Code 大面积兼容，接入成本低于 Kimi/Gemini 先例，可作为家里新 coding 成员。

## 复核合并结论（方向的共识基础）

**骨架保留、方言层独立、S4 夹具补采为收尾门禁、usage 走独立 billing metadata。**

核心修正（点点实测）：「同构」只成立一半——事件形状兼容（绿），但**直接复用 `claude-ndjson-parser` 不成立（红）**，需要 Qoder 方言层。

### P1 清单（Phase 1 必须全部处理）

| # | 来源 | 问题 | Phase 1 对策（r2 修订处标 ★） |
|---|---|---|---|
| P1-A | 点点 | `stream_event` 部分消息不存在 → F153 agent_loop 遥测、`lastTurnInputTokens`、partialText 去重死路径 | ★ 删除「assistant 事件近似」方案（实测 assistant 行数 ≠ LLM 调用数：thinking 与 tool_use 分行走同一 `chatcmpl-*` id，按行数 double count）。改为二选一，交 F153 语义 owner 裁决：(a) 按**去重 `message.id` 计数**（协议内真实边界，实测 == `result.num_turns`）发 `agent_loop`；(b) 不发。`lastTurnInputTokens` 不设置并标注数据源缺失 |
| P1-B | 点点+砚砚 | result.usage token 字段全 0；真账是 `total_credits` + `usage.context_usage_ratio`；`modelUsage` camelCase；`contextWindow: 0` 穿透 `!= null` 污染 `contextWindowSize` | credits **进独立 typed billing metadata，不进 `TokenUsage`**；`context_usage_ratio` 只作带 provenance 的比例观测；`contextWindow` 加 `> 0` 守卫；authoritativeUsage 不宣称 true |
| P1-C | 点点 | `disconnected` 不在 `CLAUDE_MCP_STATUSES`；共享 `normalizeClaudeMcpStatus` 对未知值静默丢弃 → 整个 MCP snapshot 消失；qoder 自带 `plugin:qoder-context` 默认出现 | 方言层在**进入共享提取器之前**完成 status 映射，映射目标写死为 `failed`；夹具保留一条 disconnected server 守卫；S6 实测 strict 过滤该插件 |
| P1-D | 点点 | 无效 `-m` 静默回落 `Auto` 且 `result.is_error=false` | init 断言 model；★ 加规则：**`Auto` 必须是显式选择**——显式 Auto 与静默回落的 init 同为 `Auto`，故未显式配置 Auto 时 init.model=Auto 一律判失败。断言必须在处理**首个 assistant 事件之前**执行（实测 hook 事件先于 init，init 不是第一行）。`err.jsonl` 落为第 9 类负向夹具 |
| P1-E | 点点 | 独有事件被丢弃：`system/hook_*`、`artifacts_update`、`context_management` | `hook_*`/`artifacts_update` 解析+透传；★ `context_management` 仅解析透传，**不接 `compact_boundary`**——compaction union 只有 claude/codex，且三份 transcript 该字段全为 `null`，无真实压缩事件前不得接线 |
| P1-F | 砚砚 | cat-template.json 不得直写 | 新成员条目走本提案 PR 一次变更 |
| P1-G | 砚砚 | 实施顺序 / authoritativeUsage / billing metadata 类型落点 | 见 P1-B 与 Phase 切分 |
| P1-H | 点点复审 | 版本断言分轨 | ★ `protocol_version` 未知值 **fail closed**（事件形状是承重墙，仅告警不够）；`qodercli_version` 漂移允许仅告警 |
| P1-I | 砚砚（其余项） | 砚砚 9 项架构侧发现 | 点点已交叉验证无异议；★ 由砚砚在 r2 修订稿复核时逐项指认编号，对策表补行 |

## What（Phase 1 交付物）

1. **`qoder-ndjson-parser.ts`**（独立文件，不改共享 parser——4 个消费方参数化 blast radius 过大；循 Kimi/Gemini/OpenCode 先例）
   - 复用 Claude 同构块：assistant text/thinking/tool_use、user tool_result、result 成功路径、session_id
   - 方言点：P1-A/B/C/E/H 对策 + status 前置映射 + 版本断言分轨 + init 先行断言
2. **`QoderAgentService.ts`**：仿 `ClaudeAgentService`，spawn 固定 `~/.local/bin/qodercn` + `--config-dir /Users/yuhan/.qoder-cn`（S3 教训：两套 HOME）+ `-o stream-json`
3. **安全硬编码**：禁 `bypass_permissions`/`auto`/`--dangerously-skip-permissions`；断言 init.permissionMode 与请求一致；init.model 断言（P1-D 规则）；MCP 双层 allowlist（`--strict-mcp-config` + 只开 `cat-cafe-memory`）；`--tools ""` 禁全部内置工具（Bash/Write/Edit/WebFetch/WebSearch/ImageGen/VideoGen）
4. **clientId 新增 `qoder`** 注册进 AgentService 工厂
5. **`cat-template.json` 新成员条目**随本提案 PR 一次变更
6. **夹具（S4b 升级为收尾门禁，与 S5/S6 同级）**：现有 3 份 transcript 只覆盖成功 / 工具调用+tool_result / 静默回落。9 类目标夹具 = 8 类正路 + `err.jsonl` 负向夹具。缺口 5 类处理：错误（非零退出/协议级 error）、权限拒绝（`result.permission_denials` 非空）、resume、cancel、压缩——Phase 1 门禁内补采；**若 CLI 本身产不出（如无 `--resume`），删类并记录，不手造假 golden**。压缩夹具未到手前 compact_boundary 不接线（P1-E）

## Phase 1 前置门禁（spike 收尾，谱谱执行）

- **S4b（新增）**：补采 5 类缺口夹具，删不可产类并记录
- **S5（升级版）**：恶意 settings 负向测试必须覆盖 **hooks/plugins 注册面**（SessionStart hook 实测执行任意命令）；断言 `--setting-sources` 受控下 project/local settings 被忽略
- **S6（升级版）**：strict 下 `plugin:qoder-context` 不出现；`--tools ""` 生效验证
- 任一红 → 停止，不进 Phase 1
- ★ 状态勘误：spike 文档「S1–S4/S7 绿」中 S4 仅指 schema 同构结论，夹具采集未完成——已在本文以 S4b 单列，spike 文档同步勘误

## 出口条件

- 双猫 review 通过（砚砚：架构/门禁含 9 项指认；点点：协议/解析按 P1 清单 + r2 收紧项复核）
- 夹具驱动测试全绿；S4b/S5/S6 红绿记录落 spike 文档

## 边界

- CodeBuddy 是独立提案，不混入 F317
- 第三方 `opencode-qoder-bridge` 不作终态
- 计费 credit 制（一次 ok 调用 ~1.15 credits），额度耗尽行为待长期观察，计入运行时告警项

## r2 修订日志

- 删 P1-A「近似计数」，改为 message.id 去重计数待 F153 裁决 / 不发，二选一
- P1-B 明确 credits 落点为独立 billing metadata，不进 TokenUsage
- P1-C 写死映射目标 `disconnected→failed`，映射发生在共享提取之前
- P1-D 增「Auto 必须显式选择」规则 + init 断言先于首个 assistant 事件；err.jsonl 升为负向夹具
- P1-E compact_boundary 接线冻结至真实压缩夹具到手
- P1-H protocol_version fail closed
- 夹具缺口 5 类升级为 S4b 门禁；spike S4 状态勘误
- 砚砚 9 项留 P1-I 行，待其在 r2 上指认
