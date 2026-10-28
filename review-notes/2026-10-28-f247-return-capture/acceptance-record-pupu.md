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

## 修正（14:4x，operator 定"沿用 A"后按 gpt-pro 约束重核）

上一节"Browser 路径三层阻塞"**结论错误，予以推翻**——重核证据（绝对路径，真实宿主）：

1. **Native 通道健康活跃**（此前 `~/` 又落沙盒 HOME，重查修正）：
   - `/Users/yuhan/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.catcafe.personal_cloud_cat_host.json`
     存在（19:11 更新），指向 runtime plugin-host 的 native-host-launcher.mjs，
     allowed_origins = 扩展 `mjpbglbfkbjhnamnafkodgdpgfhjoife`。
   - launcher / pairing / delivery-ledger 全在；**ledger 22:36 仍在写**。
   - 决定性证据：ledger 最新 4 条的 idempotencyKey 精确对应 operator
     14:31-14:36 的四条消息（0001793197886431 / 0001793198009023 /
     0001793198160301 / 0001793198181023）——dispatch→Native→扩展→页面
     全链路活着。前三条 `HOST_MESSAGE_NOT_OBSERVED`（旧 bundle 的
     roleless 盲，正是 PR #59 修的），第 4 条 `CHATGPT_GENERATING`
     （上一条回答生成中，单次发送保护诚实拒绝——#50 语义正常）。
2. **install 的 chrome_web_store 硬门不构成阻塞**：现有安装健康，
   本轮无需 install；更新走 A 路径刷新扩展产物即可。
3. **inspect 报 `helper: invalid` 的真实机制（finding，非故障）**：
   pairing.json 的 artifactDigest=`sha512:d1a4e1ae…` 落后于 artifacts
   已部署的新一代（`7ed2cebe…`，19:11 升级未同步 re-pair）。Chrome 实际
   通道不校验该账目，ledger 照常工作。后续应修 re-pair 同步，不阻塞本轮。

**Browser 路径剩余唯一断点 = 扩展 bundle 旧版（0.2.13 / pageAdapter
2026-09-24.1）对 roleless DOM 盲。** 修复已在 PR #59（170a1b689）。

### 终验时序（按 gpt-pro 约束：只部署复审过的固定产物）

1. PR #59 复审 merge（点点 push → 金哥复审，进行中）
2. live runtime 升级到 merge commit（常规 runtime 部署链）
3. Chrome 扩展 reload（A 路径，同 ID `mjpbglbfkbjhnamnafkodgdpgfhjoife`
   不变，unpacked 目录重读）
4. operator 下一条 @gpt-pro 自然成为验收 dispatch；读 ledger 新条目：
   预期 `HOST_MESSAGE_NOT_OBSERVED` → `HOST_MESSAGE_ID_UNAVAILABLE`
   （页面无真 ID 时，诚实失败）；若 ChatGPT 恢复暴露 data-message-id 则
   正常回执 + assistant 观察启动。MCP 路径同轮对照（gpt-pro 回帖可见）。
