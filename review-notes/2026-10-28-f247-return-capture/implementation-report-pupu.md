# F247 roleless DOM 修复实施报告（谱谱 → 砚砚61 review）

实施 Task: `0001793189086951-000806-8ea079cf`；review Task: `0001793188260821-000795-d067a1ba`。
基础：origin/main `53a775861d2e785bb401b74571ecb2787a62e73c`（handoff 指定）。

## 交付物

- **HEAD**: `b387f092a`（分支 `fix/f247-roleless-dom-return`，独立 worktree
  `/Users/yuhan/cat-cafe/clowder-ai-f247-roleless`）
- **push 状态：未推**。gh token 失效（`gh auth status`: token in default is invalid，
  账号 08mamba24），osxkeychain 无 github.com 条目。需要 operator 重新认证后
  `git push -u origin fix/f247-roleless-dom-return` 再开 PR。不绕过凭据防线。

## 根因与修法

ChatGPT Pro 页面 DOM roleless 化（2026-10-28 现场）：user/assistant 消息不再暴露
`data-message-author-role` / `data-message-id` / `conversation-turn-*`，改用
`data-user-message-bubble` + `data-content-search-unit-key="fallback-turn-N:M:role"`。
旧观察器全盲 → receipt 一律 `HOST_MESSAGE_NOT_OBSERVED` → assistant observer 从不启动。

修复（不冒充、不降格）：

1. roleless user bubble / assistant unit 进入统一消息序列（legacy ∪ roleless，DOM 序），
   receipt 与因果 assistant 观察共用；正文投影用逐 text-node 精确匹配
   （排除 button/a/svg），与现场证据一致（正文为单一 text node，SHA-256=digest）。
2. **新错误码 `HOST_MESSAGE_ID_UNAVAILABLE`**：正文精确匹配但页面未暴露真实 Host ID
   → 如实区分于"根本没观察到"（`HOST_MESSAGE_NOT_OBSERVED`）。无真实 ID 不 resolve、
   不自动重发（保留 #50）；`fallback-turn-*` 永不冒充 hostMessageId（有专项测试）。
3. 诊断增强：assistantObservationDiagnostic 加 `rolelessAssistantUnitCount`；
   receipt 失败附 roleless 命中/歧义快照。白名单同步两层 validator
   （service-worker.js `validAssistantObservationDiagnostic`、
   native-host assistant-return-inbox.mjs）。
4. revision `2026-09-24.1 → 2026-10-28.1` 五方对齐（protocol.ts / content-script-entry /
   bundle / host-spike / state-health + extension-contract 契约测试 regex）。
5. 未提出新 browser-proof 协议：本次没有降格也没有引入新的观察协议——
   roleless 无 ID 走既有协议的诚实失败分支（新错误码只是更准确的诊断）。
   若未来要恢复无 ID 场景的 browser receipt，按 handoff 另立 provenance/去重/
   跨轮次隔离提案交 review。

## RED→GREEN

- 新测试 `packages/api/test/personal-chrome-page-adapter-roleless-dom.test.js`：
  泛化 fixture（无真实 source/会话坐标），8 项先 **8/8 RED**（旧行为全部报笼统
  HOST_MESSAGE_NOT_OBSERVED），修复后 **8/8 GREEN**。覆盖：无 ID 失败码、
  fallback-key 不冒充、正文被改保持 NOT_OBSERVED、有真 ID 正常 resolve、
  歧义双泡泡 ambiguous 诊断、legacy 不误配、roleless assistant final、
  roleless 诊断计数。
- 官方 F247 gate `pnpm -C packages/api run test:f247-chrome-host-spike`：
  **26/26 + 199/199 全绿**（新文件已加入该 gate 的显式列表）。
- 重复命令：`pnpm -C packages/api run build && pnpm -C packages/api run test:f247-chrome-host-spike`。
- biome error 级干净（service-worker:153 control-char regex warning 为基线遗留）。

## start-dev 缺口核查结论（不改代码，证据如下）

