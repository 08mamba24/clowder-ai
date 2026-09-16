# F317 Phase 1 提案: qodercn CLI 正式接入

> **Status**: implementation（Slice 1/2 ✅；Slice 3 待实现；L2 受控工具 slice 复核中）· **Owner**: 谱谱 (zcode/glm-5.3) · **创建**: 2026-09-13 · **r4**: 2026-09-16
> **前置**: Phase 0 spike `2026-09-13-f317-qoder-phase0-spike.md`（S4 已勘误）+ 双猫复核（点点 5 P1 + r2 复审；砚砚 9 项 I-1~I-9）
> **r3 变更**: 吸收砚砚 I-1~I-9 全清单；spike S4 勘误已真实落仓（同 commit）

## Why

qodercn（Qoder 中国版 CLI，`@qodercn-ai/qoderclicn@1.1.51`）headless spawn 已验证可行，事件形状与 Claude Code 大面积兼容。Phase 1 最初以 text-only / read-only pilot 起步；2026-09-16 operator 在 I-8 三门证据闭合后放行 L2：一次性开放六个基础 coding tools（`Bash/Edit/Glob/Grep/Read/Write`）与 split memory 的精确只读面，不开放 Agent/Cron/Task/Image/Video/Workflow/Skill。

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

**I-2 能力边界（P1）**：L1 为 text-only/read-only pilot；L2 在 I-8 三门全绿后开放 `Bash/Edit/Glob/Grep/Read/Write`。基础工具只是可见面，不等于无边界执行：文件权限仍由 Qoder workspace 规则裁决；Bash 与 stdio MCP 必须经过 runtime-owned shell-prefix + Seatbelt policy。

**I-3 usage/capability（P1）**：见 P1-B。

**I-4 Service 边界 / L0 / cwd（P1）**：不「仿 ClaudeAgentService」。写**窄的独立 AgentService**，仅复用 spawn、sanitizer、archive 等通用设施；禁止复制 Anthropic provider/carrier、Chrome、effort、permission/error 语义。未证明 native system 通道前 `injectsL0Natively=false`；主 prompt 走 stdin；要求已验证的 thread workspace，禁止继承 app-server cwd。

**I-6 agent_loop（P1）**：见 P1-A，已终决为不发。

**I-7 状态真相（P2，已闭环）**：spike S4 勘误已随本 commit 真实落仓（r2 的「已同步」声明当时不实，r3 修正）。

**I-8 S5/S6 安全门（P1，✅ green）**：① PR #24 的 per-cat runtime profile 在每次 spawn 前做全树 custody/污染审计，拒绝未授权 settings/plugins/hooks；② legacy monolith readonly 27-tool gate 已由 `e11f72aa8` 闭合，L2 slice 另按当前 split `memory.js` 真相源钉死 **12** 个只读工具，并以无个人凭证的真实 qodercn init 证明 `cat-cafe-memory=connected`、完整 surface=18；③ cancel 已重采，见 `gate-probes/cancel.{jsonl,exit,receipt.md}`（exit 130 + graceful terminal result）。L2 新增执行边界：callback/invocation 凭证不进 Qoder/Bash/MCP 子进程；Bash 与 stdio MCP 强制走 runtime-owned shell-prefix，macOS Seatbelt 行为 canary 证明工作区内可写、兄弟目录不可读写；无 `sandbox-exec` 即 fail closed。

**I-9 rollout（P2）**：见 P1-F。

## What（Phase 1 交付物）

1. **`qoder-ndjson-parser.ts`**（独立方言层；循 Kimi/Gemini/OpenCode 先例）：复用同构块（assistant text/thinking/tool_use、user tool_result、result 成功路径、session_id）；方言点 = P1-A/B/C/E/H + status 前置映射 + 版本断言分轨 + init 先行断言
2. **窄 `QoderAgentService`**（I-4 边界）+ I-1 注册链全量改动
3. 安全硬编码：禁 `bypass_permissions`/`auto`/`--dangerously-skip-permissions`；init.model / init.permissionMode 断言（P1-D）；MCP 双层 allowlist + `CAT_CAFE_READONLY=true` + exact tools/list 断言（I-8）；路由 `read_only` 仍降级为 `--tools ""`，L2 默认面精确为六个基础工具 + split memory 12 个只读工具
4. **S4b 夹具（✅）**：9 份脱敏基础夹具 + cancel 重采工件已落仓；压缩 = `deferred/N/A for Phase 1`（compact_boundary 冻结）。CLI 产不出的类删类并记录，不手造假 golden
5. `cat-template.json` 条目：在下方「真实 invocation 授权线」全部满足后最后加入（I-9）

