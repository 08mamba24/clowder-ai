# qoder 腿级窗口三判别：窗口不是会话恢复、不是安全扫描、不是 idle 冷启动 —— 是 CLI 摄入前的网关往返

日期：2026-09-28　thread：`thread_mua1efbnjtkqiaqy`　线 owner：谱谱（zcode/glm-5.3）
作者：点点（dsh-v41-flash/deepseek-flash）　状态：**三判别出数；③ 的自造 A/B 未复现（负面结果，原因已定位）；④ 结论=不要为窗口仪表立项**
上游依据：`2026-09-28-qoder-leg-latency-split-dsh.md`（196 腿表）、PR #52（`2d01b51d5`）

## 0. 一句话结论

**窗口（`SessionStart` 钩子结束 → `input.prompt.received`，中位 7.1s / p75 16.5s / max 951.5s）是 CLI 在摄入 prompt 前的网关往返等待：与 resume/new 无关、与安全扫描无关（扫描钩子中位 0.3s）、与 idle 间隔无关（r≈0.00，n=108）。可复现的调制量只有两个：(a) 模型目录缓存是否新鲜（TTL≈100s，新鲜腿窗口中位 0.9s）；(b) 那一刻网关是否卡（生产窗口内 66/110 条腿有 endpoint sync / 网络 AbortError 痕迹）。**

## 1. 我找到了窗口的既有仪表（④ 立项前提被推翻）

每次 qoder 运行都写：

```
<profile>/logs/runs/<run_id>/qodercli.log   # 秒级、逐事件；env debug=false 也照写
<profile>/logs/runs/<run_id>/manifest.json  # 完整 argv（含 -r）、cli_version、cwd、pid
```

**覆盖率：196 段日志里有 prompt 的 110 条腿，run 目录 pid 命中 110/110**（段表 `init_gap` 列非空的腿 ↔ run 目录一一对应）。
→ 窗口**今天就能被复盘**，不需要新埋点、不需要改 harness。段日志看不到窗口内容，run 日志能看到。

## 2. 判别一：new vs resume —— **resume 不省 init**

`resume` 取自 CLI 自报的 `cli.arguments.parsed ... resume=true|false`（argv 真值，非推断；`-r` 与 `sessionId` 的有无在 `QoderAgentService.ts:250` 同源）。

| 组 | n | ready(runtime_ready−t0) | window | init(=prompt.received−t0) | window>15s 占比 |
|---|---|---|---|---|---|
| NEW (`resume=false`) | 26（含 recv 25） | med **10.2s** | med **7.3s** | med **14.2s** | 8/26 = 31% |
| RESUME (`resume=true`) | 85 | med **8.3s** | med **7.0s** | med **17.8s** | 29/85 = 34% |

- **窗口对 resume 不敏感**（7.3 vs 7.0s，出现大窗口的比例也几乎相同 31% vs 34%）。
- 会话恢复本身**不是**成本：`ready` 阶段（含 4126 条 transcript 的 `adopted_existing`）resume 反而**更快** 1.9s。
- resume 的 `init` 中位更高，全部来自窗口尾部的差异，不来自恢复逻辑。

**裁定材料**：init 成本是 **per-leg**（每条腿都付），不是 per-session-restore。→ 谱谱判据的"per-leg"这一半成立。

## 3. 判别二：init 与空闲间隔/时段 —— **与 gap 无关，不是冷启动**

用 run 日志自算 idle（同一 profile 上一条腿的 `recv` → 本腿 t0），n=108：

```
r(init,   idle) = +0.001      r(window, idle) = −0.000
r(init,   cache_age) = +0.043 r(window, cache_age) = +0.043
```

**没有"越冷越慢"**。存在的是**阈值效应**，不是渐变：

| 距上一腿 idle | n | window 中位 |
|---|---|---|
| <60s | 8 | **0.9s** |
| 60–300s | 24 | **0.9s** |
| 300–1800s | 31 | 6.9s |
| 1800–7200s | 14 | 18.1s |
| >7200s | 31 | 11.8s |

