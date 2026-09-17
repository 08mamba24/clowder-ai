# 跨线程误投问题 upstream 定位 + 两轮跨族复审归档 — 谱谱/pupu

- 作者：谱谱/pupu（@zcode，glm-5.3）
- 复审：砚砚/缅因猫（gpt-5.6-sol），非作者、跨族
- 复审轮次：round-1 退回（P1 出处指控 + 2×P2）→ round-2 **放行 APPROVED**（P1 指控撤回）
- 任务来源：co-creator 2026-09-17 14:53 UTC ——「猫猫传球时跨线程找到别的会话里的猫猫，但当前会话就可以传球；查 upstream issue/PR 与已有修复」
- 本文措辞边界由 round-2 verdict 指定，见 §二/§六。

---

## 一、结论（按复审批准的措辞）

1. **本地代码证实存在可复现的跨线程误投路径**（锚点见 §五）。不写「路由器没 bug」、不写「本次 incident 根因已定位」——本次本地 incident 无 trace，机制未证实。
2. upstream `zts212653/clowder-ai` 存在**相同症状类别、候选机制匹配**的两个 open issue：#577（通用交接误投）与 #1397（P1，review carrier 选错 owner thread）。**核心修复未落地**：仅 #316/#317（commit `82b973f1e`）修掉了 post_message 携带 stale threadId 这一个入口；admission guard、`list_threads` 返回 `projectPath` 等护栏均未实现。
3. 建议（round-2 已放行）：**①跟踪 #577/#1397 + ③本地立即补发送侧硬规则**。措辞要求：当前「存在可跟踪 issue、不存在可等待的修复 PR」，应写「**PR 出现并合入后再评估 sync**」。
4. tracking 尚未注册（本 session 回调凭证不可用，§六），故本文写「**建议订阅**」，不是「已订阅」。

## 二、复审指定的措辞边界（round-2 verdict 原文摘录）

- 只能写「代码证实存在可复现的误投路径」；不得写「路由器没 bug」或「本次 incident 根因已定位」。
- 历史 ghost-thread 报告记录了 **continuation/callback credential 错绑**这一**不同候选机制**，归档时保留为并行候选。
- 涉及本地 incident 时写「相同症状类别、候选机制匹配」，不写「同一 failure family」。
- 归档须原样保留 API endpoint、HTTP status、查询时间、`html_url/title/state/created_at/labels/user.login/pull_request` 字段；注明本机 `gh` 未认证、live API 为谱谱采集，砚砚独立确认的仅本地 Git ancestry。

## 三、upstream 对象 live 证据（谱谱采集，原样字段）

采集方式：未认证 `curl https://api.github.com`（公开仓库只读）。查询时间：首轮 2026-09-17 **14:53–15:12 UTC** 窗口；复核轮 **15:29–15:35:18Z**。本机 `gh` 未登录；砚砚未独立复跑 live API。

| 编号 | endpoint | HTTP | 字段（复核轮原样） |
|---|---|---|---|
| issue #577 | `GET /repos/zts212653/clowder-ai/issues/577` | 200 | `html_url=https://github.com/zts212653/clowder-ai/issues/577`；`title=Bug: 交接任务时可能通过 list_threads + cross_post_message 误投到错误 thread`；`state=open`；`created_at=2026-04-24T07:09:06Z`；`labels=[bug, triaged, needs-maintainer-decision]`；`user.login=mindfn`；**无 `pull_request` 键**（`is_pull_request=false`） |
| 同号 PR 探针 | `GET /repos/zts212653/clowder-ai/pulls/577` | **404** | 该仓库不存在 PR #577（closed 的 PR 也会返回 200；编号空间 issue/PR 共用且永不复用） |
| issue #1397 | `GET /repos/zts212653/clowder-ai/issues/1397` | 200 | `html_url=https://github.com/zts212653/clowder-ai/issues/1397`；`title=P1: review routing can choose a reviewer's unrelated active thread instead of the subject owner thread`；`state=open`；`created_at=2026-08-26T03:50:45Z`；`labels=[bug, triaged, accepted, needs-info]`；`user.login=mindfn`；**无 `pull_request` 键** |
| 同号 PR 探针 | `GET /repos/zts212653/clowder-ai/pulls/1397` | **404** | 同上 |
| PR #317 | `GET /repos/zts212653/clowder-ai/pulls/317` | 200 | `title=fix(#316): remove threadId from post_message MCP tool`；`user.login=mindfn`；`state=closed`；`merged_at=2026-04-01T01:12:13Z`；`merged_by=zts212653` |
| issue #316 | `GET /repos/zts212653/clowder-ai/issues/316` | 200 | `title=post_message threadId 参数导致 agent session 上下文泄漏跨 thread 投递`；`state=closed`；`user.login=mindfn`；`is_pr=false` |

## 四、编号空间争议与裁决（round-1 P1 → round-2 撤回）

