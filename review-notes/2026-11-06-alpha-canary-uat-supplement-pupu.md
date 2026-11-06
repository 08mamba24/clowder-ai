# PR #63 Alpha 验收补记——方案 A 执行：canary 夹具落地，journey 层 blocked 于 harness 契约漂移（谱谱）

日期：2026-11-06　thread：`thread_mvhqzo9b2l03e98g`
任务来源：co-creator 拍板方案 A（@gpt-pro 转达）：仅给 alpha 补 openai/app_server 测试 canary，harness 不动，重跑 compaction/replacement journey。
前置：`2026-11-05-alpha-daemon-pr63-acceptance-record-pupu.md`。本文为补记，只登新增事实。

## 1. 环境复核（隔夜后重拉）

隔夜 alpha daemon 再次消失（休眠打断，redis 6397 存活、dbsize 25 数据连续），按已验证配方（直启 start-dev --prod-web --quick + 全套 alpha env）重拉。HEAD `ad0c52d20`、四构建戳一致、3011=200、3012 /health revision=ad0c52d20、/ready ready、4111 正常。

## 2. 认证可用性结论（无新凭据、无复制、无扩权）

- 选用**既有**账号 `my-codex-walle`（api_key 认证，baseUrl=中继，模型 `gpt-5.6-sol`），凭证条目本就在 alpha primaryRoot 账号库（clowder-ai/.cat-cafe）中，由既有代码路径（CodexAgentService env 注入）按次使用。
- 本机 codex 原生 OAuth（~/.codex/auth.json、config.toml）不存在，未创建。全程未生成、复制、重配任何凭据；报告不含密钥值。

## 3. 夹具 diff（alpha 专属配置，一处文件 + 一个启动 env）

- `cat-cafe-alpha/.cat-cafe/cat-catalog.json`：新增 breed `f296-canary`（备份：同目录 `cat-catalog.json.bak-f296canary-20261106`）。关键 variant 字段：`clientId=openai`、`cli.carrier=app_server`、`configurationSource=managed_account`、`accountRef=my-codex-walle`、`defaultModel=gpt-5.6-sol`。
  - 踩坑记录：无 `accountRef` 时 resolveForClient 落 builtin（oauth、无凭证）→ 中继 401 "Missing bearer"；补 `accountRef` 后通。
- 启动 env 新增 `TELEMETRY_HMAC_SALT`（openssl rand 生成；遥测 ID 假名化内部盐，非对外凭据）：prod-web 模式无此盐 OTel 直接不初始化（hmac.ts 明确），导致首轮 `telemetry_unavailable`。
- 未改：harness、主仓代码、主 runtime、账号库。

## 4. 链路端到端实测（journey 前的独立验证）

手工建线程 + `@f296-canary` 消息（不带 deliveryMode、带 identity 头）→ 入队 → codex app_server 双工运行（turn/moderationMetadata、account/rateLimits/updated）→ **回复 `OK\n\n[金丝雀/gpt-5.6-sol🐾]`，lifecycle completed**。夹具→账号路由→api_key 注入→app_server→中继→真实模型回复，全链路打通，全日志 0 条 401。

## 5. UAT 实跑记录（逐条）

命令：`node scripts/f296-alpha-uat.mjs --api-url http://127.0.0.1:3012 --redis-url redis://127.0.0.1:6397 --cat-id f296-canary`
退出码：**1**（完整 JSON 已存 /tmp/f296-uat-final.json 并附于提交说明）

| 层 | 结果 |
|---|---|
| 前置门（契约/坐标/会话/health+revision/ready/canary/metrics） | **全过**（canary 断言 openai+app_server 首次通过；9464 telemetry 就绪） |
| journey `cold` | **failed / invocation_rejected** |
| journey `resumed-small` / `resumed-large` | unsupported（prerequisite_not_observed 级联） |
| journey `replacement` | unsupported（provider_replacement_trigger_unavailable）**〔修正 2026-11-06：非 409——candidateIds 为空（未传 --oversized-native-thread-id）时 journeys.mjs:76-78 本地 return，未发任何 HTTP 请求〕** |
| journey `authoritative-compaction` | unsupported（provider_compaction_trigger_unavailable，**409** 两轮实测：05:51:46.986 / 05:58:43.615） |

## 6. journey 层两个断点（新发现，P2）

1. **脚本↔同树 API 契约漂移**：`f296-alpha-uat.mjs:209` 发送 `deliveryMode:'immediate'`，而本树 `/api/messages` zod schema 无此键（unrecognized_keys 拒绝，实测 400/0.5ms）→ cold journey 必然 invocation_rejected。同一棵树内 harness 与 API 不同步——疑似上游同步（PR #63 的 14 个 upstream commit）改了 messages schema 而 UAT 脚本未跟。
2. ~~**api_key 中继会话缺 native 触发面**：compact-native / replace-native 均 409~~ **〔修正 2026-11-06，源码级重析〕** 409 的实际条件是 `native-session-control-routes.ts:139-141` 的 `!session?.cliSessionId` 分支——UAT 线程上 cold 先被 400 拒、**从未建立 native 会话**，compact-native 的 409 是**级联**，不是账号/carrier 能力限制；`requestNativeCompaction` 方法存在（CodexAgentService.ts:1303），agentRegistry 含 canary。api_key 会话上 native compaction 是否可用**未测**（需先修 ① 让 cold 建会话）；"必须新 OAuth"当时结论**证据不足，撤回**。replacement 则另有前置：需 `--oversized-native-thread-id` 运营输入（本两轮未传，candidateIds 为空本地 return）。

## 7. 结论与下一步

方案 A 的可做部分**全部完成**：canary 夹具就位并实测可用、全部前置门 PASS、链路端到端验证通过。journey 层剩余断点在 **harness/凭据授权侧**（修复=改脚本走 PR+review，或补 codex OAuth=新授权），均超出本次"只加夹具不动 harness"的授权边界，如实上抛。

[谱谱/glm-5.3🐾]