## 授权线（时序唯一真相，与 spike r2 收尾结论一致）

- **L0 可开始纯实现**（写 parser/Service/测试，不发起任何 qodercn 调用）：双猫放行 r3 提案——已满足（点点、砚砚均 APPROVED）。
- **L1 受控 gate probes**（唯一豁免的真实 qodercn 调用，仅限 `collect.sh` 采集、MCP 挂载验证、cancel 重采三类脚本化探针）：**硬前置**是离线构建干净 auth-only profile（含登录凭证、无 settings/hooks/plugins，collect.sh 强制显式传入且校验、拒绝回退个人 `~/.qoder-cn`）；探针全部走该 profile 并产结构化 generation receipt（sha256 全量 + 断言结果 + 副作用检查）。
- **L2 首个产品/runtime invocation**：三项前置已闭合——① PR #24 runtime profile pre-spawn audit；② legacy readonly gate + 本 slice split memory 12-tool drift test / authless init probe；③ cancel 重采 receipt。实现仍须跨个体 review、CI、隔离 acceptance 后才能进入 runtime。
- L0 可与 L1/L2 并行推进；cat-template 条目（I-9）在 L2 前置三项全绿后最后加入。
- **OS 隔离边界**：L2 不把 permission allowlist 冒充 sandbox。Qoder file tools 保留 workspace path adjudication；Bash/stdio MCP 通过 `QODERCN_SHELL_PREFIX` 进入 runtime-owned wrapper，再分流到 workspace-write 与 memory-readonly 两份 Seatbelt policy。wrapper 子进程默认不可读 operator HOME/系统 tmp、不可写工作区/受控 scratch/git metadata 之外；callback token 与 invocation credential 在进入 Qoder 前即从 child env 删除。非 macOS/缺 `sandbox-exec` 当前 fail closed，不静默降级。

## 出口条件

- 砚砚对授权线三前置项的红绿记录放行；点点抽检夹具 manifest 的 dialect 契约
- 夹具驱动测试全绿；三项前置红绿记录落 spike 文档

## Phase 1 实施切分（2026-09-13 双猫讨论定稿）

三刀切（砚砚提案、点点附议），每刀独立可验证：

- **Slice 1 ✅（PR #24）：非路由的窄 QoderAgentService + 测试**（I-4 边界：typed inputs 经可信 resolver 解析、缺 workingDirectory fail closed、`QODERCN_CONFIG_DIR` 不进 generic accountEnv 的 last-wins 合并、stdin prompt）。**入口条件 I-11（见下）先行**。
- **Slice 2：注册 + account binding + workspace/session guard 原子 vertical slice**（ClientId/schema/Hub 类型/default CLI/factory/account routing 一次接齐，不留半注册态；`providerRequiresThreadWorkspace` 等 OpenCode 硬编码泛化并覆盖 qoder + e2e resume 测试；account mapping + `QODERCN_CONFIG_DIR` 受控字段校验为安全重点段）。
- **Slice 3：cat-template 条目**（I-9：Slice 1/2 + 隔离 acceptance 全绿后最后加）。
- **L2 受控工具 slice（复核中）**：六个基础内置工具一次性可见；只预授权 workspace-scoped Read/Edit、sandboxed Bash 与 12 个 readonly memory tools；init 对 18-tool 全集 + 唯一 connected MCP server fail closed；路由 read-only 请求维持空工具面。

### I-11 runtime profile ownership / lifecycle（P1，Slice 1 入口条件）

L1 实证：qodercn 把 session 存在 config-dir 的 `projects/<cwd-slug>/`，resume 要求同 config-dir + 同 cwd。采集器的"逐 invocation 临时 clone"会破坏 resume；直接用个人 `~/.qoder-cn` 又越过 clean-profile 边界。生产契约：