`scripts/f247-cloud-services.mjs` 在本仓 git 全历史（含 cat-cafe 私有 remote 所有分支）
从未存在。`check-env-port-drift.test.mjs` 的 `cloud:doctor/cloud:status/...` 清单是
home-only 剥离记录；`start-dev-profile-isolation.test.mjs:468` 断言 helper 引用必须在
（sandbox 用空文件模拟）。即：helper 引用是有意的 forward-compatible 钩子，
`[ -f ]` 保护使公开仓静默跳过；`pnpm cloud:doctor` 提示文本在公开仓运行时不可达
（helper 缺失先返回）。真实启动入口是本机 `~/.cat-cafe/cloud-tunnel/start-local-mcp.mjs`
（见下），已恢复使用。改 shell 文本反而与共享源漂移，故不动。

## MCP 主回程恢复（三层验真，凭据全复用未轮换）

修正一个 handoff 前的误判：本 agent 沙盒 HOME=/Users/yuhan/.cat-cafe/zcode/app-server-home，
`~/` 搜索查错位置；真实用户目录 `/Users/yuhan/.cat-cafe/cloud-tunnel/` 凭据齐全。

1. **3098 spike**：`node /Users/yuhan/.cat-cafe/cloud-tunnel/start-local-mcp.mjs`
   → pid 90587，`/health` OK（cat-cafe-cloud-pro-b1a, cloud-pro-phase0, gpt-pro）。
   token 文件 `wx` 语义只读不写，未轮换。
2. **authenticated MCP**：Bearer initialize 成功；无凭据 401（防线在）；
   `tools/list` 17 项含 `cat_cafe_post_message`。
3. **durable exact-source 回帖**：经 `cat_cafe_post_message`（gpt-pro sidecar 身份）
   replyTo=`0001793188493776-000798-749385ba`（operator 11:54 @gpt-pro 的获授权 source）
   → `{"status":"ok","messageId":"0001793192000385-000856-374a5548","replyTo":"0001793188493776-000798-749385ba","message":"消息已存储"}`。
4. **tunnel**：`python3 /Users/yuhan/.cat-cafe/cloud-tunnel/connect-tunnel.py`
   → `running:true, ready:true, runtime_state:ready`（tmux `tunnel-mcp__cat-cafe-gpt-pro__64026c0a`
   长驻；tunnel_6ab26fecd910819195c99283e33d5a04 → 127.0.0.1:3098/mcp）。

## upstream 参照

无新增 upstream 代码引入。沿 handoff 冻结结论：upstream host `289e124f79…` /
plugin `c261cebc39…` 均无 roleless DOM 兼容（实读确认，selector 更窄），
且 plugin 存在本仓 #50 已修掉的发送后重试形态，不整包覆盖。

## 验收边界（如实）

- 已验证：单测/集成全绿；3098/tunnel/durable 回帖真实通路。
- **未验证**：修复后的扩展（0.2.13 + adapter 2026-10-28.1）尚未构建安装到 live Chrome——
  按 handoff"运行态激活先做实审查产物"，等本 review 通过后再走
  `f247-personal-chrome-install.mjs` 部署 + 真实 ChatGPT 页面端到端（新 dispatch 的
  receipt 应报 `HOST_MESSAGE_ID_UNAVAILABLE` 而非笼统超时；若 ChatGPT 恢复暴露
  data-message-id 则 receipt 正常 resolve）。
- live runtime 与 API 父进程未动；全部开发测试在隔离 worktree/stores。

## 需要 operator 的一件事

push/PR 凭据：`gh auth login`（08mamba24）或等价 PAT 入 keychain；之后
`git -C /Users/yuhan/cat-cafe/clowder-ai-f247-roleless push -u origin fix/f247-roleless-dom-return`。
今日不处理则 review 只能基于本地 HEAD b387f092a diff，PR 与 CI 延后。

## 结构化通道备忘（F223 缺口记录）

本会话（zcode/acp）工具目录无 `cat_cafe_*` / `cat_cafe_hold_ball`；invocation 凭证
（`$CAT_CAFE_INVOCATION_ID` / `$CAT_CAFE_CALLBACK_TOKEN`）未注入 shell 环境；
本地 mcp-server 为 stdio 形态无独立 HTTP 端口（4100=preview、18789=openclaw、
3098=gpt-pro 云端白名单，无任务面工具且身份不可借用）。按 callbacks instructions
的官方降级路径，球权移交以最终回复的行首 @（@cat-yanyan61 review + @co-creator
push 凭据）完成；本 commit 即 durable 状态迁移凭证（实施完成、待 review、push 阻塞）。
