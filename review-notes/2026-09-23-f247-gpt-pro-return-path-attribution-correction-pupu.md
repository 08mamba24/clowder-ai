# F247 — ChatGPT Pro 回程链路归因修正（谱谱自查 + 砚砚活体证据交叉）

- 日期：2026-09-23
- 作者：谱谱 (@zcode, glm-5.3)
- 触发：砚砚转来关键新证据——仍打开的 Chrome 会话 `6ab27a37…` 在 09-22 14:37 UTC 的 turn（sourceMessageId `0001790087840498-000741-7e166362`）下**有可见 ChatGPT assistant 回复**，内容自述"本轮读取成功，但没有完成回传；当前插件返回的 10 个工具定义中没有 cat_cafe_post_message"。
- 结论一句话：我此前把 `ASSISTANT_FINAL_NOT_OBSERVED` 读成"网页里连可见回复都没有 / gpt-pro 没回复 / 页面可能被关"，是**误读仪器盲区为事件缺失**。真实情况：回复存在；观察器因 turn 选择器失配整体失明。

## 一、修正前的错误归因（谱谱上一 session 原话）

> "ASSISTANT_FINAL_NOT_OBSERVED = 网页里连可见回复都没有！"
> "gpt-pro never responded in that conversation"
> "userTurnConnected:false 还提示投递后页面可能被关/切走，观察窗口断了"

## 二、账本实证（我侧真实 ledger）

`cat-cafe-runtime/.cat-cafe/plugin-host/personal-chrome-host/delivery-ledger.json`（10 条，09-22 06:24–14:37 UTC）：

- `7e166362`：state=`host_observed`，hostMessageId=`b38aedfb…`，submit 14:37:22 UTC；`assistantObservationFailure` 记于 **14:55:01.278Z**，errorCode=`ASSISTANT_FINAL_NOT_OBSERVED`，diagnostic 全零：`userTurnConnected:false, anchorTurnFound:false, followingTurnCount:0, assistantCandidateCount:0, laterUserTurnPresent:false, …not_observed, streamingControlPresent:false`。
- 10 条中 **7 条同一全零签名**，跨 3 个会话（6ab21d2a / 6ab22095 / 6ab27a37），全部从 09-22 06:24 起。

推演：若是"模型没回复"，锚定的 user turn 应仍在（anchorTurnFound:true、followingTurnCount≥0）。`anchorTurnFound:false` = 连我们自己注入的 user turn 都在 turn 枚举里找不到；而 host_observed 阶段确实锚定成功、且砚砚活体检查证明该 turn 至今可见。唯一自洽解释：`MESSAGE_TURN_SELECTOR = 'article[data-testid^="conversation-turn-"], article'`（`chatgpt-page-adapter.mjs:31`）与当前 DOM 不匹配（turn 容器漂移，砚砚观察为 `<section>`）→ `querySelectorAll` 枚举为空 → 观察器全盲，与"有没有回复"无关。**砚砚的 DOM 漂移假说成立，我接受并修正。**

附带仪器伪影：submit 14:37:22 → failure 14:55:01，间隔 ~17.6 分钟 >> `assistantObservationTimeoutMs=120s`——后台 tab 定时器节流所致，诊断时间戳≠页面事件时间，不能当"14:55 时页面状态"用（我上一 session 正是这么误用的）。

## 三、主动回程缺口的本地实证（"10 个工具"之谜）

ChatGPT 侧 agent 说"插件返回的 10 个工具定义中没有 cat_cafe_post_message"。我侧核实：

1. 白名单源码：`cat_cafe_post_message` / `cat_cafe_cross_post_message` 均在 `desktop:cloud-pro-phase0` profile（`packages/mcp-server/src/tools/callback-tools.ts:3337/3548`，2026-08-27 起）。
2. 3098 活体 `tools/list`（本日验证）：**12 个工具，含 post_message**。`tool-schemas.json`（09-22 12:39 UTC 生成）同为 12 含 post_message。
3. → 缺口在 ChatGPT 连接器一侧：12−10 恰好差 `post_message` + `cross_post_message` 一对**写工具**。最可能：OpenAI 连接器对 write 型 action（readOnlyHint=false）要求用户在 ChatGPT UI 逐个 approve，或缓存了旧 tools/list。**这步只有 operator 能在网页上确认/开启。**
4. 防线核对：`mcp.log` 50 行中 34 次 `auth=absent`（`remote-spike.ts` fail-closed 拒绝的外部探测）vs 3 次 `auth=present`（真实隧道调用）——token 防线正常。

⚠️ 顺带：`~/.cat-cafe/cloud-tunnel/control-plane.txt` 以明文存放外部 API 凭据，本 note 不引用其值，建议家里评估是否收敛存放方式。

## 四、ChatGPT Pro 接入剩余问题清单（修正后）

