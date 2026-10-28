# GH 执行球误传/授权误判 定位报告（谱谱 → gpt-pro review）

任务：operator `0001793194931779-000925-7f3edfd8` → gpt-pro 转派谱谱（`0001793194963227-000930-a038379`）：
只定位 + 最小修复设计，不做 GitHub 远端写操作，不动 F247 PR 流程。
谱谱是第一误认现场（两次传错"点点"），本报告含第一手证据。

## A. `@点点` alias 真相源与误认根因

**真相源（完整且正确）**：`/Users/yuhan/cat-cafe/cat-cafe-runtime/.cat-cafe/cat-catalog.json`
`breeds[12]`：奶牛猫，`nickname: "点点"`，`mentionPatterns: ["@点点", "@dsh-v41-flash"]`，
`catId: dsh-v41-flash`。qoder = `breeds[14]` 俄罗斯蓝猫"银线"（`@银线`/`@qoder`）。

**server 路由层正确**：operator 13:39 `@点点 你有gh吗` 的 dispatch
（0001793194782150-000916）实际送达 dsh-v41-flash（成员运行态佐证）。
路由用 catalog mentionPatterns，无误。

**误认发生在猫脑内，根因是 prompt 注入把昵称双重丢弃**——
`packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts` `buildTeammateRoster`（365-410 行）：

1. **label 丢弃**（373-377）：`variantLabel` 存在 → `${displayName} ${variantLabel}`，
   nickname 分支不可达。注入给猫的行是"奶牛猫 v4.1-flash"——"点点"不在 prompt 里。
2. **mention 丢弃**（`pickVariantMention` 213-221 + mentionCell 395）：优先返回与
   catId 精确相等的 pattern → `@dsh-v41-flash`；`@点点` 不显示。

**谱谱误认的完整机制（第一现场自述）**：我的 prompt 里没有任何"点点"映射，
只能靠弱证据推断：git log 中 qoder 相关 review-notes 的**提交署名**是"（点点）"
（点点撰写的关于 qoder 的诊断记录，如 `205d216e5`/`290d58c57`/`a2aed8a5b`），
我把"标题含 qoder × 尾部署名（点点）"错误关联成"点点=qoder"。第一次传球对象
（dsh）碰对但依据只是 operator 原话；operator 说传错后，我用同一套错误证据
"纠正"为 qoder——错上加错。qoder 侧同样从缺昵称的名册 + 我消息中的断言反推。
**结论：catalog 数据完整、路由正确；SystemPromptBuilder 投影丢昵称是根因；
模型记忆/推理错误是表现。** live runtime（02c240add）该函数与 origin/main
一致（diff 验证），根因在 live 成立。

## B. dispatch 前 capability 检查：不存在

`packages/api/src` 全仓搜 `github_write` / `requiredCapabilities` /
capability preflight：**零命中**。`invoke-single-cat.ts` 的 capability 是
freshness carrier（上下文连续性），与执行能力无关。dispatch 前唯一的门是
cat availability。qoder 的 `capability_unavailable` 是它 harness 沙箱在
**收到球之后**的运行时拒绝——事后发现，不是 fail closed。

## C. GitHub 写能力：无任何结构化表达

三只猫三种现实，全部靠各自试出来：

| 猫 | 现实（实测） | 原因层 |
|---|---|---|
| dsh-v41-flash（点点） | gh 2.100.0 可写（08mamba24，repo/workflow scope） | deepseek-harness 跑在真实 HOME=/Users/yuhan + 宿主 keyring |
| qoder（银线） | `capability_unavailable`，worktree `Operation not permitted` | qoder CLI 沙箱拦截 gh，只有只读 GitHub MCP |
| zcode（谱谱） | gh token invalid + keychain 无 github 条目 | 独立 app-server HOME（.cat-cafe/zcode/app-server-home），见不到宿主凭据 |

catalog roster 条目字段仅 `available/evaluation/family/lead/roles`——无能力字段。
能力差异存在于各 harness 宿主配置（仓外），猫咖 API 无从得知。
另有一类独立故障：代理 127.0.0.1:7897 到 GitHub 的 TLS 断裂曾被报成"授权失效"
（他 thread 实锤）——错误分类缺失放大了误判。

## D. 最小修复设计（复用现有 surface，不建平行机制）

**D1（昵称注入，立即最小 patch）**：`buildTeammateRoster` label 分支并入 nickname：
`variantLabel && nickname` → `${displayName} ${variantLabel}/${nickname}`
（"奶牛猫 v4.1-flash/点点"）。**不动 `pickVariantMention`**——它被
`pickVariantMentionForBridge` 用于 AssembleBridge 路由 parity（F237 约束），
动它风险外溢到路由面。

**D2（能力可见性，数据+渲染对称小改）**：catalog roster/breeds 加可选
`capabilities` 字段（如 dsh-v41-flash: `["github_write"]`）；
`buildTeammateRoster` 的 routingCell 渲染它——与 `restrictionsNote`（401-404 行）
同构，已有先例。猫在 always-on roster 里即见"点点：github_write"。
**协议层同步（SOP 文档，不改代码）**：执行包规范携带
`executorCatId` + `requiredCapabilities`；目标不满足时发球猫 fail closed 不传球。
catalog 字段变更属 runtime config，按家规由 operator 手动。

**后续任务（非本次最小范围，按 gpt-pro 定位走）**：dispatch 前 server 侧
preflight（沿 F208/F293 线）；gh preflight 脚本 + 五类错误码
（GH_EXECUTOR_CAPABILITY_UNAVAILABLE / GH_WORKSPACE_UNAVAILABLE /
GH_NETWORK_OR_PROXY_FAILED / GH_AUTH_REQUIRED / GH_REPO_PERMISSION_DENIED）；
长期 GitHub Host Broker（operator authorization ≠ credential distribution）。

## E. RED 测试点

1. buildTeammateRoster 对同时有 variantLabel+nickname 的猫，输出行必须含
   nickname——当前输出"奶牛猫 v4.1-flash"，断言 `/点点/` 即 RED
2. roster 行至少呈现一条非 id 的 mentionPattern 别名（`@点点`）
3. catalog 声明 `capabilities` 的猫 → routingCell 渲染 `github_write`
   （与 restrictionsNote 断言同构，新字段）
4. （后续）requiredCapabilities 与目标声明不匹配 → dispatch 前拒绝 + 明确错误码
5. （后续）gh 状态分类：timeout/TLS/EOF → NETWORK_OR_PROXY 而非 AUTH_REQUIRED
6. 基线不受影响：f290-communication-private-l0.test.ts:26 的 `/## 队友名册/`
   模板断言（模板级，行级加字段不破坏）

## 事件复盘时间线（供 review 关联）

- 13:32 operator：「你让点点用gh合入」→ 谱谱传 @dsh-v41-flash（对象碰对）
- 13:34 operator：「你传球不对」→ 谱谱用 git 署名的弱证据"纠正"为 @qoder（错）
- 13:35 点点退球（澄清昵称）；银线退球（沙箱无 gh + 提出capability论）
- 13:39 operator `@点点` 直达 dsh-v41-flash（路由层证明正确）；13:41 点点实测可写并接球
- 13:42 gpt-pro 转派本定位任务

implementer：谱谱/zcode-glm-5.3；reviewer：砚砚Pro/gpt-pro。
