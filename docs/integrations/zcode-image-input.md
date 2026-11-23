---
topics: [zcode, acp, image-input]
doc_kind: guide
created: 2026-11-24
tips_exempt: "Connects the existing chat image attachment flow for one carrier; no new user control or interaction to teach."
---

# ZCode 图片输入接线与验收

来源：大当家消息 `0001795450395928-000394-b0a2c76f`，Task `0001795450457112-000399-ce3cdd96`。
当前部署须包含此补丁才生效；源码自测不能代替线上激活。

## 用户路径

选择使用 `glm-5.4` 的谱谱，在现有聊天入口上传图片并提问。
图片经 Hub 已有的可信上传路径读取、ACP 图片块、ZCode 原生附件到上游模型。
图片损坏、过大、当前模型未启用图片或原生处理失败时应明确报错；不把丢图后的文字回答显示为成功。

本补丁只为 GLM-5.4 启用图片，保留其它模型原有能力。
上限沿用每次 5 张、每张 10 MiB；桥的解码验证另限每张 4000 万像素，防止高压缩图片占用过多资源。
PNG 校验块 CRC，再用已有 sharp 验证解码；保留原始图片字节。

## 实现与边界

- `zcodeModelSupportsImages` 同时控制 ACP 握手与生成的 provider model rule，避免只打开握手、原生仍按纯文本处理。
- GLM-5.4 的新会话选择显式携带 `reasoningLevel: enabled`，满足安装版 0.18.0 的模型注册表要求。
- 图片只来自 Hub 快照的 base64 字节，不接收任意 native 路径或远程 URL；文件名由桥生成。
- 图片提示词发送前验证完整性；取消发生在解码期间时不启动模型。
- 有图片的回答暂存至回合结束，沿发送前的消息游标检查本回合图片已为 `provider_ready` artifact，再显示回答。游标防止长工具链把原始用户消息挤出最近窗口。
- 原生处理检查发生在回答显示之前，不能声称它会撤销原生已经执行的工具副作用。已知损坏和超限输入在发送前拒绝。
- 不改变个人 HOME 隔离、历史存储、MCP/skills、GitHub read lease 或在线成员配置。

Architecture cell: Cats / ACP carrier / ZCode adapter.
Map delta: none — attachment mapping and verification stay inside the existing carrier owner.
Why: the current carrier advertises no images and discards non-text blocks; native 0.18.0 already has the attachment API.

Canonical source: `packages/api/src/domains/cats/services/agents/providers/acp/zcode/zcode-image-input.ts#prepareZcodePrompt`

Consumer evidence:

```bash
rg -n 'zcodeModelSupportsImages|prepareZcodePrompt|assertZcodeImagesMaterialized|MAX_ACP_IMAGES' \
  packages/api/src/domains/cats/services/agents/providers/acp
```

The model declaration has two consumers (handshake and generated provider rule); the prompt mapper and materialization check are consumed only by the ZCode carrier. The shared image-count constant retains the existing upload reader ceiling.

Claim guard: chat images reach the provider as images → fake-carrier regression plus real-native loopback check → fails when capability is false, attachments are omitted, bytes differ, or native materialization becomes a placeholder.

## 本轮验证

- 改前新增 8 项行为检查：8 fail，exit 1；缺能力规则、附件通道与可见失败均被复现。
- 相关载体、provider 配置及 gh-read 回归：34 pass，exit 0。
- 既有 ACP 图片、上传目录、connector 图片与 stdio/HTTP client 回归：128 pass，exit 0。
- 真实 ZCode 0.18.0 + 假凭据/本地假模型：上传读取 → ACP → 原生 → provider 图片字节一致；新建与 `session/load` 后继续发图均通过，1 pass，exit 0。
- 续接实测曾发现内部 `info.id` 被接口序列化为 `info.messageId`；保留原始失败并修正桥及假载体，长工具链与连续图片回合复验通过。
- 实际绑定账号、隔离的新原生会话：随机数字图片盲读，期望 `357882`，模型回答 `357882`，通过。答案没有写入提示词。生成的临时凭证输入在退出后为 0 个。
- 直接 API 探针曾返回 HTTP 529；第一张红色色块在真实载体中被答为 Brown。这些结果保留，不能把单次识图通过理解为模型准确率保证。
- 正式非作者审查与线上激活另需实际回执；不以本文代替。

完整聊天旅程尚未走通：当前运行态尚未包含补丁。合入后由同一 Task owner 砚砚61继续在隔离验收环境验证现有聊天入口，再按运行态授权激活；本地载体与识图证据不等同于线上解封。

快速回归：

```bash
node --test packages/api/test/acp/zcode-acp-images.test.js
# 显式安装版自测；只用假 key 与自己的回环模型端点
CAT_CAFE_ZCODE_LIVE=1 node --test packages/api/test/acp/zcode-acp-images.live.test.js
```

上线验收需先合入并激活包含补丁的 API，再从现有聊天入口给谱谱发送真实截图。
不得在生产目录启动开发实例；不得把本地分支的编译结果写进正在运行的 runtime。