Round-1 指控：#577/#1397「不可能为 open issue，因为本地 Git 记录它们是已合并 PR（F101 `f0d88af05…` / F174 `74ea5ebec…`）」。裁决证据（双方均独立验证）：

1. 两枚 commit 在仓库内真实存在（`GET …/commits/<sha>` → 200，message 含 `(#577)`/`(#1397)`；`f0d88af05` authored 2026-03-19，`74ea5ebec` authored 2026-04-25，均**早于**同号 issue 创建时间）。
2. 但两枚 commit **仅被 `feat/f253-phase-c` 分支包含**，与 main 无共同祖先：本地 `git merge-base --is-ancestor <sha> upstream/main` 均为 false、`git branch -a --contains` 仅 `remotes/upstream/feat/f253-phase-c`；远端 `GET …/git/ref/heads/feat/f253-phase-c` → 200（head `b7a3d02b`），`GET …/compare/<sha>…<live-main>` → 404（无关史比较）。
3. 该侧分支是 2026-03-19/20 从私有仓库 `zts212653/cat-cafe`（未认证访问 404 = 私有）迁移的 sync 血统；commit title 里的 `(#577)/(#1397)` 是**私有 cat-cafe 的 PR 号**，不属于 clowder-ai 公开仓库编号空间。旁证：main 自身近期 commit（`(#1391)`、`(#1396)`）与 clowder-ai 真实 PR 一一对应——`git log --all` 混合两条血统正是误判来源。
4. 决定性证据仍为 §三 的 `pulls/577`、`pulls/1397` 双 404 + 同号 issue 存在且 `is_pull_request=false`。

Round-2 verdict：**P1 撤回，push back 接受**；谱谱编号空间解释与本地 Git 拓扑相容（砚砚独立确认 ancestry 部分）。

附注（fetch 状态）：本地 `upstream/main` = `22385b60e`，早前 `git fetch upstream` 因 RPC 错误半途失败；GitHub live main = `b2927441b`（15:33Z 查询）。ancestry 结论以远端 compare/ref API 为准，不依赖本地 stale ref。

## 五、本地代码证据（可复现误投路径锚点）

链路核查（探索 agent 全量读路由链 + 砚砚抽查）：

- 主链路（同 thread 行首 @）按 `(catId, threadId, userId)` 隔离：A2A 入队以 `opts.triggerMessage.threadId` 为作用域（`callback-a2a-trigger.ts` enqueueA2ATargets）；SessionChainStore active 键 `userId+catId+threadId`；invocation-token 携带 `threadId` 的 `post_message` 被 MCP guard 拒绝（`packages/mcp-server/src/tools/callback-tools.ts:1104-1151`；公开 schema 不再 advertise threadId，`:466-475`）。
- **误投路径（可复现）**：`packages/api/src/routes/callbacks.ts:2160-2182` 的 `effectiveThreadId` 覆盖分支——回调显式携带目标 threadId（crossPost）即把投递切到该 thread；配合 `list_threads` 仅按 title/threadId 关键词匹配、返回 `lastActiveAt/pinned` 但**不返回 `projectPath`**（`callbacks.ts:5000-5033`），「按猫名搜 thread → 选中无关旧置顶 thread → cross_post_message」的链路无任何 subject-affinity admission 拦截（#1397 维护者评论亦确认服务端无 admission check）。
- 校正（round-1 校正点，已接受）：API 层 `postMessageSchema` 保留可选 `threadId` 是 cross_post_message/agent-key 路径的**刻意复用**，invocation-token 入口已被 guard 覆盖（砚砚 MCP 定向契约 24/24、F167 review handoff source contract 2/2 通过），不作为「未清理」证据。

## 六、证据边界与未取得项

- **本地 incident trace 未取得**：仓库 `cat-cafe.log` 为 2026-06-03 旧快照（`DIAG/ghost-thread`/`crossPost` 零命中）；`~/.cat-cafe/chat` 为空；未发现运行中实例；本 session 未注入 `cat_cafe_*` 工具且回调 env（`$CAT_CAFE_API_URL`/`$CAT_CAFE_INVOCATION_ID`/`$CAT_CAFE_CALLBACK_TOKEN`）为空，无法深检索消息库或注册 tracking。后续取证路径：live 运行时日志按 `[DIAG/ghost-thread]` 与 `extra.crossPost.sourceThreadId` 检索 + incident 的 sourceMessageId tool-call 审计。
- **并行候选机制**：历史 ghost-thread 报告记录过 continuation/callback credential 错绑（恢复的 ACP 会话冻结旧线程 env），与「list_threads→cross_post」为不同候选；在取得 trace 前不裁决哪个适用于本次 incident。
- 因此 §一.1 的措辞是上限：可复现路径存在 ≠ 本次事故机制证实。

## 七、upstream 修复状态清单

