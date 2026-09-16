---
related_features: [F050, F161, F317]
topics: [codebuddy, acp, cli-integration, external-agent]
doc_kind: proposal
created: 2026-09-16
---

# CodeBuddy Phase 1 Proposal: 走 F161 通用 ACP 路径接入（独立于 Qoder F317）

> **Status**: draft（以 Phase 0.5 证据与 operator 放行为门）· **Owner**: 谱谱 (zcode, glm-5.3) · **创建**: 2026-09-16
> **证据基线**: `2026-09-16-codebuddy-phase0-spike.md` · **铁律**: 不搬 Qoder 专属假设，每项独立实证

## Why

家里需要多供应商 coding 成员与 fallback 源：今天（2026-09-16）砚砚 gpt-5.6-sol 即遭遇上游 capacity 限流，整条 #27 机械链空转一轮。CodeBuddy 的多供应商路由表（gpt-5.6 系/gemini/glm-5.3/kimi/minimax）+ 原生 `--fallback-model` 与此直接对齐。

## 核心论点：这不是 Qoder F317 的复制

Qoder 接入成本高的根因是**无原生 ACP** → 自建 ndjson 方言 parser（F317 round-11 刚修的 tool_calls 泄漏就是方言层的坑）+ 新 AgentService。CodeBuddy **原生说家里的 carrier 协议**：

| 维度 | Qoder F317（已证） | CodeBuddy（Phase 0 已证） |
|---|---|---|
| 传输 | 无 ACP，stream-json 方言 | **原生 `--acp` ndJsonStream**（stdio/streamable-http） |
| 接入路径 | 新 parser + `QoderAgentService` + 方言层 | **F161 通用 ACP 路径**：variant 配 `acp.command` 即走现成 `AcpAgentService`（F161 Phase A+B 已 implemented） |
| 认证 | 浏览器 OAuth + `QODER_CONFIG_DIR` 预登录 | `authMethods` 四法（iOA/external/WeChat/selfhosted）+ `CODEBUDDY_CONFIG_DIR` 同构隔离 + `apiKeySource` 暗示 API-key 可能 |
| 错误语义 | dialect 陷阱（usage 全 0、MCP 词表断裂、silent fallback） | ACP 结构化错误（`category:"auth"`）+ `result.errors[]` |
| 计费 | credits 制（已证） | **未知**（P0.5 H3，不预设） |

### 首选路径 A：F161 配置接入（零/极小代码）

1. 新 generic-ACP variant：`clientId: "acp"`、`acp.command: "codebuddy"`、`acp.startupArgs: ["--acp","--no-session-persistence","--setting-sources","user"]`；`CODEBUDDY_CONFIG_DIR` 指向专用预登录目录
2. 若 H1/H3 证实 API-key 认证可用：优先在绑定账户的 `envVars` 配置目标变量到 `${api_key}` 的模板映射（目标变量名由 H3 实证），保持 generic ACP 零代码路径；只有以后正式新增 `codebuddy` clientId 时，才评估加入 `BUILTIN_ENV_MAPS`
3. 若只有 OAuth：复用 Qoder S3 先例——operator 在专用 config dir 完成一次交互登录，hub spawn 复用（隔离已由两棵 HOME 树天然成立）

### 备选路径 B（仅当 A 被证伪）：stream-json + 独立 dialect parser

仅当 ACP 行为与 hub 期望不达（如 `mainAgentSupport:false` 语义冲突、session 生命周期不合）才走。成本 = Qoder F317 同级，是 fallback 不是计划。

## 不搬 Qoder 假设清单（逐项独立重验）

- credits 计费 → H3 重测；`qodercn` 中国版入口 → CodeBuddy 无此分叉，直接 homebrew 主包；`stream_event` 缺席 / usage 全 0 / MCP 词表断裂 → ACP 通道下预期不存在，H2 实证；`.qoder/settings.json` 提权面 → CodeBuddy 用同名 `--setting-sources` 机制，H4 红绿重跑；版本漂移防线 → homebrew 自更新语义与 npm 不同，H5 独立验证。

## 安全硬防线（与路径 A/B 正交，全部 P0.5 实证后才放行）

- spawn 前：专用 `CODEBUDDY_CONFIG_DIR`（拒绝未授权 settings/plugins/hooks）+ 固定版本 + `--setting-sources user`
- 运行时：`--tools` allowlist + `--strict-mcp-config` + `permissionMode` 断言（禁 `auto`/`bypassPermissions`/`-y`）+ `--no-session-persistence`
- 56 个内置 tools 里有 WeChatReply/ComputerUse/ImageGen 等高危面 → allowlist 必须白名单制而非黑名单制

## 给 operator 的 Decision Packet（价值取舍，非技术 A/B）

1. **登录方式四选一**（iOA / Google-Github / WeChat / Enterprise）——账号归属与合规由你拍板；若 API-key 路径（H3）成立可跳过
2. **接入身份**：新猫成员（占 roster 位）vs 既有猫的 fallback provider（缓解今日这种单点限流）vs 两者（先 provider 后成员）——影响 roster/头像/命名故事
3. **计费承担**：H3 结论出来后的成本题（多供应商路由意味着计费面也多）

## 放行门（缺一不进实现）

1. Phase 0 spike C1-C4 ✅（本文档基线）
2. Phase 0.5 H1-H6 全绿（脱敏 golden transcript + 红绿证据）
3. operator 对本 proposal + Decision Packet 拍板
4. 生产 registry 变更另起 review 链（跨族），不在本 proposal 内夹带
