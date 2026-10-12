---
feature_ids: [F320]
tips_exempt: "Specification only: multi-OAuth login, family switching and project rules have not been delivered; publish their planned tips only with the real account journey, not from this proposal."
related_features: [F062, F136, F171, F291, F318, F319]
topics: [accounts, oauth, credentials, provider-routing, hub-settings]
doc_kind: spec
created: 2026-09-24
updated: 2026-10-09
description: "同一家厂商可以登录多个 OAuth 账号（如公司号与私人号），各自隔离；按猫家族一键换绑，或按项目自动选用对应账号。"
description_source: human
description_author: opus55
description_updated_at: 2026-09-24T09:38:50Z
---

# F320: Multi-OAuth Accounts｜同一厂商多个 OAuth 账号 + 按家族一键切换

> **Status**: in-progress | **Owner**: Ragdoll (@opus55, claude-opus-5-5) | **Priority**: P1

**Codex-first 当前责任**：Astra (@codex-astra, gpt-6-astra) 规划/协调/验收，Sol61 (@codex61-sol, gpt-6.1-sol) 执行；保留原 Feature owner 与 Phase A/B/C。

## 当前返修决定（2026-10-09 UTC）

You `[thread-id]#private-source-id` 要求快速修好前端和整个用户旅程，由他亲自测试；登录只需弹出 CLI 窗口并准备好命令，用户自己按回车也可以。**本轮不再以长轮 Alpha 或全套真人旅程预验作为交到用户手里的前置。** 作者完成受影响检查和一次页面主线核对，保留必要的身份/目录隔离检查；真人登录、额度和续聊由用户从产品发起实测，问题留在原线继续修。

- #5222 已于 2026-10-08 合入 `6a0267a3c67f23447197cea64bebd8feacc6db9e`。本次是合入后用户实测暴露问题的集中返修，用一张修复 PR，不尝试续写已合入 PR，不恢复切片交付。
- 同一个添加账号入口承载厂商、登录方式和备注；Codex OAuth 接到官方终端登录，默认与新增账号在同一列表，不再并列两套同义入口。沿用现有设置组件和 API Key 路径，不另起页面改版。
- 终端准备该账号独立目录下的官方 `codex login`，可直接执行，也允许用户自己回车；官方 CLI 处理浏览器和授权。查清当前启动阻断与请求超时，避免把端口探测结果冒称为另一个真实登录，不新增端口/浏览器/终端总控。
- 登录失败或请求超时后能在原条目重试、取消或删除；操作中的提示与按钮一致，未登录时不呈现可用额度/换绑的假象。登录完成后可继续原有换绑入口，备注及账号保持持久。
- Sol61 继续实现，Astra 接完整交付；原 Sol5.6 做一次针对实际修复 delta 的独立检查，不增加第二 reviewer、全仓重测或新的验收流程。正常合入后给出确切可测版本和入口；正式 runtime 的停启仍按既有权限，不由账号按钮触发。

## 上轮交付决定（2026-10-08，历史）

You 在 `[thread-id]#private-source-id` 要求「点击新建账号」「这个账号的备注名」「和 codex cli 我按一下 codex login 的体验一样」；`#private-source-id` 确认并恢复实施。**最新 source `#private-source-id` 明确纠正：只需唤醒 terminal 执行官方 `codex login`，浏览器打开完全沿用 CLI 自己的行为，不写 Chrome 脚本，不记录/冻结 profile、PID 或窗口。** 前一版把用户对原生体验的描述翻译成自建浏览器路由保证，是 Astra 的需求翻译错误；该要求和对应验收已撤回。

**当前终点：填备注 → 猫咖唤起终端，在该账号的独立 `CODEX_HOME` 执行已安装的官方 `codex login` → CLI 自己打开浏览器 → 用户亲自授权 → 猫咖读回该账号的官方登录结果并保留备注 → 重复添加另一个账号。** 用户不用手写命令或 home 路径。猫咖只负责账号目录、终端命令和结果显示，不接管浏览器、不代理用户完成授权。

