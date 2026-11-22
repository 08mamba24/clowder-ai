# 2026-11-22 成员链路问题 TODO

- 会话：`thread_owned_5df7c329505b2cd48350dbb88294ebc6ef96de23`
- 原记录：谱谱 / glm-5.3；证据复核：砚砚61 / gpt-6.1-sol
- 更新：2026-11-22；下文时间均为 UTC。
- 接续来源：用户消息 `0001795349271656-000669-42e7567e`。
- Task：`task:work:0001795349706232-000671-8fce4bcd`。

## 四项问题

| 项目 | 当前状态 | 下一步 |
|---|---|---|
| 1. 点点 ACP 续聊失败 | 增量入口缺少受控重放，已定位；未修 | 补真实消息库入口的重放生产和回归 |
| 2. 银闪启动 canary 失败 | 已复现并完成分支修复 | PR #78 独立审查、合入、隔离验收 |
| 3. Pro 读取 429 | 实测复现 OpenAI MCP 隧道 SSE 探测 429 | 外部通道恢复后验证真实工具读取 |
| 4. 谱谱 gh 凭据 | 宿主已登录，隔离 HOME 未登录 | 明确实际权限，再接受控宿主 gh CLI |

### 1. 点点 ACP 续聊缺少受控重放

- **纠正对象**：09:07 的失败消息 `0001795338434294-000612-889be875` 来自 `dsh-v41-flash`，metadata 为 `provider=acp, model=deepseek-flash`，`turnExecution.executionKind=ordinary`；触发者为用户消息 `0001795338434168-000611-e66d12ce`。不能把这条证据写成“A2A 派发到 zcode 失败”。
- **线上证据**：点点在 09:06:45 创建会话 `d5923e1e-de35-4071-853f-cec634d000f2`，首轮成功；09:07:14 进入 `route-serial`，增量投影实际读到了历史；09:07:16 因重放缺失抛出 `prompt_failure`，`eventCount=0`。
- **代码断点**：`QueueProcessor` 调用 `AgentRouter.routeExecution()`，提供 `currentUserMessageId`，不提供旧 `history` 参数。串行/并行路由的增量模式通过消息库组装上下文，但 PR #76 的 `rebuildContextPrompt` 仍只使用 `options.history`。库里有历史，不等于 carrier 收到了重放。
- **测试缺口**：`packages/api/test/native-acp-rebuild-route.test.js` 手动注入 `routeOptions: { history }`，没有覆盖线上不传该字段的入口。
- **修法**：从同一授权、可见性边界内的 canonical 历史生成有界重放，覆盖串行、并行与真实 Queue 入口。回归只向消息库准备历史，不手塞 `options.history`，验证前轮内容进入 replacement session、预算和可见性保持成立。
- **不采用**：直接省略旧 sessionId、删除旧 session 或放松重放校验；这些做法会掩盖失忆或审计断链。
- **状态**：根因已定位，代码未修改。原修复作者为谱谱，后续修复须非作者独立审查。

### 2. 银闪 Node 包元数据被沙箱拒绝

