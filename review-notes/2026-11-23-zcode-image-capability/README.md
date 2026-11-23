# ZCode 0.18.0 图片输入：可复现正控与 1×1 fixture CRC 更正

交接对象：砚砚61（109 独立复核）。源消息 `0001795419957572-000121-c77bf980`。
作者：奶牛猫/点点（deepseek-flash）。首次归档 2026-11-23 UTC；CRC 更正 2026-11-23 UTC。
本页只交付证据与源码定位；未改生产代码/配置、未动个人 `~/.zcode`、未重启/部署。

## 0. 更正（P2）：1×1 失败是 fixture CRC 损坏，不是尺寸限制

本页初版把 `attachment_image_resize_failed` 读成“1×1 被图片处理器拒绝”，并据此暗示存在最小尺寸限制。砚砚61 指出原 fixture 的 IDAT CRC 无效；我独立复算确认，并补了只改 CRC 的最小对照：

- 原 1×1 fixture（68B）：IHDR/IEND CRC 正确，**IDAT CRC 存储 `0xefa3322a`、实际应为 `0xefa2a75b`**。
- 最小对照：只把该 CRC 字段改成正确值。尺寸（1×1）、IDAT 压缩像素数据、IHDR、IEND 全部逐字节不变，**仅 byte 53-55 不同**；字节哈希从 `8de67e6a…` 变为 `5e3d382d…`，正是 CRC 修正后的哈希。
- 同一脚本下，CRC 修正版 **12/12 通过**：`imageCount=1`、`exactFixtureBytes=true`、`metadata.image.width=height=1`、`resized=false`。
- 因此：**失败来自损坏 fixture，不是 1×1 尺寸**；`attachment_image_resize_failed` 是笼统的图片处理失败码，**不能反推最小尺寸或任何尺寸上限**。
- 原始失败数据**原样保留**：`FIXTURE_KIND=1x1` 仍跑损坏版、仍 exit 1；首次归档的落盘另存 `result-1x1-corrupt-original.json` / `run-1x1-corrupt-original.log`，SHA256 与首次归档一致，未覆盖。

## 1. 结论（更正后）

1. **native 能发图（正控成立）**：64×64 与 CRC 有效 1×1 两种 fixture，`supportsImage=true` 时 `/v1/messages` 的 user content 出现 `type:"image"`（`image/png`），`source.data` 与 fixture base64 逐字节相等（`exactFixtureBytes=true`）。`dataBase64` 与 `localPath` 两条路都通。
2. **能力过滤成立**：`supportsImage=false` 时同一图片被替换为 `[Attached image/png: probe.png]` + `[Media omitted from provider request because the selected model does not support image input.]`，`imageCount=0`。
3. **损坏 CRC 的 1×1 是 fixture 缺陷负控**：物化阶段报 `attachment_image_resize_failed`，四路都失败、`imageCount=0`；这是负控应有的红色，**不是产品 RED，也不证明尺寸限制**。
4. **家里的 zcode 通路今天仍发不出图**（与 native 能力无关）：Clowder 的 zcode ACP adapter 固定声明 `promptCapabilities.image:false`，且 `session/prompt` 只转发 `flattenAcpPrompt` 文本、不转发 attachments；家庭侧 `readAcpImageBlocks` 在能力未声明时直接抛 `image_input_unsupported`。所以大当家问的“能不能发”在**产品路径**上答案是：现在不能，需改 adapter + 能力协商，native 底层已具备条件。

## 2. 复现（文件都在本目录）

```bash
cd review-notes/2026-11-23-zcode-image-capability
# 正控：64×64 PNG，4 个用例（base64/localPath × on/off）
/opt/homebrew/opt/node@24/bin/node probe.mjs; echo "exit=$?"
# 负控 1：首次归档的 1×1 fixture，IDAT CRC 损坏（保留原样）
FIXTURE_KIND=1x1 /opt/homebrew/opt/node@24/bin/node probe.mjs; echo "exit=$?"
# 负控 2：同一张 1×1，只把 IDAT CRC 修正（最小对照）
FIXTURE_KIND=1x1-valid /opt/homebrew/opt/node@24/bin/node probe.mjs; echo "exit=$?"
```

实测（本机重跑，Node `v24.22.3`）：

| 命令 | exit | result 文件 | 结果 |
|---|---|---|---|
| `node probe.mjs` | **0** | `result-real.json` | 12/12 pass |
| `FIXTURE_KIND=1x1 node probe.mjs` | **1** | `result-1x1.json` | 2 个 `image capability gate` 失败；四路均 `attachment_image_resize_failed` |
| `FIXTURE_KIND=1x1-valid node probe.mjs` | **0** | `result-1x1-valid.json` | 12/12 pass；on 路 `imageCount=1`、`exactFixtureBytes=true` |

版本与摘要：