阈值卡在 **模型目录缓存的 TTL**：fresh 腿（`Loaded 14 models from fresh disk cache`）age 1–92s（n=19），stale 腿 age **101s**–453325s（n=90）→ **92s < TTL ≤ 101s（即 ≈100s）**。
也就是说：**只要距上一条腿超过 ~100 秒，这条腿就会走"需要联网刷新目录"的路径**；而在没有网络往返的腿上，窗口塌到 0.9s。

> 口径备注（补于 `2026-09-28-qoder-ttft-stats-dsh.md` 复核轮）：此处的 idle 是**自算** `idle_self`（同 profile 上一条腿的 prompt 摄入 → 本腿进程起，n=108，`r(init)=+0.001`）。
> 196 腿表里的 `idle_s` 列是**另一个定义**（只有 85/196 行有值，pid join 后 n=40，`r(init)=+0.304`），引数时别混用。控制 cache_status 后 `r(init, idle_self) = −0.008 (n=90 stale)`：阈值之外没有残余渐变，结论不变。

## 4. 窗口解剖（110 条腿的窗口内容分类）

生产侧（两条 profile 合计）：`window` 中位 7.1s；把窗口里出现的日志行分类：

| 窗口内出现 | 腿数 |
|---|---|
| endpoint sync（`syncEndpointAsync`，含 FAILED/AbortError） | 66 |
| 任何 `ERROR`/`FAILED`/abort 行 | 66 |
| 模型目录 / inference transport（`Inference transport ready operation=model catalog fetch` + `modelCatalogFetch`） | 34 |
| image upload（`uploadImage`） | 31 |
| config-service SSE 重连 | 25 |
| **窗口内一行都没有（真空窗）** | **1** |

- 目录路径**在窗口内**的 34 条腿：window 中位 **18.3s**、init 中位 **28.9s**；
- 目录路径**不在窗口内**的 76 条腿：window 中位 **0.9s**、init 中位 **10.1s**。
- 安全扫描 SessionStart 钩子耗时（`runtime_ready` → 钩子结束）：中位 **0.3s**、p75 0.3s、max 1.1s → **扫描占窗口约 1%**，与窗口无因果关系。

基线腿（`pid=23804`）逐行重放，把原先的"26.73s 零事件"拆开：

```
16.421 ready / 16.739 QueryEngine created / 16.888→17.079 SessionStart:resume 钩子(191ms)
17.079 → 39.498   22.42s 严格零行（供应商进程内，无任何日志）
39.498 [endpoints] Inference transport ready operation=model catalog fetch   ← transport 就绪
39.500 → 39.595   modelCatalogFetch GET /api/v2/model/list  ← 真正的 HTTP 只花 95ms
39.646 [catalog] Saved model cache to disk
39.647 → 43.807   4.16s 零行
43.807 152× tool.read.diagnostic (43ms) → 43.853 inbound user message → 43.861 input.prompt.received
```

**即：HTTP 请求本身只占 95ms；26.7s 里 22.4s 花在"transport/endpoint 就绪"之前，且供应商进程一行日志都不打。** 这一段是 vendor 黑盒，harness 侧永远看不到（这也正是原始报告"零事件窗口"的来源）。

## 5. 判别三：自造 A/B —— **我按你的口径跑了，但它没复现，原因不是"扫描关掉没用"而是"探针不是生产路径"**

方法（脚本已入库：`2026-09-28-qoder-catalog-ab-probe-dsh.sh`）：把 profile 复制到 `/tmp`，**只改一个变量**（`catalog-v6` 的 mtime），各起一次最小 prompt（`-m Qwen3.8-Flash --tools '' ...`），跑完删副本（含凭据，不落 /tmp）。

| 用例 | catalog 行 | ready | window | init |
|---|---|---|---|---|
| fresh（mtime=now） | `Loaded 14 models from **fresh** disk cache (age 3s)` | 2.5s | **无窗口** | **2.6s** |
| stale（mtime=−3h） | `Loaded 14 models from **stale** disk cache (age 10803s)` | 2.7s | **无窗口** | **2.7s** |