- **撤出本次产品交付的额外前置**：F320 专用自动安装/构建/发布、维护冻结、跨发布阶段事务与崩溃回滚总控；不再为验收账号迁入正式环境扩建 F300 生命周期。仅为这些流程新增的接线随实现清理；独立存在的缺陷按真实消费者判断，不能以删目录代替风险核验。
- 新账号从第一次真实登录就使用长期持久的正式账号归属与不随备注/checkout 变化的凭据目录。预览使用隔离 fixture；首次真实账号添加安排在正常更新后的持久账号页，不先制造一批必须迁移的真人验收账号。发布使用已有流程，不能由“新建账号”触发或成为它的新依赖。
- 本次恢复文档、代码、隔离验证和原审查链；没有授权猫代办真人 OAuth、读取/复制既有真实凭据、真实额度/推理/压缩实验或正式 runtime 停启。产品入口应先做到可操作，只有人必须亲自完成的官方授权再交给人；真实部分未执行就保持未验，不能把暂缺授权扩大成开发停工。
- 截至 source357，#5222 已到 `80ad70ae40d92561725d4935dcb5c03db70c01d6`、未合入；额外部署总控已撤出，但新增的 Chrome 窗口/profile 自动化仍是错误方向，必须删除。作者 source376 回报未执行真实登录或真实 OAuth，只操作过 Chrome 窗口/Profiles 菜单、本地链接与临时假账号；这些操作现已停止。真实终端登录和双账号调用旅程仍未验。

本节和下方 User Journey / AC 是最新约定；早期切片及审查段落保留来源和证据，冲突处以本节及 `#codex-final` 为准。F314 已合入的完整旅程与真实输入方法直接用于本次交付，不新增 Gate、Task、第二 reviewer 或计数熔断。

## Codex-first Design Gate（2026-10-06）

- You 已在本线程选择「按当前稿进入后端实现」：原始 human source `[thread-id]#private-source-id`，Astra 已精确回读。批准对应 P1 `94d200e74817a6109ea2c1912c3862c8b56f55fd`，独立操作通过回执 `private-source-id`。
- 这次放行 Codex Phase A/B 的后端实现方向，先做 Phase A 的 P2a 工作单元；Claude、项目规则仍为后续范围，不改写整项 Feature 的 AC。
- 采用浏览器登录主旅程、换绑影响预览、身份不符时默认保留原账号；账号身份与 secrets/控制目录独立，会话/写锁/原生记忆等连续状态按已验证归属共享。第三方认证不复制，未知 home 内容不自动共享。
- 保留当前 main 的 host/lease 与 #5052，F323 仅保留 Phase A（B 已撤回）；不把单账号单进程改造设为本轮前置。跨进程刷新与外部登录争用仍有残余边界，不宣称消除。真实登录、凭据操作、普通/服务端压缩后的跨账号推理尚未执行或验收；本次 Gate 不授予这些操作。

P1 是隔离的真实 Hub 宿主体验稿，5 条浏览器旅程与 14 个单测通过，旧身份确认覆盖新登录的反例已修复并由 Astra 复验；这些是模拟交互证据，所有产品 AC 仍按真实交付逐项验收。

## Codex 剩余工作一次交付（2026-10-07）

当前仍未交付真实登录/换绑及服务端压缩后的 A→B→A；这些是同一最终交付要完成的结果。真实浏览器授权需要用户实际参与，先做成可操作入口，不擅自操作既有凭据，不把 mock 绿表算为真实通过。默认 home/keyring、F293 插件/apps 隔离、Collective 私有边界和既有账号兼容保持；完整 Alpha 健康沿原维护责任解决。Feature 与全部未验收 AC 继续开放。

## Codex P2a 验收（2026-10-07）