1. **归属**：per-cat 持久 runtime profile（`<data>/qoder-profiles/<catId>/`），由 runtime 拥有；用户个人目录不可达。
2. **Seed**：首次从 accountRef 绑定的 OAuth 凭证安全拷贝 `.auth`（临时目录构建 + 原子 rename）。
3. **运行**：token 刷新由 provider 在 profile 内自行完成（L1 已证为预期行为）；**每次 invocation 前**跑洁净审计（无 hooks/settings/plugins 可执行文件——L1 collector `audit_auth` 语义移植）；审计红即拒发。
4. **恢复**：profile 损坏/污染时从 auth source 重新 seed；代价 = profile 内 session 丢失（resume 断裂），记录为已知语义并在日志标注。
5. **注入**：`QODERCN_CONFIG_DIR` 由 Service 构造时经 resolver 唯一解析提供，绝不参与通用 env 合并。
6. **workspace**：每次 invocation 校验 thread workspace 绑定，cwd 固定为 workspace（resume 语义依赖，呼应 Slice 2 的 guard 泛化）。

### CodeBuddy Phase 0（并行侦察，与 qodercn 主线无文件交集）

边界（双猫共识）：Spark 独立执行，谱谱当清单顾问；只做侦察（钉 exact 产品/package/binary/version + headless 接口 + auth 存储 + 协议 + 权限 + MCP + 计费），不改 production code、不碰共享 registry、不全局安装/登录/凭证搬运/付费调用；复用 F317 安全不变量与 collector/verify 方法论但**不复制 qoder 专属参数与凭证假设**，不预抽 GenericCliAgent；任一 P1 红 no-go；可行则独立 feature proposal。**registration 前与 qodercn 串行化**（两侧最终共享注册/account/UI seam）。

## Timeline

| 日期 | 事件 |
|---|---|
| 2026-09-15 | Slice 1 merged（PR #24）：非路由的窄 `QoderAgentService`、runtime profile lifecycle 与测试落入 main；生产注册点仍为 0，Slice 2 的构造期 `realpath(dataRoot)` containment 断言仍是硬验收条件。 |
| 2026-09-15 | Slice 2 merged（PR #25，`26b915d12`）：qoder 注册、account binding、workspace/session guard 原子接线完成。 |
| 2026-09-16 | operator 拍板（thread_msqw8n1bqpvmob6f#0001789549509937-000115-920c1684）：放行 L2 受控工具接入；**基础工具一次性全开**，覆盖谱谱建议及 r3/I-9 的逐个 allowlist 渐进策略；I-8 三门（①spawn 前干净专用 profile ②`cat-cafe-memory` 只读挂载断言 ③cancel 夹具重采）仍为解锁硬前置——拍板的是放开广度，不含跳过安全门。"基础工具"清单由 slice 定义并在 PR 里显式列出。 |
| 2026-09-16 | L2 implementation evidence：六工具清单定为 `Bash/Edit/Glob/Grep/Read/Write`；split memory exact readonly=12（非 legacy monolith 27）；真实 qodercn 1.1.51 init 在 synthetic-invalid auth profile 下回报 18/18 + memory connected，随后 exit 1；Seatbelt canary 为 workspace write=allow、sibling read/write=deny。 |

## 边界

- CodeBuddy 独立提案；`opencode-qoder-bridge` 不作终态
- credit 计费（~1.15/次），耗尽行为待观察，计入运行时告警

## 修订日志

- **r4**: operator 放行 L2 六个基础工具；三门状态按 durable receipts 校正为 green；补 split memory 12-tool 真相、shell-prefix/Seatbelt 与 credential-stripping 执行边界
- **r3**: 砚砚 I-1~I-9 全清单落文（I-6 终决不发 agent_loop、I-2 定位 read-only pilot、I-4 窄 Service、I-8 五源+readonly 断言、I-9 rollout 后置、I-7 勘误真实落仓）；spike S4 勘误同 commit
- **r2**: 点点协议侧修订（message.id 去重待裁决、billing metadata、映射前置、Auto 显式、压缩冻结、fail closed、S4b 门禁）
- **r1**: 初稿
