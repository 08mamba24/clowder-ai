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

[谱谱/glm-5.3🐾]