Astra 接受 P2a 的限定交付，目标为 [PR #5195](https://github.com/zts212653/clowder-ai/pull/5195) / `393f93e6fd959df2c904ee22f03d9d95d909a9df`；**已通过 #5195 合入 `273e93712627c5e586a51f8fcb9d7476fad6f8f5`；原 Task 的受影响 Alpha checkout 后验完成（101入口/68恢复兼容/5原生配置/2loopback）；named Alpha 未到 HTTP ready，托管账号未启用**。正式语义批准 `private-source-id` 与安全批准 `private-source-id` 都覆盖该 HEAD 和 accepted revision `d916ad69842360cca53a0d7d9892b87d2720f2ad`。Astra 已全文核对两份 typed fact、PR/local HEAD、最终十份工件哈希与撤回 B 路径，未新增第三轮独立审查。

本单元结果成立：所选账号贯穿 F306 探测、主调用与原控制快照；API 探测/调用同根，显式模式排除 ambient 身份与路由来源；成员 CLI/RPC 不能改写账号拥有的 provider/凭据/路由/状态字段；六控制入口在首个业务 RPC 前核原生配置，失败只释放本连接；F323 B 未恢复。作者 95 项源检查、394 项兼容、native loopback 2 项及 API build 通过；独立 reviewer 分别实跑 95/2/无 wrapper 隔离1/build 与94项，并关闭当前 P1/P2。native 401 fixture 仅证明所选 key/header 构造，不证明真实登录、计费或推理。

兼容变化需随交付保留：未填 endpoint 的 API 账号现在使用所选 key 的官方 API；成员配置不能再代替账号设置 provider/routing。API key 对 owner 配置的 stdio MCP/bearer-env 可见是原有边界，不新增加固承诺。原 Task3402 已完成合入与受影响 Alpha checkout 后验，按原授权收口本单元；真实/托管账号、稳定 account ID、bootstrap/未知 policy/carrier、L4–L6 与全 Feature AC 均未通过，不据 P2a 打勾。

### 合入后返修（2026-10-07）

已合入 Alpha checkout `9b5851671630d9934b3ecf382ec5c98b1ce3db3d` 的入口95/恢复兼容81/原生配置读取4通过；原配置 fixture 当时未把完整 native DTO 交给生产 validator，正向 mock 也只检查 done，未确保业务请求成功，所以这些旧绿不能抵销真实反例。返修增加真实 DTO 校验及正向业务/no-error 断言。独立 named Alpha 整套启动另因 Redis 目录身份校验退出，未声称 HTTP ready，也未绕过检查；这与本片账号修订分开记录。

### P2a 审查历史（2026-10-06）

Architecture cell: identity-session（provider-account 子边界）。

Map delta: update required；#5195 已提交 cell 的 canonical anchors 增量，待审合入。既有 account resolver/store 与原生 host/lease owner 继续拥有各自权威，不新增 Store/Router。

Why: 所选账号的规范启动快照需要贯穿调用、能力探测、控制恢复、历史和额度读取，避免另一个读取方重选默认账号。具体 consumer census 与行为契约见已接受的后端计划。

本地语义审查核对 P2a 约定、兼容与资源归属；独立凭据安全审查核对认证 env/config 旁路和凭据泄漏。当前已交 Sol（GPT-5.6）做语义审查；[云端明确返回 review 额度耗尽](https://github.com/zts212653/clowder-ai/pull/5195#issuecomment-6017667777)，按既有替代路径交 Opus55 完整审查 PR，重点覆盖安全面，不把未发生的云端审查记为通过。L1–L3 的无凭据结果包括原生同一 thread 写锁、A→B→冷启动 A、本地历史/记忆/目标和 mock keyring；memory v2 启用时实测是七个 SQLite。官方 config writer 保留软链已有证据，其余真实 writer、沙箱/压缩协调与历史附件仍为 P2b 启用前阻塞。不得据此新增账号级队列，也不把这些结果当成真实登录或服务端压缩后的跨账号推理通过。

## Why

operator 2026-09-24 原话：

- 09:28Z（msg `private-source-id`）：「其实我们缺了个能力，就是凭证轮转……如果可以让我在前端 UI 选择操作轮转到正常账号，好像体验也会好点，就不用一直在 codex 的 app 登入退出了；同理 claude code 的公司账号也可以和个人账号这样隔离，避免每天我都在登入登出」
- 09:35Z（msg `private-source-id`）：「现在的 oauth 只能支持一个，但是按道理我们应该支持多个，然后支持比如Ragdoll一键切换成 oauth 1、2、3。这样社区小伙伴就能在白天的时候用公司账号，晚上下班的时候直接一键把全部Ragdoll、Maine Coon切换成别的账号（私人）」；同一条消息的引用批注：「会有公司的账号和自己的账号，可能需要公司的项目用公司的账号，自己的项目用自己的账号，我觉得这个可以立项」

价值：用猫咖的人往往同时有公司账号和私人账号。现在每家厂商只能挂一个 OAuth 登录，切换就得在 Codex App / Claude Code 里退出再登录，每天来回好几次，还容易把公司项目跑在私人账号上（反过来也一样）。这个 feature 让多个账号同时登录着、相互隔离，切换只是在猫咖里点一下，并且让「这个项目用哪个账号」成为可以设定的规则，而不是靠人记着去切。

## Current State / 现状基线

以下单例与 consumer 描述保留 2026-09-24 的立项基线；当前未合入实现及未验边界见上方「当前交付决定」，不能继续把旧基线当成没有代码，也不能把分支代码当成已交付。

- **OAuth 账号是写死的单例**：`packages/shared/src/types/client-routing.ts` 的 `BUILTIN_ACCOUNT_IDS` 给每个厂商家族固定分配一个 id（anthropic→`claude`、openai→`codex`、google→`gemini`、kimi→`kimi`、opencode→`opencode`）；Hub 账号页每个厂商只显示一个 OAuth 条目（operator 09:35Z 截图 `uploads/1790242529590-22b5542a.png`：Claude / Codex / Gemini / OpenCode 各一条）。
- **登录状态存在工具自己的目录里，由环境变量决定**：Codex 用 `CODEX_HOME`（默认 `~/.codex`），Claude Code 用 `CLAUDE_CONFIG_DIR`。实测（opus55，2026-09-24）：`CODEX_HOME` 指向另一个目录后可以登录另一个账号，互不影响（F319 账号对照实验，`~/.codex-probe-flagged`）；`CLAUDE_CONFIG_DIR` 指向空目录时 `claude auth status` = `loggedIn: false`，默认目录仍是 `loggedIn: true`。
- **底层管线已经有一半**：
  - 账号条目有 `envVars` 字段（F171；`AccountConfig` in `packages/shared/src/types/cat-breed.ts`），oauth 账号同样生效，在子进程环境里最后注入（`invoke-single-cat.ts` 的 `accountEnv`，`CodexAgentService.ts` 约 1958 行）。
  - Codex app-server 暖池 host 的复用签名包含启动环境（`CodexUnixWebSocketSession.ts` `prepareCodexHostLaunch` 对 env 做 sha256）→ `CODEX_HOME` 不同的猫天然落在不同的 host 上。
  - 创建/修改账号的接口接受 `envVars`（`packages/api/src/routes/accounts.ts`）。
- **还假设「只有一个 home」的读取方**（需要在 Design Gate 做完整 consumer census，此处是初步 grep）：`routes/quota.ts:1142`（额度只读 `CODEX_HOME/auth.json`）、`codex-session-context-snapshot.ts:131`（会话根目录）、`codex-image-scanner.ts:24`、`collective-codex-home.ts:11`、Claude bg carrier 的 `CLAUDE_CONFIG_DIR` 处理（`claude-bg-job-ownership.ts`）。
- **没有任何架构 cell 声明拥有账号解析**（`docs/architecture/ownership/cells/` 里没有 `accounts.json` / `account-resolver` / `accountRef` 的归属）。

## What

> 以下 Phase 划分是立项时的提案，Design Gate 可以调整。

### Phase A: 多个 OAuth 账号成为一等公民

- 同一厂商家族可以有多个 OAuth 账号，每个账号有自己的**登录目录**（Codex → `CODEX_HOME`，Claude → `CLAUDE_CONFIG_DIR`）；登录目录是账号上正式的字段，不需要用户手写 `envVars`。
- 账号页显示每个账号的登录状态（已登录 / 未登录 / 过期），并提供「登录」入口：猫咖唤起终端，在该账号的登录目录执行官方登录；用户不用手动打开终端或输入命令。
- 创建账号时即可自定义备注（展示名称），创建后可修改；与官方身份分开展示，登录或重试不覆盖用户填写的备注。
- 现有的内置 `claude` / `codex` 账号平滑迁移成「OAuth 1」，继续指向默认目录；迁移后现有行为不变。
- 额度显示等读取方按账号区分（见 Current State 列出的读取方）。

### Phase B: 按家族一键换绑

- 在一个地方把某个家族（Ragdoll / Maine Coon / …）的全部猫，或者单只猫，换绑到指定的 OAuth 账号。
- 换绑从下一次调用开始生效；正在进行的调用在原账号上跑完，不会中途换号。
- 界面上随时看得到每只猫当前用的是哪个账号（例如成员列表或回复底栏）。
- 会话连续性：**换账号后必须能续上原来的会话**，行为要和今天在同一个 `~/.codex` 里手动退出再登录一样。做法是只按账号隔离「凭证」，「会话记录」所有账号共用（见 KD-3）。

### Phase C: 按项目自动选用账号

- 给项目（projectPath / workspace）设一个默认账号：公司项目自动走公司号，私人项目自动走私人号。
- 优先级需要在 Design Gate 定清楚：项目规则 / 家族换绑 / 单猫绑定 三者冲突时听谁的（见 OQ-3）。

## User Journey

### Primary Journey: 填备注、官方登录，保留两个账号并换绑续聊
- **Scope unit**: workspace
- **Actor**: operator / 社区用户（同时有公司号和私人号）
- **Entry**: Hub 设置 → 账号
- **Flow**:
  1. 点「新建 Codex 账号」，填写备注「公司」并提交；不用手动打开终端或输入命令。
  2. 猫咖唤起终端，在这个账号的独立 `CODEX_HOME` 执行官方 `codex login`。由 CLI 自己按原生方式打开浏览器，猫咖不选择、记录或切换 Chrome profile/窗口。
  3. 用户在官方页面选择/确认账号并完成授权；回到猫咖可见「公司」已登录，官方身份与自己填写的备注分开显示。
  4. 同样添加「私人」；公司号和默认账号保持原登录，两个账号以后都能直接选择。运行时只选择对应 accountRef/登录目录，不依赖浏览器是否仍打开。
  5. 刷新页面、重启服务后，两条账号、备注和登录仍在；改备注不改变账号或凭据目录。
  6. 查看两个账号各自额度；选择单猫或本地 Codex 家族换绑到「私人」并确认，正在执行的调用仍用原账号。
  7. 回到同一聊天继续发消息，下一次调用使用私人号并显示实际执行账号；切回公司号还能续聊，不要求退出或重新登录。另以服务端已压缩的会话验证相同结果。
- **Success evidence**: 默认 Hub 新建动作确实唤起终端，官方命令消费所建账号目录；用户亲自授权后，两账号状态/备注持久且各自调用与额度归属正确，普通和服务端压缩后可续聊。隔离命令 fixture 只证明接线与隔离，不能代替真人授权；不再把 Chrome 窗口测试列为交付证据。
- **Non-goals**: 自动轮换（见 KD-1）；绕开厂商限制或组织策略；展示 token 明文；读取、记录、选择或操纵 Chrome profile/窗口/Cookie；代用户授权；通过账号功能安装/更新/发布猫咖或 Codex。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | workspace | operator | 项目设置里给「公司项目」绑定公司账号 → 在该项目的 thread 里 @ 猫 → 自动走公司号；换到私人项目的 thread → 自动走私人号 | 浏览器旅程 + 两个 thread 回复的账号标识 |
| S2 | message | 其他猫 | 读历史时能看到某条回复是哪个账号跑的（为排查限流、额度归属留痕） | prompt / get_thread_context 输出样例 |

## 需求点 Checklist

| # | 需求点 | 来源 | AC |
|---|--------|------|----|
| R1 | 同一厂商可以同时登录多个 OAuth 账号，互相隔离 | operator 09:35Z「oauth 只能支持一个，按道理应该支持多个」 | AC-A1, AC-A2 |
| R2 | 在前端界面里完成切换，不用去 Codex App / Claude Code 里退出登录 | operator 09:28Z | AC-A3, AC-B1 |
| R3 | 一键把整个家族（Ragdoll、Maine Coon）切到指定账号 | operator 09:35Z「一键把全部Ragdoll、Maine Coon切换」 | AC-B1, AC-B2 |
| R4 | Claude Code 公司号与个人号同样可以隔离 | operator 09:28Z | AC-A1 |
| R5 | 公司项目用公司账号、私人项目用私人账号 | operator 09:35Z 引用批注 | AC-C1 |
| R6 | 不做「被限流就自动切下一个账号」 | operator 09:35Z 引用批注「对，我们不要做这个」 | KD-1, AC-B4 |
| R7 | 创建账号时即可自定义备注，创建后可修改并持久保留 | operator 2026-10-06，`private-source-id` | AC-A5 |
| R8 | 新建后唤起终端执行官方 `codex login`，浏览器行为全部交官方 CLI；猫咖不实现 Chrome 脚本 | 原需求 `private-source-id`；最新纠正 `private-source-id` | AC-A3, AC-A6 |
| R9 | 登录一次即可长期沿用；新建账号不携带安装/发布/迁移流程 | 同上；原接续问题 `private-source-id` | AC-A7, AC-A8 |

## Acceptance Criteria

### Phase A（多个 OAuth 账号成为一等公民）
- [ ] AC-A1: 同一厂商家族（至少 Codex 与 Claude）可以同时存在 ≥2 个 OAuth 账号，每个账号有独立的登录目录；两个账号同时保持登录，互不影响（非作者可按账号页 + `codex login status` / `claude auth status` 复核）
- [ ] AC-A2: 现有安装升级后，原内置 `codex` / `claude` 账号成为第一个 OAuth 账号，所有已绑定的猫行为不变（升级前后同一只猫的调用走同一个登录目录）
- [ ] AC-A3: 账号页新建/登录操作唤起终端，在所选账号目录执行官方 `codex login`；由 CLI 自己打开浏览器，用户亲自授权。完成后猫咖读回该账号的官方登录结果与身份，备注保持；取消/失败可在原条目重试，不能把终端已打开或 auth 文件存在当登录成功。全过程不展示或记录 token 明文
- [ ] AC-A4: 额度显示等原本只读单一 home 的读取方，按账号显示各自的数据（consumer census 列出的每一处都有归属）
- [ ] AC-A5: 创建表单在授权前支持自定义账号备注；创建、登录/重试、重载后备注仍保留，创建后可修改，账号列表和换绑选择器一致展示。备注独立于官方身份；改备注不触发换号、迁目录或改写历史执行归属
- [ ] AC-A6（本轮 Codex）: 新建后终端准备好已安装的官方 `codex login` 命令，可直接执行或由用户按回车；`CODEX_HOME` 指向本次账号的受管目录，备注不进入 shell 命令，默认账号和其他账号目录不被替换。产品没有 Chrome profile/PID/窗口捕获、持久化、置前或 URL 打开脚本。浏览器选择和授权页面由官方 CLI/系统原生流程负责，不新增猫咖保证
- [ ] AC-A7（本轮 Codex）: 同一持久账号归属下首次登录后，刷新、正常服务重启及代码 checkout 更新仍认识同一个 accountRef/备注/凭据目录，不因环境切换再次要求授权；不复制 token 或迁移默认 home。厂商主动撤销/登录过期按官方认证生命周期处理，不承诺永久免登录
- [ ] AC-A8（本轮 Codex）: 新建账号不执行安装依赖、构建、Git 更新、runtime 停启或账号跨环境搬迁；完整账号旅程不依赖 F320 专用发布/维护/回滚控制器
- [ ] AC-A9（本轮返修）: 账号页只有一套添加入口和账号列表；Codex OAuth 从该入口进入终端登录，失败/超时后原条目有可用恢复操作，未登录状态与额度/换绑动作一致；成功后可沿原入口绑定使用。source442 的用户实测接续不被长轮 Alpha 阻塞

### Phase B（按家族一键换绑）
- [ ] AC-B1: 一次操作把某个家族的全部猫换绑到指定账号；下一次调用即走新账号（可从子进程环境 / host 签名 / 回复上的账号标识复核）
- [ ] AC-B2: 正在进行的调用不受换绑影响，在原账号上跑完
- [ ] AC-B3: 界面上能看出每只猫当前用的账号，回复上留有「本条由哪个账号跑」的记录
- [ ] AC-B4: 系统不会在没有人操作的情况下自己换账号（没有基于限流 / 错误的自动轮换代码路径）
- [ ] AC-B5（本轮 Codex）: 普通会话与服务端已压缩会话都能 A→B→A 继续同一会话；历史回复/usage 保留实际执行账号，当前绑定与在途账号分别显示。模拟压缩或仅能读取 JSONL 不能算真实续聊通过

### Phase C（按项目自动选用账号）
- [ ] AC-C1: 给项目设定默认账号后，该项目 thread 里的调用自动走对应账号；与家族换绑、单猫绑定冲突时，按 Design Gate 定下的优先级执行，并且界面能看出是哪条规则生效

## Dependencies

- **Evolved from**: F062（Ragdoll账号配置中枢：订阅 / 赞助 API 两通道切换；KD-1 首版只做Ragdoll）
- **Related**: F136（统一配置热更新 / 账号底座，clowder-ai#340）；F171（账号 `envVars` 注入）；F291（Codex OAuth 速度档位，按账号类型判断）；F318（Claude Agent SDK carrier 的 OAuth 登录）；F319（账号对照实验中验证了 `CODEX_HOME` 隔离）

## Risk

| 风险 | 缓解 |
|------|------|
| 换账号后原会话续不上 | KD-3：凭证按账号隔离、会话记录共用（Codex 跨账号续会话已实测通过）；残余风险见 OQ-2 |
| 公司代码跑在私人账号上（或反过来），有合规风险 | Phase C 按项目绑定 + 界面上随时可见当前账号；换绑需要明确操作 |
| 还有读取方默认只看 `~/.codex` / `~/.claude`，换号后显示或行为错乱 | Design Gate 做 code-derived consumer census（F303），每一处都要有归属 |
| 登录目录里存着凭证 | 只存路径不存 token；目录不进仓库、不上传、不在 UI 显示内容 |
| Gemini / Kimi / OpenCode 的隔离方式未知 | OQ-4；Phase A 先覆盖 Codex 与 Claude |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不做自动轮换：不会因为限流或报错自动换到下一个账号，换账号永远是人的明确操作 | 自动轮换本质是在绕开厂商对单个账号的限制；operator 09:35Z「对，我们不要做这个」 | 2026-09-24 |
| KD-3 | 只按账号隔离凭证，会话记录所有账号共用 | operator 09:4xZ 指出：今天手动退出/登录能续上会话，是因为只换了凭证、会话记录留在原地；做不到续会话，F320 就没有意义。**实测（opus55，2026-09-24 09:51Z）**：正常账号开会话并记下暗号，把这一个会话文件复制到异常账号目录的同一相对路径，用异常账号 `codex exec resume <id>` 续上，正确答出暗号，无报错；测试文件用后已删 | 2026-09-24 |
| KD-2 | 用各工具官方支持的登录目录环境变量（`CODEX_HOME` / `CLAUDE_CONFIG_DIR`）隔离账号，不复制 token、不加代理 | 用的是工具本身支持的能力，凭证始终留在工具自己的目录里 | 2026-09-24 |
| KD-4 | 新增账号采用备注→终端执行官方 `codex login`→用户授权→独立持久登录；浏览器完全归官方原生流程。撤出 F320 专用自动发布、迁移前置和 Chrome 自动化，复用正常部署 | source2335/116 接受原生体验，source357 纠正 Astra 自加的 profile 保证；原 Phase B 结果仍保留 | 2026-10-08 |

## Tips Contribution（F244）

计划新增 1–2 条 tips：①「公司号和私人号可以同时登录，在账号页一键换绑」→ 指向本 feature 的账号页入口；②「项目可以绑定默认账号」（Phase C 完成后）。

## Review Gate

- Design Gate：前端 UI/UX（账号页、换绑入口、账号标识）→ operator在真实 Hub 壳里确认；后端 / 架构（账号模型、consumer census、会话连续性）→ 跨家族猫讨论后operator拍板。
- 实现 review：默认一个合格的非作者来源，覆盖该改动的行为与安全风险；不按族别加派，不因出现 auth 就自动叠第二位。只有现有来源无法覆盖的具体证据缺口才考虑增加，并先说明缺口。本次已完成的两份批准保留，合入前不另加派或机械续审。
- 纠正与归因：You `private-source-id` 明确反对无必要的双审/按族别加派。Astra 承担安排责任：把“语义/安全是两个风险面”直接等同“两位常驻 reviewer”，又保留了本页“另外做一次”的无条件条款，没有先判断一个合格来源能否覆盖。错误例是固定双路；正确例是一个来源覆盖真实风险；分界是具体覆盖缺口而不是风险标签或猫族。当前条款与计划中的双路续审指令已收口为历史，不另建审批或实验。