- zcode bundle SHA256 `0de95ddd65d7712a3beeccc8ee6de53ea0ce96338eb427e52b2717ba2f3afe19`（CLI `0.18.0`）
- `probe.mjs` SHA256 `f18e446a3ab50b3c3b8d662e8bc3473510ff0207a64fd4eb42c00a799eac7576`
- `result-real.json` SHA256 `a19c338cc681f6ea8ab246e37f3d7cb48270801bfd3266d182d1e35be53275d2`
- `result-1x1.json` SHA256 `140cf69d0b494446faa834921d9ed30d6cb615c5d5d44f4c7dfb16df6c4b0ba1`
- `result-1x1-valid.json` SHA256 `971c006b8da19721eb61669d3277a1471752f02081301046a0c56e25fd9c809b`
- 首次归档原始失败：`result-1x1-corrupt-original.json` SHA256 `0d2337ed3ec49a2511a8c472dbdb94c46fce9c2b98fddc37c7adbd333dee69e3`；`run-1x1-corrupt-original.log` SHA256 `fe23e06215e1f8ec28d36462c2673e485918f6e957861957b6f4134eb1cdad19`
- 运行日志：`run-real.log`（`016e3121…`）、`run-1x1.log`（`0de7da94…`）、`run-1x1-valid.log`（`4bf5c577…`）；case 会话目录默认写到系统临时目录 `${TMPDIR}dsh-zcode-image-probe-runs`（可用 `PROBE_RUN_ROOT` 覆盖），不进 repo。

注：`result-*.json` 内含随机 `sessionId`，上面的哈希标识**本次归档**，不是“重跑必得同一哈希”；跨次对照请比 `checks` 与 `cases` 的语义字段（`imageCount`、`exactFixtureBytes`、`errorCode`）。

fixture 字节哈希（可从 `probe.mjs` 直接重算）：

| fixture | 尺寸/属性 | SHA256 ||---|---|---|
| `PNG_1X1`（IDAT CRC 损坏） | 1×1，bitDepth 8，colorType 4 | `8de67e6a578a4e28e658d43ef6ca0d3f8ca98c5afe982d936d696feaa383c254` |
| `PNG_1X1_VALID_CRC`（仅 CRC 修正） | 1×1，与上者仅差 byte 53-55 | `5e3d382db4dd83d59aa5742793ad6b7903409e865c83bcbc54835049f043bc15` |
| `PNG_64X64` | 64×64，bitDepth 8，colorType 6 | `8d4f60f3a909a12a555c095c8d7baa30f465c4b07fbf79ba82f686fbb96f3f20` |

正控关键行（`result-real.json`）：

```json
{"name":"base64-on","supportsImage":true,"captures":[{"imageCount":1,"imageMediaTypes":["image/png"],"exactFixtureBytes":true}]}
{"name":"base64-off","captures":[{"imageCount":0,"userTail":[["[Attached image/png: probe.png]\n[Media omitted from provider request because the selected model does not support image input.]"]]}]}
{"name":"localpath-on","supportsImage":true,"captures":[{"imageCount":1,"imageMediaTypes":["image/png"],"exactFixtureBytes":true}]}
{"name":"localpath-off","captures":[{"imageCount":0}]}
```

CRC 有效 1×1（`result-1x1-valid.json`）：`base64-on` 与 `localpath-on` 均 `imageCount=1`、`exactFixtureBytes=true`，存储侧 `metadata.image = {width:1,height:1,resized:false}`。

存储侧（`session/messages`）对照：

```json
// 两种有效 fixture（64×64 / 1×1-valid）：artifact，可 provider_ready
{"type":"file","mime":"image/png","metadata":{"image":{"height":64,"width":64,"resized":false},"storageKind":"artifact","recoverability":"provider_ready"}}
// 损坏 CRC 的 1×1：物化失败（负控应有的结果）
{"type":"file","mime":"image/png","metadata":{"errorCode":"attachment_image_resize_failed","recoverability":"metadata_only","storageKind":"local_ref"}}
```

## 3. 差异根因（源码定位）

- 附件入口接受 `kind:image` 的两种载荷：`dataBase64` 或 `localPath`（bundle `VPr`/`jq` 附件 schema；两者都是 optional）。
- 物化函数 `Icc`（bundle 偏移约 `13215813`）对 image 先解码再走图片处理/缩放；处理失败走 `wk()` 占位（文本 `[Attached <mime>: <name>]`），`storageKind:"local_ref"`、`recoverability:"metadata_only"`。损坏 CRC 的 1×1 在这里得到 `attachment_image_resize_failed`；CRC 修正后同一 1×1 正常内联，说明该码覆盖的是“图片处理失败”，**不是尺寸门槛**。
- `localPath` 路径 `Q6()`（约 `13205892`）明确把它变成“路径引用 + 让模型用文件工具读”的文本，只在图片处理成功后才作为内联图；所以 `localPath` 不是“天然内联”，也不是失败原因。
- `supportsImage` 的门在**模型请求投影**阶段：`i9()` / `V4e()`（约 `1378486`）会给出
  `[Media omitted from provider request because the selected model does not support image input.]`；`NSa()`（约 `4297417`）在 image block 存在且模型不支持时直接抛 `Model does not support image input`。正控里 `supportsImage=false` 的文本就是这一层产生的。
