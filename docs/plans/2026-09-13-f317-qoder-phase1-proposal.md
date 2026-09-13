# F317 Phase 1 提案: qodercn CLI 正式接入

> **Status**: proposal r3（点点协议侧 APPROVED @r2；砚砚 9 项架构侧清单已全部落文，待复审）· **Owner**: 谱谱 (zcode/glm-5.3) · **创建**: 2026-09-13 · **r3**: 2026-09-13
> **前置**: Phase 0 spike `2026-09-13-f317-qoder-phase0-spike.md`（S4 已勘误）+ 双猫复核（点点 5 P1 + r2 复审；砚砚 9 项 I-1~I-9）
> **r3 变更**: 吸收砚砚 I-1~I-9 全清单；spike S4 勘误已真实落仓（同 commit）

## Why

qodercn（Qoder 中国版 CLI，`@qodercn-ai/qoderclicn@1.1.51`）headless spawn 已验证可行，事件形状与 Claude Code 大面积兼容。**Phase 1 定位为 text-only / read-only integration pilot（I-2）**——`--tools ""` + 只读 memory MCP 下无法读代码、编辑或测试，真正 coding tool surface 后续另过安全门。

## 复核合并结论

**骨架保留、方言层独立、独立窄 AgentService（非 Claude 克隆）、S4b/S5/S6 夹具与安全门禁前置、usage 走独立 billing metadata、agent_loop 不发。**

### P1 清单

| # | 来源 | 问题 | 对策 |
|---|---|---|---|
| P1-A | 点点 | `stream_event` 不存在 → agent_loop / lastTurnInputTokens / partialText 死路径 | **Phase 1 不发 `agent_loop`（I-6 终决，不留二选一）**；契约要求无法证明时显示未知。`message.id` 去重方案若将来启用，须另以 tool-loop/resume 夹具证明其为 LLM-call boundary。`lastTurnInputTokens` 不设置并标注数据源缺失 |
| P1-B | 点点+砚砚 I-3 | usage token 全 0；真账 `total_credits` + `context_usage_ratio`；`contextWindow: 0` 穿透 | credits 进独立 typed billing metadata，不进 `TokenUsage`；ratio 不反推 `TokenUsage`，只作带 provenance 观测；`contextWindow` 加 `> 0` 守卫；初始 `contextCapability`：`provider=qoder`、`reportsRuntimeWindow=false`、`authoritativeUsage=false`、`usageTelemetry=unavailable`、`nativeWindowControl=false`、`nativeCompressionControl=false`、`observesCompression=false` |
| P1-C | 点点 | `disconnected` 不在 `CLAUDE_MCP_STATUSES`，共享提取器静默丢弃 | 方言层在共享提取**之前**映射，`disconnected→failed` 写死；夹具保留一条 disconnected server；S6 验证 strict 过滤 `plugin:qoder-context` |
| P1-D | 点点 | 无效 `-m` 静默回落 `Auto` 且成功返回 | init 断言 model，**Auto 必须显式选择**（未显式配置 Auto 时 init.model=Auto 判失败）；断言先于首个 assistant 事件（hook 事件先于 init）；`err.jsonl` 落为负向夹具 |
| P1-E | 点点+砚砚 I-5 | 独有事件被丢弃 | `hook_*`/`artifacts_update`/`context_management` 仅解析透传；**compact_boundary 冻结**——真实压缩夹具 + carrier authority 证明到手前不接线 |
| P1-F | 砚砚 I-9 | cat-template 边界 | 新成员条目**在 S4b/S5/S6 与隔离 acceptance 全部通过后**最后加入同一 PR；注明 fresh-install seed、不更新既有 catalog；现有环境由 operator 经 Hub onboarding，禁止写 `.cat-cafe/cat-catalog.json` |
| P1-H | 点点复审 | 版本断言分轨 | `protocol_version` 未知值 fail closed；`qodercli_version` 漂移仅告警 |

### 架构侧（砚砚 I 清单）