1. **观察半区（P1，F247 名下）**：turn 选择器 article→section 漂移致观察全盲。修复方向：selector 增加 section 变体、以 `data-message-id`/`data-testid` 锚定而非标签名；diagnostic 增加 selector-hit 计数以区分"枚举空"与"无回复"。
2. **主动回程（P1，需 operator）**：ChatGPT 连接器未暴露 post_message/cross_post_message（本地已供 12 含写工具）。需在 ChatGPT 连接器设置确认 write action 审批状态。
3. **已知独立坑（维持上轮结论）**：dogfood thread（mu94xx）从未绑定会话，@gpt-pro 只会得到"尚未绑定"提示。

## 五、F167 disposition 工具缺口（F223 记录）

本次 A2A 我无法调用 `cat_cafe_complete_a2a_dispatch`：本 session 工具目录无任何 `cat_cafe_*` MCP 工具（仅挂了只读 github-read）；HTTP 路由存在但 invocation token 401（`mcp-creds` 内 zcode 凭证停留在 09-21，本 invocation 未落新凭证文件）。按 callbacks 官方文档 fallback 用行首 `@` 交付。此 execution surface 缺口按 F223 记录，建议给 zcode carrier 补 A2A disposition 通道。

## 六、第二轮修正（同日 09-23 晚，砚砚6 新实证路由回谱谱）

### 6.1 撤回"需 operator 开启写工具"归因（第三节第 3 步）

新证据（砚砚6 提供，operator 在场）：

1. operator 截图同时显示 `cat_cafe_post_message` / `cat_cafe_cross_post_message` 两个写工具都在 ChatGPT 插件工具列表里；插件目录列出 12 个工具、含这两项。
2. **主动回程闭环已打通**：source `0001790147529000-000132-de6f7599`（"@gpt-pro 你能看到这个吗"）07:12:11Z `host_observed`；gpt-pro durable reply `0001790147553993-000135-999b37de`（content=ok，replyTo 精确指向 source）07:12:33Z 写入猫咖。
3. → 旧回合自述"10 个工具、无 post_message"只能定性为**当轮自述**：无 tools/list 历史快照，不能反推"连接器未暴露/未审批"。第三节"最可能是 write action 审批"的推断**撤回**；第四节剩余问题第 2 条（需 operator 确认审批）**关闭**。

### 6.2 Chrome observer 盲区维持并已修复（本地分支）

同一闭环里，ledger 07:14:13Z 仍记 `ASSISTANT_FINAL_NOT_OBSERVED`，四零诊断（userTurnConnected=false / anchorTurnFound=false / followingTurnCount=0 / assistantCandidateCount=0），expected=observed revision（extension 0.2.10 / pageAdapter 2026-09-02.1，排除 STALE_ADAPTER）。主动 MCP 回程可用 + 页面观察兜底失明并存，与第二节 selector 漂移结论一致。

砚砚6 另做了无副作用 JSDOM RED 复现（section 轮次包住带 data-message-id 的消息 → adapter 回 hostMessageId 成功、observer 30ms 后产出与真实 ledger 相同的四零）。

**修复已落地**（cat-cafe worktree `cat-cafe-f247-turn-selector`，分支 `fix/f247-personal-chrome-turn-selector`，commit `82f3be174`，待 push+PR+跨猫 review）：

- `MESSAGE_TURN_SELECTOR` 改为标签无关的 `[data-testid^="conversation-turn-"], article`（article 保留为 legacy fallback，新旧 DOM 都能锚定）。
- durable diagnostic 增加 `turnMatchCount` / `userMessageCount` / `assistantMessageCount`，"观察器瞎"与"真没回复"从此可区分；三处白名单同步（service-worker.js、assistant-return-inbox.mjs——均为精确键数校验，漏一处即 fail-closed 丢回执）。
- revision 全量 bump：extension `0.2.11` / pageAdapter `2026-09-23.1`（manifest、entry、bundle、protocol.ts、state-health 脚本、spike 脚本六处硬编码副本；state-health 已加入 contract 对齐测试防下次漂移）。
- 回归：section 轮次端到端（旧 selector 下 RED）+ selector-blind 诊断；personal-chrome 套件 188/188 绿，biome 过（2 个 warning 为存量）。
- 部署提示：merge 后需更新 runtime checkout 并重装/重载扩展，否则旧扩展会被新 server 以 STALE_PAGE_ADAPTER 拒收（这是 revision 机制的正确行为）。

### 6.3 本轮 F167 处置

zcode carrier 依然无 `cat_cafe_*` MCP 工具，且本次 env 连 `CAT_CAFE_API_URL` / `CAT_CAFE_INVOCATION_ID` / callback token 都未注入（HTTP 回调通道整体缺失，比上次"token 401"更早一层）。继续按已记录的行首 `@` 文本交付，缺口维持 F223 记录。

[谱谱/glm-5.3🐾]
