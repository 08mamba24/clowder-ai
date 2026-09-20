# F247 Workspace Agent 双向唤醒接入 — 实施计划（2026-09-20）

任务 `0001789905354421-000238-3994be29` · 实现：谱谱（zcode）· review 把关：小星星（astra，未 review 不得宣称完成/合入）· 方案来源：砚砚（cat-to5aedfl）交接的实现契约 + 官方文档三份（trigger-runs / authentication / plugins-mcp-server，2026-09-20 抓取）。

基线：worktree `clowder-ai-wt-f247-wa`，分支 `feat/f247-workspace-agent`，基于 **upstream main `9bca5ae2f`**（非共享 main `a198187d0`，后者有未推 doc commits + 未跟踪 review notes）。

## 官方契约要点（已核实）

- `POST https://api.chatgpt.com/v1/workspace_agents/{id}/trigger`，`id` 形如 `agtch_XXX`；Bearer Workspace Agent access token（admin 门控签发，scope 仅限 Workspace Agents API，无公开 refresh 流 → Settings 需提供续权/换 token 入口）。
- body：`input`（必填）+ `conversation_key`（调用方定义的稳定会话标识，跨 trigger 续同一会话）。
- `Idempotency-Key` header 支持重试去重（同 key 返回原 accepted 结果）。
- 202 → `{conversation_url}`；**最终答复不可经 API 读取**。beta header `OpenAI-Beta: workspace_agent_runs=v1` 可得 `agent_trigger_run_id`（`apirun_XXX`），仅轮询 telemetry。
- 错误：401（token 坏）/ 403（权限不足）/ 404（trigger 不存在）/ 409（agent/channel 不可运行）。
- 反向：Workspace Agent 内配 Clowder Remote MCP（streamable HTTPS），调 `cat_cafe_post_message(replyTo=sourceMessageId)` —— 复用既有 F264 回程 + CloudReturnGrantStore，**run completed 不替代 exact MCP 回程**。

## 9 点实现契约 → 文件映射

| # | 契约 | 落点 |
|---|---|---|
| 1 | Trigger API 主路径 + `conversation_key=clowder:{workspaceId}:{threadId}` + 202/conversation_url + beta run id 仅 telemetry | `workspace-agent/conversation-key.ts`（纯函数）+ `workspace-agent/workspace-agent-trigger-adapter.ts` |
| 2 | 反向走 MCP post_message(replyTo)，run completed ≠ 回程 | 不新做：复用 grant store + `cloud-assistant-return-ingest`；adapter 不消费 run 状态作为回程 |
| 3 | 任意 ChatGPT 历史会话不可冒充 API 可寻址对象；Personal Chrome 保留 personal-plan fallback | bridge transport 决策顺序：workspace-agent（已配置且 enabled）→ host（personal-chrome）→ legacy pinchtab；workspace-agent 路径**不读不写 chat-URL binding**（conversation continuity 由 conversation_key 服务端维护） |
| 4 | 新增独立 `IWorkspaceAgentTriggerAdapter`；复用 CloudReturnGrantStore / buildDeltaPayload / exact-source callback / durable receipt | 新 adapter 模块；bridge 注入新 dep；receipt 持久化走既有 outbound receipt 管道 |
| 5 | cloudCatBindings legacy string → versioned provider binding；conversation_url owner-only；receipt 增 workspace-agent/providerRunId，不冒用 hostMessageId | `cloud-cat-bindings-v1.ts`（normalize/validate 纯函数）；shared `cloud-bridge-outbound-receipt.ts` 扩展 transport=`'workspace-agent'` + `providerRunId?`；conversation_url 只进 owner-only settings 投影，不进 receipt/thread context |
| 6 | token 仅服务端托管；Idempotency-Key 绑定 exact dispatch；防环字段 bridgeEventId/origin/sourceMessageId/causationId | token 经 server-side provider 注入（env/设置存储，API 响应只回 presence bit）；Idempotency-Key = dispatchInvocationId（与 exact source 绑定）；delta payload JSON 增 `origin:"clowder-outbound"` + `bridgeEventId`（=dispatchInvocationId）+ `causationId`（=source 的 invocation 链引用），回程 ingest 依此抑制环 |
| 7 | Settings 卡：trigger id、授权/续权、disable、test；token 不回前端 | `workspace-agent-plugin-routes.ts`（owner-only，循 personal-chrome-plugin-routes 模式）+ web 卡片 |
| 8 | Personal Chrome 主路径基线不动；Workspace Agent 优先级须显式新 decision | F247 spec 增 KD-24：workspace-agent transport 仅在显式配置（trigger id + token + enabled）时接管出站，未配置时行为与现状逐字节等价 |
| 9 | 测试覆盖清单 | 见下「测试矩阵」 |

## 切片划分

- **Slice 1（本提交）**：纯核心 + 类型地基 —— conversation-key、IWorkspaceAgentTriggerAdapter + HTTP 实现（typed 401/403/404/409、Idempotency-Key、token 永不进错误/日志）、cloud-cat-bindings-v1 迁移纯函数、shared receipt 扩展（transport + providerRunId + validator）、全部单测。
- **Slice 2**：bridge 接线（transport 决策 + 出站 delta 增防环字段 + Idempotency-Key=dispatchInvocationId）+ ThreadStore versioned binding 读写 + invoke-single-cat receipt 投影带 providerRunId。
- **Slice 3**：Settings owner-only 路由（status/config/test/disable，token redaction）+ web 卡片。
- **Slice 4**：F247 spec KD-24 + revision_history v37；集成测试（replay、Redis restart、exact callback、loop suppression、页面关闭 dogfood 记录为 live gate 待办）。

## 测试矩阵（契约 #9）

1. conversation_key schema：格式稳定、threadId/workspaceId 边界字符拒绝、同 thread 稳定、跨 thread 不碰撞。
2. adapter：202 解析（conversation_url + beta run id 可选）、401/403/404/409 typed error、网络错误不冒充 202、Idempotency-Key 头存在且等于入参、**token 不出现在任何错误序列化/日志字段**（redaction）。
3. binding 迁移：legacy string → `{v:1,provider:'personal-chrome-host'}`；versioned 直通；未知 provider/畸形 v 拒绝（fail closed）。
4. receipt：transport='workspace-agent' + providerRunId 通过 validator；hostMessageId 在 workspace-agent receipt 上被 validator 拒绝（不冒用）。
5. （Slice 2+）replay：同 Idempotency-Key 二次 dispatch 复用结果；Redis restart 行为；loop suppression：带 origin/bridgeEventId 的回声不触发二次出站。

## 边界与不做

- 不改 Personal Chrome Host 现有行为/测试；不动 legacy pinchtab opt-in。
- trigger input 复用 `buildDeltaPayload`（含固定 return contract），不改其 2000-char 契约。
- token 永不：进前端响应、进 thread context、进 delta payload、进 receipt、进日志。
