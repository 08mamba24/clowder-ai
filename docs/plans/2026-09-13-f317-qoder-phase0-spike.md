# F317 Phase 0 Spike: Qoder CLI 接入门禁验证

> **Status**: plan · **Owner**: 谱谱 (zcode) · **执行**: 火花 (spark) · **创建**: 2026-09-13
> **复核**: 点点 (dsh-v41-flash) 000001412 · 砚砚 (gpt-5.6-sol) 000001415（changes requested：禁止直接写 cat-template.json，先过本门禁）

## Why

评估 Qoder 作为家里新 coding 成员的可行性。三方复核结论：L1 CLI 路径成立但存在五个未验证关键面（凭证/协议/权限/网络/版本），必须先采集一手证据再决定是否立项 F317 正式接入。WorkBuddy 不作为猫成员（无 headless/provider 接口），留作未来 MCP 宿主候选，不在本 spike 范围。

## 前置事实（已验证）

- npm 包 `@qoder-ai/qodercli`：`-p`、`-o text|json|stream-json`、`-c/-r/--session-id`、`--permission-mode`、`mcp` 子命令均存在（点点实包复核）
- 官方入口为 `qoder`（dispatcher），npm bin 同时发布 `qoder` 与 `qodercli`；两者都要探测，不能预设（砚砚修正）
- 无 ACP `--stdio` 入口 → F161 零代码路径不可用；clientId 枚举无 qoder → 需新增 AgentService（非零代码）
- 凭证：`qoder login` 走浏览器 OAuth，无 PAT env；须预登录的独立 `QODER_CONFIG_DIR`

## Spike 任务（全部在服务器本机执行，不用笔记本结论）

| # | 任务 | 产出物 | 验收 |
|---|---|---|---|
| S1 | 安装 | pin 版本 + `--noproxy`（npm 代理已死）+ 记录 postinstall/平台二进制行为 | 安装可复现脚本 |
| S2 | 入口探测 | `qoder` vs `qodercli`：启动/退出/自动更新行为，记录实际版本 | 明确固定哪个入口 + 禁自更新 flag |
| S3 | 认证 | 预登录 `QODER_CONFIG_DIR` 挂载进 spawn；验证隔离（不污染用户配置） | 登录态可被服务端 spawn 复用 |
| S4 | 协议夹具 | 采集脱敏 golden transcript：stream-json 事件 schema、resume/cancel/错误/silent-completion | 夹具文件 + 与 claude-ndjson-parser 兼容性结论 |
| S5 | 权限 | 独立 config dir + `--setting-sources` 受控 + `dont_ask`；验证恶意 `.qoder/settings.json` 无法提权；禁止 `auto`/`yolo` | 提权测试红→绿记录 |
| S6 | MCP | invocation 级临时 mcp-config + `--strict-mcp-config` + `--allowed-mcp-server-names`，仅开放 `cat-cafe-memory` 只读工具 | 双层（服务器+工具）allowlist 实证 |
| S7 | 网络/额度 | 服务器本机 API endpoint 连通性；free preview 额度语义 | 结论 + 风险标注 |

## Spike 结果（2026-09-13，谱谱在本机执行）

| # | 状态 | 结果 |
|---|---|---|
| S1 | ✅ | `@qoder-ai/qodercli@1.1.51` 安装成功；注意 npm allow-scripts 默认拦 postinstall，需 `npm approve-scripts @qoder-ai/qodercli`；未遇代理问题 |
| S2 | ✅ | `qoder` 与 `qodercli` 同为 1.1.51，`qoder` dispatcher 正常转发 → **固定用官方入口 `qoder`**；帮助面未发现 `--no-auto-update` 类 flag，版本漂移防线待 S3 后复查（升级 slash 命令存在，需确认 spawn 路径不会触发） |
| S3 | 🟡 阻塞 | 未登录态下 API 调用返回 `authentication_failed`（"Not logged in · Please run /login"）→ 需浏览器 OAuth，**只有铲屎官能做**：`qoder login` + `--config-dir /tmp/qoder-spike/qconfig`（注：CLI 原生提供 `--config-dir` flag，比 env 更干净） |
| S4 | 🟢 重大利好 | 未登录也吐完整 stream-json：事件 schema 为 Claude Code 同构（`system/init` 含 tools/mcp_servers/permissionMode/capabilities；`assistant`、`result` 字段齐全）→ `claude-ndjson-parser.ts` 复用可行性高，transform 成本预期从 Kimi 级降到接近零 |
| S5 | ⏳ | 待 S3 后做（权限 mode 枚举确认含 `bypass_permissions`/`auto` 危险值，接入时硬编码禁用） |
| S6 | ⏳ | 待 S3 后做（`--strict-mcp-config` / `--allowed-mcp-server-names` / `--mcp-config` flag 全部在位） |
| S7 | ✅(部分) | 本机 endpoint 连通（返回的是认证错误而非网络错误）；额度语义待登录后看 `usage` slash 命令 |

复现命令：`cd /tmp/qoder-spike && ./node_modules/.bin/qoder -p "say hi" -o stream-json --config-dir ./qconfig`

## 出口条件

- 全绿 → 谱谱汇总，升级为 F317 正式提案（新 clientId + `QoderAgentService` + 事件 transform），进 Phase 1
- 任一 P1 红（认证不可隔离 / 协议不可解析 / 提权防线破）→ 停止，落 lessons，不立项

## 边界

- 火花不会自动跑测试：每个 S 项的验证命令由本计划给出，跑完把原始输出贴回
- 备选 `opencode-qoder-bridge`（第三方 0.1.11）仅作模型快速验证参考，不作终态
- CodeBuddy 是独立提案，不混入本文件