| 项 | 状态 | 出处 |
|---|---|---|
| post_message MCP 工具移除隐藏 threadId | **已修**（PR #317，merged 2026-04-01，commit `82b973f1e`） | #316/#317 |
| `list_threads` 返回 `lastActiveAt`/`pinned` | 已有 | 本地代码 |
| `list_threads` 返回 `projectPath`（区分项目上下文） | **未修** | #577 P1 建议 |
| cross_post_message 的 subject-affinity admission guard（fail-closed） | **未修**，#1397 accepted 待实现（方向：subject owner 决定 carrier；recipient 身份/最近活跃度不得参与选择；跨 thread 需 typed 归属证据） | #1397 |
| #577 P2（cross_multi_mention 原语） | needs-maintainer-decision，社区意见倾向暂不引入 | #577 评论 |
| 相关：#1335（目标猫忙时行首 @ 交接被 `dedup_active` 静默丢弃） | open，accepted，与本问题症状不同（球被丢 vs 投错处），同属交接生命周期 | #1335 |

## 八、建议与待办（2026-09-17 17:07 UTC 更新：③ 已落地并终审放行）

- **③ 本地发送侧硬规则 —— 已落地**（operator 16:30 UTC 批准，按 ③→②→① 顺序执行）。最终措辞经三轮 review 演化为 ownership-first 谓词（与下文原拟稿的差异见 §九.b）：「本 thread 拥有该主体→留本 thread；仅限目标 thread 拥有主体/显式 threadId/可验证转移，禁按猫名/活跃度选 carrier（F号 定位 owner thread 除外）」。落点：`assets/prompt-templates/mcp-tools.md`（净增 +50 字符，预算内）、`cat-cafe-skills/request-review/SKILL.md`、`packages/mcp-server/src/tools/callback-tools.ts`（threadId/keyword 描述）+ 钉子测试 `cross-post-carrier-invariant.test.ts`。Commits：`cfae99212`（round-1）→ `d40cfcaa2`（round-2 修复）→ `129ac0e4c`（round-3 谓词钉子，**终审 APPROVED exact HEAD**，2026-09-17 17:07 UTC）。三轮 review 均为砚砚/缅因猫（跨族）。**push 待凭据**。
- **① 跟踪 #577/#1397**：仍待有回调凭证的会话注册 issue tracking；**PR 出现并合入后再评估 sync**（fork 落后 upstream/main 约 2 commit，sync 成本低）。
- **② 向 upstream 补充证据/评论**：英文草稿已交 operator（内容：迁移血统 PR 号陷阱考据 + 本地 sender-side 缓解描述，无私有坐标），待其以家里 GitHub 身份发布。

### 八.a 原拟稿（历史保留，已被三轮 review 修订）

原拟稿措辞：「当当前 thread 已有可路由目标猫（roster 在册且未禁用）时，carrier 必须留在当前 thread：直接行首 @句柄 或 post_message；禁止以目标猫名字/最近活跃度为关键词 list_threads 选择投递 thread；禁止在无 subject 归属证据时调用 cross_post_message。跨 thread 投递仅允许：目标 thread 拥有该工作主体、用户/feature 显式给出 threadId、或有可验证的归属转移证据。」——round-2 review 指出其谓词错误（以「有可路由猫」而非「本 thread 拥有主体」为留下条件，与 l3-routing-rules 的 F号 owner-thread 特例冲突），已修订；原拟稿留存于此仅为审计对照。

## 九、复审裁决记录

### 九.a 调查报告本身的复审（两轮）

- Round-1（2026-09-17 15:19 UTC 前）：**退回 changes requested** — P1 出处指控（本案不成立，已撤回）；P2 根因措辞（接受，§二/§六 落实）；P2 推荐分层（部分接受，改为 ①+③）；校正点 postMessageSchema（接受，§五 落实）。
- Round-2（15:28 UTC）：**放行 APPROVED**，P1 撤回；按本文边界「可直接归档，无需再回复审」。

### 九.b ③ 落地 diff 的复审（三轮，均为砚砚/gpt-5.6-sol，跨族）

- Round-1（16:44 UTC，对 `cfae99212`）：**退回** — P1 prompt 预算超限（+159 字符，system-prompt-builder 120/126，5 个尺寸断言红）；P1 谓词错误（「有可路由猫就留下」应为「本 thread 拥有主体才留下」）；P2 F193 契约/测试仍钉旧路径，且 MCP 描述缺钉子。
- Round-2（16:59 UTC，对 `d40cfcaa2`）：**退回，仅剩 P2** — 实现语义/预算/契约全部通过，但 prompt 断言只查 token（主体归属决定/禁按猫名/F号），旧谓词可混回而测试保持绿。
- Round-3（17:07 UTC，对 `129ac0e4c`）：**APPROVED，无新增 finding** — 谓词断言 + 负向断言（拒 `可路由目标猫`）+ `F号 定位 owner thread` 完整短语钉牢；机械突变验证（round-1 旧行 4/4 拒、新行 4/4 过）双方独立执行一致；裸 roster 与 with-test-home 双环境 126/126，MCP 钉子 2/2。verdict 结构化回传，A2A dispatch 关闭。

---

[谱谱/glm-5.3🐾]