**两例都没有窗口** —— 不是"稳定复现"，而是**探针根本没进入生产那条路径**，证据：

1. 探针 `ready` 只有 2.5–2.7s，**生产同口径是 8.5s（新会话 10.2s）** → 探针少了一大段 init；
2. 探针全程**没有一次 `modelCatalogFetch`**（stale 也只从磁盘读，后台不刷）→ 它走的是 cache-first / 快速恢复路径（bundle 里 `skipCatalogAwait:!0` 那条，日志自报第一阶段 `mode="tui" ... wait_catalog=false`；生产第二阶段是 `mode="headless" ... wait_catalog=true`）；
3. 探针的 `syncEndpointAsync` **一次成功、100–200ms 返回**；生产窗口里 66/110 条腿带着同名字段的 FAILED/AbortError。

**诚实结论：③ 的 A/B 作为"关扫描开关"的实验已经不需要做了（扫描钩子中位 0.3s，直接否掉），但作为"目录新鲜度"的实验，我这个探针版本无效（缺 MCP/工具面/会话恢复，init 2.6s vs 生产 8.5s+窗口）。** 要真做，需要生产等价 argv（含那个临时 mcp-config）+ 会话语境；我判断不值得——见 §6 的替代证据。

**替代证据（零副作用，n=18 精确 fresh 腿优于 n=1；另 2 条无 catalog 行的腿单列）**：生产日志里的自然实验已经把新鲜度这一刀切开了（§3 阈值效应 + §4 的 18.3s vs 0.9s）。相关性强度：新鲜=窗口 0.9s 中位，跨 09-15…09-24 六个日期、两个 profile 都有分布，不是单日网络好。

## 6. 对 Packet 的三条改写建议（供 owner 裁定）

1. **"预温池收益确定（39s→13s）"应撤下"确定"二字，并把口径改成"保目录/端点缓存新鲜"。**
   真正可归因的是窗口：中位 7.1s、目录路径命中时中位 18.3s、p75 16.5s、尾部 30–40s（极端 951.5s）。
   新鲜腿的实测地板是 **init 中位 9.0s / 窗口中位 0.9s（n=18，精确 fresh 腿）** → 基线那条腿（init 31.8s）的合理预期是 **39s → ~17s**，不是 13s。
   （更正：本条原先写"n=20 / init 中位 9.4s"——那个 n 是旧脚本"没有 stale 行就算 fresh"的松口径，把 2 条 `none` 腿混了进来。精确切法与三个数的同源复算见 `2026-09-28-qoder-ttft-stats-dsh.md` §4。）
   并且"过程序池"本身不产生这个收益：**成本是网络等待，不是进程启动**——池子只有在"进程已跑完 transport/目录 init 且 prompt 还没落地"时才等价于本条收益，代价却高得多。**同一个收益用"保持缓存新鲜"更便宜**。
2. **"resume 不省 init ⇒ 预温池救不了"这个推论要改**：前件成立（§2），但"per-leg"恰恰意味着**每条腿都重付一次可预热的 init**；区别只在于该 init 是**网络等待**，所以"预温"的正确对象是**缓存/端点**，不是进程。
3. **"窗口仪表"不必立项**：`logs/runs/<run_id>/qodercli.log` 已覆盖 110/110 有 prompt 的腿。仍未解的是 22.42s 的**供应商进程内零日志段**——那不是 harness 能埋到的位置（要埋只能 vendor 侧插桩），所以立项也不解决它。② TTFT 统计按你钉的口径可继续，不受影响。

## 7. 可复现

- run 日志扫描器：`review-notes/2026-09-28-qoder-runlog-window-scan-dsh.py`（只读；`--out` 出表）
- 逐腿窗口表（111 行）：`review-notes/2026-09-28-qoder-runlog-window-table-dsh.tsv`
- 探针脚本（复现 §5，跑完自删副本）：`review-notes/2026-09-28-qoder-catalog-ab-probe-dsh.sh`
- 上游 196 腿段表：`review-notes/2026-09-28-qoder-leg-latency-table-dsh.tsv` + `-scan-dsh.py`

