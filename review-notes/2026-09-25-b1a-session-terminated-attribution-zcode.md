# B1a `McpServerError: Session terminated` 归因记录（谱谱，跨两轮）

日期：2026-09-24/25　thread：`thread_mua1efbnjtkqiaqy`（云端 MCP 诊断线）
参与：砚砚6（现场确认 + 主机边界）、谱谱（源码 / SDK / 公开证据）、待 co-creator（部署盒 runbook 终确认）
状态：**字符串归属已证明（OpenAI 客户端错误类文案）；本次故障根因=主因假设（OpenAI 客户端层），待部署盒 runbook 核验——不得表述为"结案 / 三假设全部排除"**

> 修正记录：初版（本地 commit `436a38de6`，未推送）把"三假设排除 / 归因结案"写得过强。砚砚6 P2（2026-09-24）：公开报告只支持候选解释；`McpServerError` 包装与裸状态码都不足以单独定源；POST 200 还需核对响应体。本版按此收敛（§0/§2.3/§3/§4），并补一处同方向收紧：t/1275728 实录来自 Responses API 面，非 ChatGPT connector 面。
> 修正记录·二：addendum 初稿（本地 `204cf3ea2`，推送前被退回）把 CF 面板聚合统计与单次请求判读拼配，宣称"覆盖 200/401/5xx 三分判读"。砚砚6 P2·二：面板数据聚合且可能抽样，不能与单条 `POST /mcp` 日志配对归因。已 amend 降级为趋势线索（§4.6），该错误版本未进入远端历史。Cloudflare 官方文档将 Host/状态码详细过滤列在 Pro、Business、Enterprise 的 HTTP Traffic 功能下；实际可用性仍需核对账号套餐与权限。

## 0. 一句话结论（按砚砚6 P2 修正后）

**已证明**：`Session terminated` 是 OpenAI MCP 客户端的错误类文案（Responses API 面有原样返回实录），`McpServerError:` 前缀是 ChatGPT UI 的 connector 错误包装类；该串不出自本 repo 任何已同步版本源码与 MCP TS SDK 传输层。

**未证明**：本次故障的根因归因。OpenAI 客户端层是**主因假设，不是结论**——ChatGPT connector 面的内串生产者没有直接 wire 取证，OpenAI 客户端把各类底层响应（401/404/405/断流）映射到该文案的映射表未知，因此"我方（或中间层）响应触发其 Session terminated 分类"的路径**未被排除**。部署盒 runbook 仍是必要证据：请求是否到达、状态码、以及 200 响应体内的实际 JSON-RPC 结果。

## 1. 现场事实

- 原始报错（砚砚6 2026-09-24 确认）：新建 ChatGPT 会话显式选中 `cat-cafe` connector 后，`cat_cafe_get_message` 两次调用的**工具结果**均显示 `McpServerError: Session terminated`；看不到底层 HTTP 响应。
- 服务面：`https://mcp.clowder-ai.com/health` 200，自报 `cat-cafe-cloud-pro-b1a` / `0.0.5-b1a` / `artifact_revision 2e90ed12…` / `cat_id gpt-pro`（谱谱 2026-09-24 独立复测）。
- 本机（Mac）非承载节点：无 3098 listener、无 cloudflared、无 `~/.cat-cafe/spike-token`（砚砚6 + 谱谱独立复核一致）。承载节点为部署盒 `/home/user/cat-cafe`（`cat-cafe-skills/refs/chatgpt-cloud-onboarding-guide.md` §1.2/§5，Linux + named tunnel `cat-cafe` `67125a9e-…`）。

## 2. 三层证据

### 2.1 服务端源码与 SDK（本地可复验）

- `packages/mcp-server/src/remote-spike.ts:355-357`：每请求新建 `McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`（stateless）。
- SDK `@modelcontextprotocol/sdk@1.26.0` `server/streamableHttp.js` 头注释：stateless 模式**不做任何 session 校验**（stateful 才有 unknown-session→404 / missing-header→400 拒绝路径）。
- git 考古：`remote-spike.ts` 在 mirror 全部 3 个版本（2026-06-25 `c9d100389` / 2026-08-04 `ffa73bb8f` / 2026-08-27 `1700bf308`）均为 stateless，该行从未改动；线上 version 串 `0.0.5-b1a` 与 mirror 一致。
- `Session terminated` 在本 repo 全部源码（含 dist）与 SDK 传输层**零命中**（SDK 仅 example 有 "Session terminated successfully"）；服务端全部错误路径（401/400/405/404/500）均为自有 JSON 文案。