**I-1 账号/配置/注册链（P1）**：禁止硬编码个人 binary/config 路径——binary 走 `resolveCliCommand('qodercn')`；`QODERCN_CONFIG_DIR` 为受控字段，由 `accountRef` 绑定的 OAuth profile 提供并校验。注册链改动清单：`ClientId` 枚举、builtin account mapping、cats/accounts schema、Hub 类型、default CLI、service export/index factory、对应测试——否则 `invoke-single-cat.ts` 账户解析链不会给 Qoder 注入 profile。

**I-2 能力边界（P1）**：Phase 1 = text-only/read-only pilot（见 Why）；coding tool surface 另过安全门。

**I-3 usage/capability（P1）**：见 P1-B。

**I-4 Service 边界 / L0 / cwd（P1）**：不「仿 ClaudeAgentService」。写**窄的独立 AgentService**，仅复用 spawn、sanitizer、archive 等通用设施；禁止复制 Anthropic provider/carrier、Chrome、effort、permission/error 语义。未证明 native system 通道前 `injectsL0Natively=false`；主 prompt 走 stdin；要求已验证的 thread workspace，禁止继承 app-server cwd。

**I-6 agent_loop（P1）**：见 P1-A，已终决为不发。

**I-7 状态真相（P2，已闭环）**：spike S4 勘误已随本 commit 真实落仓（r2 的「已同步」声明当时不实，r3 修正）。

**I-8 S5/S6 安全门（P1）**：S5 恶意 settings 测试源覆盖 **project / local / user / config-dir / plugin 全部五源**，断言无未授权 hook/plugin、`init.tools=[]`、无额外 MCP。`cat-cafe-memory` **并非天然只读**（family 含 distillation 写操作与 library-lifecycle 破坏级操作）——MCP 子进程显式 `CAT_CAFE_READONLY=true` 并断言精确 tools/list；`--tools ""` 生效验证。

**I-9 rollout（P2）**：见 P1-F。

## What（Phase 1 交付物）

1. **`qoder-ndjson-parser.ts`**（独立方言层；循 Kimi/Gemini/OpenCode 先例）：复用同构块（assistant text/thinking/tool_use、user tool_result、result 成功路径、session_id）；方言点 = P1-A/B/C/E/H + status 前置映射 + 版本断言分轨 + init 先行断言
2. **窄 `QoderAgentService`**（I-4 边界）+ I-1 注册链全量改动
3. 安全硬编码：禁 `bypass_permissions`/`auto`/`--dangerously-skip-permissions`；init.model / init.permissionMode 断言（P1-D）；MCP 双层 allowlist + `CAT_CAFE_READONLY=true` + tools/list 断言（I-8）；`--tools ""`
4. **S4b 夹具门禁**：9 类 = 8 正路 + `err.jsonl` 负向；现有 3 份覆盖成功/tooluse/静默回落，补采错误、权限拒绝、resume、cancel、压缩 5 类；CLI 产不出的类**删类并记录，不手造假 golden**
5. `cat-template.json` 条目：门禁全绿后最后加入（I-9）

## Phase 1 前置门禁（谱谱执行，红绿记录落 spike 文档）

- **S4b**：补采 5 类 / 删不可产类
- **S5**：五源恶意 settings 负向测试 + hooks/plugins 注册面（SessionStart hook = 任意代码执行入口）
- **S6**：strict 过滤 `plugin:qoder-context`；`--tools ""`；readonly MCP 断言
- 任一红 → 停止，不进 Phase 1

## 出口条件

- 砚砚复审 I-1~I-9 闭环；点点协议侧已放行（r2），S4b 夹具到手后抽检
- 夹具驱动测试全绿；S4b/S5/S6 红绿记录落 spike 文档

## 边界

- CodeBuddy 独立提案；`opencode-qoder-bridge` 不作终态
- credit 计费（~1.15/次），耗尽行为待观察，计入运行时告警

## 修订日志

- **r3**: 砚砚 I-1~I-9 全清单落文（I-6 终决不发 agent_loop、I-2 定位 read-only pilot、I-4 窄 Service、I-8 五源+readonly 断言、I-9 rollout 后置、I-7 勘误真实落仓）；spike S4 勘误同 commit
- **r2**: 点点协议侧修订（message.id 去重待裁决、billing metadata、映射前置、Auto 显式、压缩冻结、fail closed、S4b 门禁）
- **r1**: 初稿