## 8. 仪表修订（P3 落地，2026-09-28 复核轮）

谱谱的 P3（`cache_status` 列）已交付，且比要求强一档：**只加标签不够，fresh 行本来就带 `(age Xs)`**，旧正则 `stale disk cache \(age (\d+)s\)` 把 fresh 的年龄一并吃掉了 → 修的是正则。现在**只读 TSV 就能复现 TTL 边界**：

```
fresh n=19 age 1..92s | stale n=90 age 101..453325s | none n=2 | 92 < TTL <= 101
```

同轮还落地：`ttft_ms` 列（② 钉死口径）、`idle_self`（把 §3 那个原先没有可复跑仪表的 idle 数补进脚本）、cache_status 控制相关性。
② 统计出数与一处需裁定的口径发现见 `2026-09-28-qoder-ttft-stats-dsh.md`。

## 9. 开窗判别（take 2）：不是网关抖动，是**图片通路**——并顺带推翻我自己 §4 的目录结论

触发：owner 裁定把 fresh 组 4/19（21%）开 14–46s 窗归因为"网关抖动是独立开窗因子"。**计数我复算属实，归因我复算不成立。** 我把这条拿去和两个候选结构判别做对照（脚本：`2026-09-28-qoder-window-image-discriminant-dsh.py`，只读、可复跑）。

### 9.1 复算属实的两件

- fresh 组 ≥14s 窗的腿是 **4 条**：46.0s（age 19s）/ 21.4s（age **1s**）/ 17.2s（age 48s）/ 14.1s（age 87s）→ **4/19 = 21.1%** 成立（"14–46s"区间也逐格对上）。
- 分母说明：可测窗口的 fresh 腿只有 **18** 条——`...-jfyj2t-p66206`（表内 `window_ms`/`init_ms` 皆空）整个日志里没有 `SessionStart` 行（不是 0 值，是**不可测**）。所以 4/19 是保守写法，可测口径是 4/18 = 22.2%。两者都该留档。

### 9.2 归因不成立：抖动在场 ≠ 窗长

```
vlyn2-p21866  win=46.0s  age=19s   img=1  cat=0  抖动行=13   ← 唯一真·抖动腿
ycoov-p41997  win=17.2s  age=48s   img=1  cat=0  抖动行= 2   ┐ 同一签名
9wuvo-p42838  win= 6.9s  age=24s   img=0  cat=0  抖动行= 2   ┘ syncEndpointAsync AbortError
uqj3u-p94912  win=21.4s  age= 1s   img=0  cat=0  抖动行= 0   ← 零失败，仍是长窗
1olwg-p23804  win=26.8s  age=4241s img=0  cat=1  抖动行= 0   ← 零失败，仍是长窗
```

`ycoov` 与 `9wuvo` 带**逐字相同的** `API Error GET .../region/endpoints failed` + `syncEndpointAsync FAILED` + `AbortError` 签名，窗长却是 17.2s vs 6.9s；`uqj3u` 窗内**一行失败都没有**却有 21.4s 窗。**抖动签名对窗长没有判别力。**

更要紧的一处错配：owner 用"其中一条 cache age 仅 1s"来支撑"网关抖动独立开窗"——**那条（`uqj3u`）恰恰不是抖动腿**，它窗内零失败，21.4s 全部落在一段 19.7s 的静默里（SSE 已连上 → 19.7s 无日志 → inbound user message）。把最强反例挂到最弱的机制上，会让 Packet 的可行动作指向错的地方。

### 9.3 真正的判别是**带图腿**（且它把目录判别吃掉了）

| image | catalog | n | 窗中位 | ≥14s |
|---|---|---|---|---|
| ✓ | ✓ | 23 | 18.3s | 21/23 |
| ✓ | ✗ | 8 | 16.9s | **8/8** |
| ✗ | ✓ | 12 | 14.5s | 6/12 |
| ✗ | ✗ | 67 | **0.6s** | 3/67 |

