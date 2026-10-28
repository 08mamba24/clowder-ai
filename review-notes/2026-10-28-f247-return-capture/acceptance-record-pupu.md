# F247 双回传路径验收记录（谱谱，进行中）

任务链：operator `0001793196569847-000964-f3242319` → gpt-pro 交办（14:12）：
修复 → 双路径实机验收 → 上游定向移植。不把错误码改善算作恢复；有阻塞如实标明。

## 状态总览

| 项 | 状态 |
|---|---|
| origin PR #59 P1/P2 修复 | 完成，HEAD `170a1b689`（作者工作树已 commit；push/复审在点点/金哥） |
| MCP 回帖主路径验收 | **PASS（3/3）** |
| Browser 路径验收 | **BLOCKED（3 项阻塞，见下）** |
| 上游移植 | 前置核查完成；实施等 origin 合入 |

## MCP 回帖主路径验收（PASS）

通道：3098 spike + tunnel（本日恢复，凭据复用未轮换）。
测试身份：gpt-pro sidecar（操作者谱谱，验收消息均带标注）。

1. **exact-source 绑定**：replyTo=`0001793188493776-000798-749385ba`（operator 11:54
   获授权 source），回帖 messageId `0001793192000385-000856-374a5548`，服务端回执
   `"status":"ok"` + replyTo 精确回显。
2. **持久化**：该消息在 thread 可见（对话历史 12:53 UTC 条目，durable）。
3. **去重/幂等**：14:2x 对同一 source 第二次回帖 → 服务端返回
   `"status":"duplicate", messageId=<原 id>`，**未产生新消息**。one-shot grant
   语义工作正常。

结论：gpt-pro 主动回帖主路径（MCP）恢复并验真。这是当前唯一恢复的回传路径。

## Browser 路径验收（BLOCKED——如实：尚未恢复）

修复代码（170a1b689）使 roleless DOM 下诊断诚实（HOST_MESSAGE_ID_UNAVAILABLE
区分于笼统超时），但端到端回传仍不通，三层阻塞（全部实测证据）：

1. **Native host manifest 缺失**（通道层）：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
   目录为空；live runtime `install.mjs inspect` → `helper: invalid`、
   `config: invalid`、`live: degraded`。3 条会话授权仍在（含现场
   6ab21d2a…，9/24 授权）。即：9/24 后 Native 通道已断，早于 roleless DOM 改版。
2. **install 被分发 channel 硬门挡住**：`install.mjs install` →
   "a published Chrome Web Store listing is required before installation"。
   `f247-personal-chrome-distribution.mjs` 硬编码 `channel: 'chrome_web_store'`，
   listing 未配置（`CHROME_WEB_STORE_LISTING_NOT_CONFIGURED`），CLI 无 channel
   override。9/22-9/24 当初的 developer_preview 安装入口不在此路径（待查
   plugin-routes 侧）。**这是分发策略决策，不是执行可绕**。
3. **扩展 bundle 未部署**：live 扩展仍 2026-09-24.1；新 bundle（170a1b689）
   在 PR 分支，等 origin 合入 + runtime 升级 + 扩展刷新（P3 merge note 已写）。

就绪后的触发条件：需要一次新 dispatch（operator 在猫咖 @gpt-pro）做真实验收；
观察项：本轮消息识别、真实 Host ID 可得性（现场 DOM 无真 ID，预期
HOST_MESSAGE_ID_UNAVAILABLE + 观察器不启动 = 诚实失败，**不得记为 E2E PASS**），
以及 MCP 路径同轮对照。

### 补充方案（阻塞 2 的决策项，需 operator 拍板）

- 方案 A（快，恢复到 9 月的用法）：恢复 developer 直接加载入口
  （查 `personal-chrome-plugin-routes.ts` 侧的 developer_preview 安装路径或
  unpacked load），重装 helper + 从 runtime 加载新 bundle。
- 方案 B（正式，长周期）：配置 Chrome Web Store listing（$5 开发者费 + 审核），
  走已上架分发。

建议 A：验收要的是真实链路，正式上架是分发里程碑，两者不互相阻塞。

## 上游移植前置核查（只读，2026-10-28 14:2x）

- plugins 仓 fetch 成功，最新 main `06bf519`（#147 wechat fix，今日）。
- `origin/main:packages/personal-chrome-companion/extension/chatgpt-page-adapter.mjs`
  中 `data-user-message-bubble` / `data-content-search-unit-key` 引用 = **0**；
  10-20 以来该包无相关提交。gpt-pro 13:55 结论在新时点仍成立：**上游未修，
  移植仍有价值**；#95（Dot Cloud Bridge draft）不含 page adapter 改动，仅作线索。
- 移植实施等 origin 合入 + 验收记录补齐后启动（gpt-pro 交办要求的前置顺序）。

## 待办队列

1. [外部] 点点 push 170a1b689 → 金哥复审 → merge（含 P3 merge note）
2. [operator] 分发通道决策（A/B 上述）
3. [operator] 通道就绪后触发一次新 dispatch 做 Browser 路径真实验收
4. [谱谱] 验收记录补齐 + 上游移植（独立分支、收窄范围、回交 gpt-pro review）