- `probe.mjs` 用 `exactFixtureBytes` 判定，而不是看 `accepted:true` 或 schema 里有 `image` 字段；这正是上一轮你提醒不能当通过证据的两项。

## 4. 家里 ACP 通路（产品现状，非 native 能力）

- `packages/api/src/domains/cats/services/agents/providers/acp/zcode/zcode-acp-adapter.ts:133`
  `promptCapabilities: { image: false, audio: false, embeddedContext: false }` —— 硬编码，不按模型能力。
- 同文件 `:359` 与 `:368`：`session/prompt` → `native.request('session/send', { sessionId, content: flattenAcpPrompt(params.prompt) })`，**不带 attachments**。
- `zcode-acp-protocol.ts:24-35` 的 `flattenAcpPrompt` 只收 `text` 字段；ACP image block 被静默丢弃。
- `acp-prompt-content.ts:20-28` 的 `requireAcpImageCapability`：能力不是 `image:true` 时抛 `image_input_unsupported`（“该 ACP agent 未声明图片输入能力，图片未发送。”）；`acp-image-input.ts:98` 只有在能力通过后才构造 `{type:'image', mimeType, data}`。
- 因此：CLI/native 层已具备图片输入与 `supportsImage` 门；Clowder 的 zcode 成员没有把这条路接出来。改点至少三处：adapter 能力协商、`session/prompt` → `session/send` 的 attachments 转发、失败/大小/数量降级语义；MCP/skills 见下。

### 4.1 你补的 MCP/skills 遗漏（已逐条对上源码，按你原文收进交接）

- `AcpServiceFactory.ts:514-515` 确为 zcode 设置 `omitSessionMcpServers` 与 `isolatedGitHubRead`；`AcpAgentService.ts:629` 在 `isolatedGitHubRead` 时跳过 `prepareInvokeCredentials`，`:681` 用 `githubReadLease ? zcodeReadMcp(...) : omitSessionMcpServers ? [] : ...` 整体替换 session MCP 列表。**仅改 adapter 的 parse/consume 拿不到家庭 MCP**；复用真正受管的本轮凭证绑定、限制准入、验证 resume 轮换后旧凭证失效与猫/thread 不串权、保住 gh lease，仍是实现前提。此点我未做 MCP 端到端复测，只确认行号与分支。
- 在线 zcode `mcpSupport=true`、`mcpWhitelist=[]`、模板默认 `GLM-5.2` 与在线现状不同——按你的实时 GET 记录，不把模板当在线事实。
- 隔离 HOME 的 user-scope skills 与 workspace 发现都在你的实跑中 `enabled=true`；共享默认 HOME 的多猫/多项目视图与项目私有 skills 不全局共享，是选挂载规则时要保留的边界。
- 图片数量：本页只证明 64×64 与 1×1（损坏/CRC 修正）三种 fixture；**不断言 6/10 或任何上限**，native 侧上限、真实上游接受度均未测。

## 5. 边界与未决

- 已做：隔离 HOME、假 API key、本机回环 `anthropic-messages` 端点；未读个人 `~/.zcode`，未发真实 provider，未改生产源码/配置，未重启/部署。
- 未做/未知：真实 GLM-5.4 上游是否会接受这些图片（本地回环只证明“客户端确实发出”）；真实账号额度（谱谱额度已无）下的行为；真实桌面端与 Clowder 运行时的模型能力配置是否会给出 `supportsImage=true`；MCP 凭证绑定与 skills 挂载的实测（属实现阶段）；native 侧图片尺寸/数量上限。
- 若要把本页当 merge/实现依据：本页只支持“native 可发图 + Clowder zcode ACP 通路未接出”这两个结论；不建议据此直接改生产，先按 109 的只读/隔离边界补 adapter 侧设计。

## 6. 交接给下一棒

1. 用 `probe.mjs` 三组 fixture 作为 adapter 改造后的回归基线：`real` 与 `1x1-valid` 应 exit 0，`1x1`（损坏 CRC）应 exit 1。**不要删损坏 fixture**——它证明的是“物化失败会降级成文本占位”，不是尺寸限制。
2. adapter 侧设计要点：能力按“当前模型 `inputFormat.supportsImage`”协商，不硬编码；`session/prompt` 的 image block 以 `attachments` 透传，并定义超限/处理失败的产品级降级文本；MCP 继续走现有受管凭证绑定，不把任意 server 透传给 native。
3. 需要我继续时，我可沿本页补 adapter 的隔离复现（不改生产）；MCP 与 skills 的实测仍建议由你或实现 owner 复核。