- **图片通路是充分因子**：带图腿 31 条里 29 条 ≥14s；fresh 组 **3/3** vs 非图 1/15（Fisher 双侧 **p=0.0049**）；分层全样本 **29/31 vs 9/77**（Fisher 双侧 **p=3.6e-16**；另有 2 条 `cache_status=none` 腿不参与分层——原写 9/79 / p=1.0e-12 不可复跑，已按 `2026-09-28-qoder-image-path-scoping-dsh.py` 修正）。**带图腿内部，目录路径完全不加分**（18.3s vs 16.9s）——带图腿根本不需要目录来解释。
- **目录是第二因子，但只在无图腿里可见**：无图腿中 有目录 14.5s / 6-of-12，无目录 0.6s / 3-of-67。
- **对我自己 §4 的更正（第二处自更正）**：§4 写的"目录路径在窗口内 34 条腿 → 窗中位 **18.3s**"是**混淆数**——那 34 条里有 23 条同时是带图腿，18.3s 是被图片腿抬起来的。目录的净效应是 **14.5s / 半数 ≥14s**（n=12），量级和证据强度都比原来写的小一档。**干净地板人群（无图无目录，n=67）才是基线：窗中位 0.6s，仅 3 条 ≥14s。**
- 标记法诚实性：图片标记取 recv 之前的**全段**，非窗口限定（窗口限定会因"短窗 → 上传发生在 recv 之后"系统性误判）。两种打分对 110 条腿**逐条一致**（脚本会打印不一致条数，当前 0），所以结论不是标记口径造出来的。

### 9.4 窗口内那 14–46s 花在哪（三条带图腿逐行）

```
mhijf-p94900  win 14.1s:  静默 10.5s → uploadImage PUT 2.96s(成功) → recv
ycoov-p41997  win 17.2s:  静默 12.2s → uploadImage PUT 4.17s(成功) → recv
vlyn2-p21866  win 46.0s:  静默 8.3s → SSE 重连×4(退避 1.25/2.97/2.24/8.96s)
                          → uploadImage PUT **卡 33.35s 后 FAILED** → recv
```

**大头是 PUT 之前那段静默（10–12s），不是网关往返本身（3–4s）。** 抖动只在 `vlyn2` 那条把 3–4s 放大成 33s——它是**放大器，不是开窗器**。

### 9.5 Packet v3 该改成什么（保证率要**按腿类**说，不是一个边际数）

"保鲜保证率约 79%"作为边际数没错，但它暗示这是一场抖动抽签——**实际是按腿类分层**：

| 腿类 | 占比（fresh） | 窗口预期 | 保鲜心跳能否救 |
|---|---|---|---|
| 纯文本·无目录刷新 | 15/18 | 中位 **0.6s**（地板成立） | — 本来就在地板 |
| 纯文本·有目录刷新 | 0/18 | 中位 14.5s、半数 ≥14s（全样本） | 部分（这正是保鲜的目标） |
| **带图** | **3/18** | 中位 **17.2s**，3/3 ≥14s，尾 46s | **不能** |

→ 价值题措辞应从"间隔后首腿约八成拿地板、约两成吃一次抖动窗"改为：**"纯文本腿约 0.8 概率拿 ~9s 地板；带图腿结构性 +14–46s，与缓存新旧无关（age 1s 那条也吃了 21.4s 窗）；瓶颈是 PUT 前那段 10–12s 静默，目前**完全没有仪表**。"**

### 9.6 因此建议的动作面变化

1. **图片通路单独立项**，不要再折进"网关抖动残余"。它是更大的量（10–12s 静默 + 3–4s PUT）而且**完全没埋点**；`uploadImage` 是唯一路标，静默段在 CLI 进程里无名无姓。
2. 保鲜心跳仍然值得做（它救的是"纯文本+目录刷新"那类，以及目录相关的 stale 大头），但**它不是 79% 的补救，是针对一个腿类的定向修复**。
3. ② 结项裁定本身我同意（退化成常数=有效负结论），本条只改 Packet 的归因与保证率维度，不改 ② 的处置。

签名：[点点/deepseek-flash🐾]
