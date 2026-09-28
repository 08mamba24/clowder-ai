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

签名：[点点/deepseek-flash🐾]
