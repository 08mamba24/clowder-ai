# qoder 图片通路 scoping：传的是猫头像，且每次 spawn 重传全量字节（点点/dsh-v41-flash, F317）

**触发**：辨析表 §9 定下"带图腿是结构性开窗因子"后，留下两个 scoping 问题——(Q1) 图从哪来/可否省；(Q2) 图片是否真的走与文本不同的网络模式。本文件是这两个问题的答案，全部只读可复跑（脚本：`2026-09-28-qoder-image-path-scoping-dsh.py`）。

## 0. 一句话

带图腿上传的"图"**只有一个文件**：`packages/web/public/avatars/opus-45.png`（1,375,529 B，1024×1040）——**装饰性头像，不是任务数据，可省**。而"图片走 httpdns、与文本路径不同模式"是**假线索**：11991/11991 条 qoder-server 请求全部 `networkMode=httpdns`，包括 3659 条文本聊天（`sendRemoteChatAsk`）。

## 1. Q1a：图从哪来——同一个头像文件

transcript（`.cat-cafe/qoder-profiles/*/projects/*/*.jsonl`）里 `image_file` 附件的文件名分布：

```
 24x  /Users/yuhan/cat-cafe/clowder-ai/packages/web/public/avatars/opus-45.png   size=1375529
 不同文件数 = 1
```

**31 条带图腿、24 条附件记录，只有一个不同文件**——没有任何任务图片（截图/设计稿）出现在这条线里。附件记录还带 `originalSize=1375529`、`dimensions 1024x1040`、`displayPath=packages/web/public/avatars/opus-45.png`。

## 2. Q1b：通道与时序——调用侧预处理，不是工具结果

- **31/31** 条带图腿的 upload 都发生在**首个 `inbound session_message received` 之前**（另 1 次在其后，属同 run 的后续回合）。所以它不是"猫读了图"的工具结果，而是调用前处理。
- **harness 侧排除**：qoder 适配器只传 stdin 文本（`QoderAgentService.ts:1058` `stdinInput: prompt`）；run `manifest.json` 的**全量 argv** 无任何图片参数（`-p -` / `-m` / `-o stream-json` / `--tools` / `--allowed-tools` / `--mcp-config`）；`extractImagePaths` 仅被 codex/gemini/kimi/claude-pty 适配器使用。`routes/messages.ts:2011` 的 `/avatars/…` 是 **web push 通知图标**，不是 prompt 内容块（已读代码排除）。
- **CLI 侧机制**（bundle `qoderclicn.js`）：`MK`/`Qpi` 对消息里 `type:"image"` 的 base64 块逐个上传，成功后替换为 `{type:"url"}`；上传走 `/api/v2/image/upload`（`mpi`），超时 `contractConnectTimeoutMs=10000` / `Rre=3e4`。**去重缓存是进程内 Map**（`Mre`，键 = sha256(endpoint+mediaType+data)，512 条 LRU）→ **每次 spawn 都是冷的**；每次上传还生成新的 OSS 对象（`UUID_ts.png`）→ **云端也没有去重**。
- 会话 transcript 里图以 `image_file` 附件形式存在，`resume` 腿会重放历史附件；但 **9 条 `resume=false` 腿同样上传了图**（`cli.arguments.parsed … resume=false` 已核），所以"只由 resume 重放触发"不成立。

## 3. 成本：PUT 本体 + 一段仍未归因的静默

| 段 | 实测 | 归因状态 |
|---|---|---|
| PUT 本体 | 2.96 / 4.17 / 4.56s（三次成功）；`vlyn2` 抖动下卡 **33.35s FAILED** | **已归因**：1.38MB 全量字节上传 |
| 上传前沿（`SessionStart` → `uploadImage -->`） | min 9.4s / **p50 12.2s** / max 33.6s；其中 **2/31 条腿该区间零请求**（纯静默） | **未归因** |
| 对照：非图腿同窗口 | p50 **0.6s** | 静默段是**图片路径专有** |

逐行核过的 fresh 例（`npi5mb-p15`，`resume=false`）：

```
18:24:37.251  hook.finished SessionStart:startup        ← 窗口起点
18:24:49.442  --> operation=uploadImage                 ← 中间 12.0s 零日志行
18:24:52.591  <-- operation=uploadImage (OK, 3.1s)
18:24:52.612  inbound session_message received          ← 窗口终点
```

该 12.0s 内**没有任何已埋点操作**（endpoint 同步 / catalog / auth 行都落在它之前）。要归因它必须加新仪表（harness 侧记录 stdin 写入时刻，或 CLI 侧加一行日志）——**只读日志到这里就到顶了，我不猜**。

## 4. 动作建议（按代价排序）

1. **不要把头像塞进 qoder 调用**：整条图片路径（上传前沿 + PUT）从关键路径消失，收益 = 该腿类的全部 +14–46s 窗口，而不是"缓解"。这也是"图可否省"的答案：**可省**——模型完成任务不需要猫的头像。
2. **若必须带图**：降尺寸/换编码（1024×1040 PNG 1.38MB → 512px WebP ≈ 1/10 字节），PUT 时间近线性下降；并让 CLI **跨进程复用已上传 URL**（现在是 spawn 即冷的进程内缓存，必然重传）。
3. **补仪表**：上传前沿那段现在零仪表，9–34s 的黑箱会一直吞掉归因能力。

## 5. 未定死的一环（诚实标注）

"谁把头像放进这次调用"只做到**排除法**：不是 argv、不是 harness 的 imagePaths 通道、不在 CLI 日志文本里（**但 CLI 日志会截断 prompt，所以"日志里没有"≠"prompt 里没有"**）。剩余候选：CLI 会话/附件恢复重放、prompt 文本中的图片引用。定死需要把某条腿的 stdin payload 与线程消息对上，或给 harness 侧加一行记录——**这是这条线的下一步，不是已结论**。

## 6. 顺手复核（对我自己）

- §9.3 原写"全样本 29/31 vs 9/79，p=1.0e-12"**不可复跑**：分类腿为 108（img 31 + 非 img 77），另有 2 条 `cache_status=none` 不参与分层。正确表述：**29/31 vs 9/77，Fisher 双侧 p=3.6e-16**。已改。
- Packet v3.1 表逐格复核**成立**：fresh 纯文本·无目录 cohort **n=15、窗中位 0.6s**，与"15/18 fresh"是同一 cohort，无口径混用（stale 纯文本·无目录 n=50 中位同为 0.6s）。

签名：[点点/deepseek-flash🐾]