- **现象**：09:07 消息 `0001795338478168-000618-66590a4c`：`qoder sandbox guarded gh execution canary failed`。
- **复现**：实际 Node 24.22.3、包装器及生产 policy builder，在临时隔离目录执行 `gh --version`。四组对照中，无 literal 和只放行 runtime 根 `package.json` 均报 `ERR_INVALID_PACKAGE_CONFIG`；只放行 `packages/mcp-server/package.json` 与两者均放行都退出 0。包 manifest 单独放行时，根 manifest 的 `/bin/cat` 仍退出 1。
- **原因**：Node 在执行无扩展名的 `guarded-bin/gh` 之前解析 package scope，包装器的 readonly 提前返回尚未开始执行。不是 gh 登录失败。
- **修复**：只把包装器实际所属 `@cat-cafe/mcp-server/package.json` 加入 workspace policy 的 literal read allowlist；根 manifest 保持拒读，不开放整个 runtime，不移除 canary。初版额外放行根 manifest，经砚砚独立 review 提出最小权限 P2 后，作者补齐对照并收窄。
- **交付**：[PR #78](https://github.com/08mamba24/clowder-ai/pull/78)，分支 `fix/member-chain-20261122`，当前代码 commit `a887ef1c34fa64ed36677c5e01f046233e1b4399`，改动 `QoderAgentService.ts` 和现有 service 回归用例。
- **验证**：现有 `L2: macOS controlled PATH resolves guarded gh and a runnable pnpm before provider spawn` 修前以线上同一 canary 错误失败；新增根 manifest 拒读断言在初版补丁上失败，收窄后 Qoder service + 真实 Seatbelt memory policy 共 **99/99** 通过，API 构建和修后 TypeScript 编译通过。对照实验中 `.env` 与 runtime 的 `scripts/lib` 继续拒读。未调用真实模型，未改在线 runtime 或运行配置。
- **审查**：旧 SHA `37247e5549119b68e499f1d65e07cd9763f2935e` 的 typed verdict 为 changes_requested（消息 `0001795350798827-000675-56f7dbc9`）；修后 SHA 已回同一 reviewer 复审（请求 `0001795351232915-000677-327762f8`）。
- **状态 / owner**：砚砚61 完成收窄和验证，待新 exact HEAD 的独立复审与发布验收；线上尚不能登记已恢复。

### 3. Pro 429 位于云端 MCP 隧道探测层

- **原始线索**：消息 `0001795339167201-000636-4e7063ae` 是 Pro 对读取失败的描述；callback 只能证明回复回传，不能单凭正文认定限流层。
- **本轮实测**：通过独立的云端猫咖连接调用只读 `cat_cafe_get_thread_context`（本线程、`limit=1`），返回 `isError=true`：`McpServerError: MCP SSE probe returned 429 from openai.org`。结构化错误为 `error_code=UNAVAILABLE`、`type=invalid_mcp_response`、`status_code=429`，URL 属于 OpenAI 内部 MCP tunnel service。本记录不复制隧道标识或凭据。
- **本地对照**：实际 API 日志在 09:06—09:24 UTC 的 HTTP 完成记录没有 HTTP 429；此结论仅覆盖已检查窗口与该 API 进程。
- **处理**：当前证据不支持调整本地 gateway per-token 或 API 全局限流。外部通道恢复后，验证“读出指定消息并核对 ID”，而非只发 hi。持续失败时保留时间与结构化错误，用于连接器恢复或服务支持排查；不做高频重试。
- **状态**：外部传输问题已复现，未恢复。原始 09:19 请求是否与本轮完全同因，缺少原始工具回执，不能追认。

### 4. 谱谱 gh：隔离事实与新授权分开

- **本轮复测**：宿主 `gh api user` 成功，login 为 `08mamba24`；仅切到 zcode 隔离 HOME / XDG_CONFIG_HOME、无 GH 覆盖的子进程中，`gh auth status` 返回未登录。未执行登录、复制凭据或冒烟写操作。
- **代码**：`zcodeAppServerEnv()` 重定向 HOME 与 XDG 目录；`agy-native-launch-env.ts` 有宿主 GH_CONFIG_DIR 接线先例，但别的 carrier 的实现不自动授予 zcode 同等权限。
- **现行边界**：本实例仓库操作走 canonical `gh` CLI。历史 GitHub read MCP 代码不构成继续使用已退役 GitHub MCP 的依据。保留 ZCode 自己的 HOME，按允许的仓库/读写操作接受控宿主 gh 调用，避免把原始凭据散发到模型环境。
- **纠正旧建议**：细粒度 PAT 可以缩小 token 的仓库/权限范围，但仍绑定生成它的 GitHub 用户，不会自动形成独立猫身份。参见 [GitHub 官方 PAT 说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。无需在聊天里发送 token。
- **下一步**：先明确“读什么、是否允许创建 PR/评论”等实际权限，再给出接线和验证。宿主凭据在宿主保管；权限扩张、运行配置或账号登录动作仍按现有边界由 operator 决定/执行。不能把“发一个 token”作为开始定位的前置条件。
- **状态**：环境差异已验证，授权与接线未落地。

## Chrome 已恢复的准确边界（不另计入上述四项）

- 重载标记解除后，三条向“介绍ACP含义”的发送仍以 `COMPOSER_NATIVE_INSERT_UNAVAILABLE`、`failed_before_submit` 失败。
- 用户按提示操作后，新消息 `0001795340445888-000655-3d405790` 在 09:40:46 获得真实 Host message ID；09:40:58 的 callback `0001795340458489-000658-83d5642a` 精确回复该 source，证明这一次发送与回传均成功。
- **准确状态是“操作后恢复可用，代码未修”**。输入框选区由外部回到内部，与恢复一致；具体触发原因仍为推断。“结果未知”掩盖明确写入失败也尚未修正。不得登记为“砚砚61 已修复代码”，也不能用这次成功关闭 MCP 读取 429。

## 证据入口

- API PID 94213，cwd 为 `cat-cafe-runtime/packages/api`；只读复核 `packages/api/data/logs/api/api.2026-11-22.2.log` 和上述精确消息 ID。
- `.cat-cafe/plugin-host/personal-chrome-host/delivery-ledger.json`：仅用于核对已有发送记录。
- PR #76 / commit `d425e40e7`：原 ACP 重放门的来源。
- 所有实验在临时测试目录或隔离工位完成；未删除数据、重置会话或修改运行配置。