### 2.2 部署指纹（唯一残留不确定性）

- `artifact_revision` = 运行中 dist 文件自身 sha256（`remote-spike.ts:128-131`）。线上 `2e90ed12…` ≠ 本地镜像构建 `172a6138…`（2026-09-18 构建）。
- 本 repo 是 sync mirror，部署盒自建，严格确认待部署盒 `sha256sum`（§4 runbook 第 2 条）；但 stateless 特性受"全历史不变 + version 串一致"约束，偏移空间很小。

### 2.3 公开证据（OpenAI 社区 / GitHub，2025-06 ~ 2026-02 多起独立报告）

- ✅抽查原文 community.openai.com/t/1275728：OP（stateful FastMCP + ngrok + Responses API）"every tool invocation failed with session terminated error"；错误对象 `{"error":{"type":"mcp_protocol_error","code":32600,"message":"Session terminated"}}` 由 **OpenAI 侧返回**；公认修复=服务端转 stateful→stateless（`stateless_http=True`）。**注意面差异（砚砚6 P2 方向的补充收紧）**：该实录来自 Responses API 面，不是 ChatGPT connector 面；connector 面的内串生产者仅由 t/1388400 的服务端侧行为观察间接支撑，无直接取证。
- ✅抽查原文 community.openai.com/t/1372031（Sarah Lacard 取证）：ChatGPT MCP client（`openai-mcp/1.0.0`）"is not persisting the `Mcp-Session-Id` header between tool call batches"；约 30s 丢弃 session id、重发 initialize、**DELETE 数为 0**；结论原话 "This is a ChatGPT MCP client bug"；根因是 session id 存在 SSE 连接级对象上、连接关闭即丢弃，违反 MCP spec 的 MUST 持久化要求。
- （代理检索，未逐字复核）t/1312539：Responses API "session terminated" 多用户同日波发（Azure 侧 "all 3 MCP servers"），status page 无记录——OpenAI 侧回归波先例。
- （代理检索）t/1388400：与我们同构（stateless FastMCP + Streamable HTTP），服务端观察到 `openai-mcp/1.0.0` 每请求 "Terminating session: None" + tool call 前 re-discovery；OpenAI_Support 介入。
- （代理检索）t/1381725：`McpServerError:` 前缀是 ChatGPT/Codex UI 的 connector 错误包装类（OAuth 失败显示 `McpServerError: invalid_token`——同前缀、不同内串）。
- 推论（**假设级**，待部署端核验后才可执行化）：若主因假设成立，对我们已经 stateless 的服务端无已知服务端修复动作，缓解=新会话重试 / 重加 connector / 等波过。
- 待验证的机制假说（P3，不据此动手）：我们的 `/mcp` 对 GET（SSE 流）返回 405（`remote-spike.ts:330-334`）；若 openai-mcp 把"SSE 连接不可建立/关闭"当作会话失效信号，则 405 可能参与触发其客户端侧 session 重建。runbook 日志若显示大量 initialize 突发可佐证。

## 3. 假设状态（按砚砚6 P2 修正后）

| 假设 | 裁定 | 依据 |
|---|---|---|
| 服务端 session 重启丢失 | **前提性排除**：若部署物=mirror 语义（stateless，§2.1 全历史不变+version 串一致）则结构性不成立；该前提待部署盒 `sha256sum` 终验（§4.2） | §2.1/§2.2 |
| 空闲回收 | 同上前提性排除（无会话存储、无 sweeper） | §2.1/§2.2 |
| 鉴权失败 | **弱化、未排除**：401+hint JSON 与该串形态不符，且 OpenAI 对 auth 类失败另有 `invalid_token` 类文案（t/1381725，单例）；但 OpenAI 客户端错误映射表未知 | §2.3 |
| OpenAI 客户端层 session 管理 | **主因假设**（字符串归属 + 同构报告），待部署端核验 | §2.3 |

## 4. 部署盒 runbook（co-creator，只读；上轮已交，本注补判读）

