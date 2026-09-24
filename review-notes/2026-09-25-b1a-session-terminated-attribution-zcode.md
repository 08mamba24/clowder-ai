# B1a `McpServerError: Session terminated` 归因记录（谱谱，跨两轮）

日期：2026-09-24/25　thread：`thread_mua1efbnjtkqiaqy`（云端 MCP 诊断线）
参与：砚砚6（现场确认 + 主机边界）、谱谱（源码 / SDK / 公开证据）、待 co-creator（部署盒 runbook 终确认）
状态：**主因假设=OpenAI 客户端层（openai-mcp/1.0.0）session 管理，待部署盒 runbook 终确认后结案**

## 0. 一句话结论

`Session terminated` 报错串由 **OpenAI MCP 客户端层生成**，`McpServerError:` 前缀是 ChatGPT UI 的 connector 错误包装类；我们的服务端（B1a spike，stateless）结构上不可能产生该串。部署盒 runbook 的角色从"找服务端根因"降级为"终确认请求是否到达 + 实际状态码"。

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

- ✅抽查原文 community.openai.com/t/1275728：OP（stateful FastMCP + ngrok + Responses API）"every tool invocation failed with session terminated error"；错误对象 `{"error":{"type":"mcp_protocol_error","code":32600,"message":"Session terminated"}}` 由 **OpenAI 侧返回**；公认修复=服务端转 stateless（`stateless_http=True`）。
- ✅抽查原文 community.openai.com/t/1372031（Sarah Lacard 取证）：ChatGPT MCP client（`openai-mcp/1.0.0`）"is not persisting the `Mcp-Session-Id` header between tool call batches"；约 30s 丢弃 session id、重发 initialize、**DELETE 数为 0**；结论原话 "This is a ChatGPT MCP client bug"；根因是 session id 存在 SSE 连接级对象上、连接关闭即丢弃，违反 MCP spec 的 MUST 持久化要求。
- （代理检索，未逐字复核）t/1312539：Responses API "session terminated" 多用户同日波发（Azure 侧 "all 3 MCP servers"），status page 无记录——OpenAI 侧回归波先例。
- （代理检索）t/1388400：与我们同构（stateless FastMCP + Streamable HTTP），服务端观察到 `openai-mcp/1.0.0` 每请求 "Terminating session: None" + tool call 前 re-discovery；OpenAI_Support 介入。
- （代理检索）t/1381725：`McpServerError:` 前缀是 ChatGPT/Codex UI 的 connector 错误包装类（OAuth 失败显示 `McpServerError: invalid_token`——同前缀、不同内串）。
- 推论：对我们**已经 stateless** 的服务端，无已知服务端修复动作；报告指向 OpenAI 侧客户端行为/回归波；缓解=新会话重试 / 重加 connector / 等波过。
- 待验证的机制假说（P3，不据此动手）：我们的 `/mcp` 对 GET（SSE 流）返回 405（`remote-spike.ts:330-334`）；若 openai-mcp 把"SSE 连接不可建立/关闭"当作会话失效信号，则 405 可能参与触发其客户端侧 session 重建。runbook 日志若显示大量 initialize 突发可佐证。

## 3. 三假设终局

| 原假设 | 裁定 | 依据 |
|---|---|---|
| 服务端 session 重启丢失 | 不成立（stateless，无会话可丢） | §2.1 |
| 空闲回收 | 结构性不可能（无会话存储、无 sweeper） | §2.1 |
| 鉴权失败 | 形态不符（401+hint JSON，非该串） | §2.1 |
| （新增）OpenAI 客户端层 session 管理 | **主因假设**，待 runbook 终确认 | §2.3 |

## 4. 部署盒 runbook（co-creator，只读；上轮已交，本注补判读）

1. `curl -s https://mcp.clowder-ai.com/health` 记 `artifact_revision`
2. `sha256sum packages/mcp-server/dist/remote-spike.js`（应等于第 1 条；不等 → `pgrep -af remote-spike` 查实际运行实例）
3. `ps -o pid,lstart,etime,cmd -p $(pgrep -f remote-spike | head -1)`（进程启动时间=最近重启窗口）
4. 日志 `/tmp/spike-server-b1a.log`（§B 亦写过 `/tmp/spike-b1a.log`，两个都查）：`POST /mcp`、`handleRequest error`、`received SIGTERM`（token 轮换 SOP C.3 会 pkill，属预期）、`auth=absent`
5. 决定性实验：`tail -f` 日志同时在 ChatGPT 重触发一次 gpt-pro 调用。**判读（本注新增）**：
   - POST 到达且 200 → 归因 OpenAI 客户端层，结案；缓解=重试/重加 connector。
   - 到达且 401 → token 轮换后 ChatGPT connector URL 未更新（SOP C.3 步 3 漏做）。
   - 未到达 → Cloudflare / 隧道 / OpenAI 侧。
   - 注意：tool call 前的 initialize/tools/list 突发（re-discovery）是 openai-mcp 已知常态，不算异常。

## 5. 遗留

- P3：`HEAD /health` 返回 404（`remote-spike.ts:385` method 门只认 GET），建议下个 B1 版本顺手修。
- P3（假说）：GET /mcp → 405 与 openai-mcp 会话生命周期的相互作用，见 §2.3 末条；runbook 日志可顺带观察。
- F167 留痕：谱谱两轮 invocation 的 callback 工具面均不可用（`$CAT_CAFE_API_URL` / `INVOCATION_ID` / `CALLBACK_TOKEN` 未注入），`complete_a2a_dispatch` 无法调用，处置走行首 @ 通道并在此留痕。

[谱谱/glm-5.3🐾]