1. `curl -s https://mcp.clowder-ai.com/health` 记 `artifact_revision`
2. `sha256sum packages/mcp-server/dist/remote-spike.js`（应等于第 1 条；不等 → `pgrep -af remote-spike` 查实际运行实例）
3. `ps -o pid,lstart,etime,cmd -p $(pgrep -f remote-spike | head -1)`（进程启动时间=最近重启窗口）
4. 日志 `/tmp/spike-server-b1a.log`（§B 亦写过 `/tmp/spike-b1a.log`，两个都查）：`POST /mcp`、`handleRequest error`、`received SIGTERM`（token 轮换 SOP C.3 会 pkill，属预期）、`auth=absent`。当前 `remote-spike.ts` 只记录请求方法、路径和部分鉴权头是否存在，**不记录响应状态码或响应体**；`auth=absent` 也不代表 `?token=` 缺失。
5. 对照实验：`tail -f` 日志同时在 ChatGPT 重触发一次 gpt-pro 调用，先确认请求是否到达。以下状态码和 JSON-RPC 内容判读还需要部署节点的安全诊断入口或一次受控、脱敏的响应追踪；**仅凭现有日志不能完成这些判读，也不能结案**：
   - POST 到达且 200 → **仍需核对对应响应体**确认 JSON-RPC result 无应用层错误（MCP 应用层错误同样走 200）；确认无错才支持 OpenAI 层归因（缓解=重试/重加 connector）；若 200 内含错误 → 按错误内容另行归因。
   - 到达且 401 → 仅证明 token 校验失败；具体归因（token 轮换后 connector URL 未更新 / spike-token 文件被重生成 / 中间层剥参）需在部署盒比对 `~/.cat-cafe/spike-token` 与 ChatGPT connector URL，不能仅凭状态码。
   - 未到达 → Cloudflare / 隧道 / OpenAI 侧。
   - 注意：tool call 前的 initialize/tools/list 突发（re-discovery）是 openai-mcp 已知常态，不算异常。
6. 状态码观测边界（谱谱补，2026-09-25；同日按砚砚6 P2 推送前降级改写）：若当前套餐提供详细过滤，CF zone analytics 可按 Host=`mcp.clowder-ai.com` + Edge/Origin 状态码查看**聚合计数**（[zone-analytics](https://developers.cloudflare.com/analytics/account-and-zone-analytics/zone-analytics/)；数据可能抽样，见 [sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/)）。聚合数据**不能与服务端某条 `POST /mcp` 日志做单次配对**，也不能在扫描噪声里把某个 4xx 归到 ChatGPT 那一次调用——即使做单次受控重触发，也只能提供弱佐证，不构成归因。因此本条定位为**趋势线索**（如事故窗口 mcp 主机名 4xx/5xx 有无突发）。单次调用的状态码判读需可关联该请求的逐请求记录：例如带请求标识的 `res.on('finish')` 状态日志（需部署盒重建；**只补状态码，仍看不到 JSON-RPC 响应内容**），或已启用且套餐允许的 [Instant Logs](https://developers.cloudflare.com/logs/instant-logs/)、[Log Explorer](https://developers.cloudflare.com/log-explorer/)、[Logpush](https://developers.cloudflare.com/logs/logpush/)；响应内容仍需受控、脱敏的响应追踪。**在补齐逐请求状态观测之前，runbook 不构成可执行结案。**

## 5. 遗留

- P3：`HEAD /health` 返回 404（`remote-spike.ts:385` method 门只认 GET），建议下个 B1 版本顺手修。
- P3（假说）：GET /mcp → 405 与 openai-mcp 会话生命周期的相互作用，见 §2.3 末条；runbook 日志可顺带观察。
- P3（观测，砚砚6 `9d5161b71` 确认）：B1a 无响应状态码/响应体日志，且 `auth=` 字段只反映 Authorization 头（`?token=` 流量恒为 `auth=absent`，此口径同样误导 SOP §C.5 监控表）；§4.6 已按砚砚6 第二次 P2 降级为趋势线索，一行级状态码日志仍不含响应体；SOP §C.5 指标留待 B1b 重写时一并处理，不逐点修补。
- F167 留痕：谱谱四轮 invocation 的 callback 工具面均不可用（`$CAT_CAFE_API_URL` / `INVOCATION_ID` / `CALLBACK_TOKEN` 未注入），`complete_a2a_dispatch` 无法调用，处置走行首 @ 通道并在此留痕；推送依赖持 gh 凭证的猫（本轮=砚砚6）。

[谱谱/glm-5.3🐾]
