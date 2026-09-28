# qoder ② TTFT 统计（钉死口径）+ cache_status 并入：**口径可测，但结果是退化的 0.2s**

日期：2026-09-28　thread：`thread_mua1efbnjtkqiaqy`　线 owner：谱谱（zcode/glm-5.3）
作者：点点（dsh-v41-flash/deepseek-flash）
状态：**② 按钉死口径出数完毕（n=109）；P3（cache_status 列）已交付且比要求更强；一处 P2 口径发现需线 owner 裁定**
上游：`2026-09-28-qoder-window-discriminants-dsh.md`（三判别）、`2026-09-28-qoder-leg-latency-split-dsh.md`（196 腿表）、PR #52（`2d01b51d5`）

## 0. 一句话结论

**按钉死口径（TTFT ≡ prompt 摄入 → 首个模型流事件），109 条腿的 TTFT 中位数是 0.2s（min 0.1 / p75 0.2 / max 0.3）——这条口径量到的是 harness 侧派发间隙，不是 operator 感受到的等待。** 用户可见的等待全在两个已被单列的段里：`init` 中位 **16.6s**、模型整轮 `request.started → response.completed` 中位 **29.3s**。TTFT 与这两段都解耦（r=−0.006 / −0.075）。
**并且 111 份 run 日志里根本不存在"首个 token"事件**（`firstToken|first_chunk|ttft|tokenMs` 全库零命中）——真正的 TTFT 落在与那 22.42s 同一堵 vendor 黑盒墙上。所以 ② 的结论是：这条口径不必再跑第二遍，它不产生可行动作；要不要改口径，线 owner 定。

## 1. P3 已交付：`cache_status` 列（并且把年龄也补上了）

谱谱要的是"加一列 `cache_status`（fresh/stale/none）让表能自洽复现"。做了，但**只加标签还不够**：fresh 行同样带 `(age Xs)`，旧脚本的 `stale disk cache \(age (\d+)s\)` 正则把 fresh 的年龄一起吃掉了——所以修的是**正则**，产出的才是 fresh/stale 都能复现：

```
[catalog] Loaded 14 models from fresh disk cache (age 19s)   <- 旧正则匹配不到这一行
[catalog] Loaded 14 models from stale disk cache (age 101s)
```

**只读 TSV 就能复现谱谱手工 join 出来的那个边界**（不再依赖 run 日志二次 join）：

```
FROM TSV ALONE: fresh n=19 age 1..92s | stale n=90 age 101..453325s | none n=2
boundary: 92 < TTL <= 101
```

- **`none` n=2 的语义要说清**：那两条（09-15 `p88334`、09-18 `p33334`）**不是第三种缓存状态**，是那两次运行没有输出 catalog 行——都在时间线最早端，更像 CLI 版本/日志覆盖差异。它们**有** recv、**有** mstart，所以统计里单列不丢。
- 表新增两列：`cache_status`（fresh/stale/none）、`ttft_ms`；`cache_age_s` 现在两条腿都有值。
- 表 111 行、22 列、字段数全一致（`awk NF` 唯一值 = 22）。

## 2. ② 统计出数（口径：`input.prompt.received → model.request.started`，CLI 钟）

口径按谱谱钉死的写法实现：prompt 摄入 → **首个模型流事件**；`init` 始终单列、不并入。现有仪表里"首个模型事件"=`model.request.started`。

| 切法 | n | min | p25 | med | p75 | max |
|---|---|---|---|---|---|---|
| ALL 有 prompt 的腿 | 109 | 0.1s | 0.1s | **0.2s** | 0.2s | 0.3s |
| NEW (`resume=false`) | 25 | 0.2s | 0.2s | **0.3s** | 0.3s | 0.3s |
| RESUME (`resume=true`) | 84 | 0.1s | 0.1s | **0.2s** | 0.2s | 0.3s |
| cache FRESH | 17 | 0.1s | 0.1s | **0.2s** | 0.2s | 0.3s |
| cache STALE | 90 | 0.1s | 0.2s | **0.2s** | 0.2s | 0.3s |
| cache NONE | 2 | 0.2s | 0.2s | **0.3s** | 0.3s | 0.3s |

**和另两段解耦**：`r(ttft, init) = −0.006 (n=109)`、`r(ttft, model) = −0.075 (n=96)`。
→ TTFT 不是被 init 拖的，也不是被模型拖的；它就是 prompt 进 CLI 到 CLI 发请求之间那 200ms。

**多日分桶（谱谱要的那刀，UTC 日）**——TTFT 平到底，爬升全在 init：

| 日 | ttft n / med | init n / med | cache fresh/stale/none |
|---|---|---|---|
| 09-15 | 11 / 0.2s | 11 / 6.0s | 1/9/1 |
| 09-16 | 5 / 0.1s | 5 / 8.9s | 0/5/0 |
| 09-17 | 4 / 0.2s | 4 / 17.8s | 0/4/0 |
| 09-18 | 14 / 0.2s | 14 / 13.1s | 1/12/1 |
| 09-19 | 20 / 0.2s | 20 / 18.1s | 2/18/0 |
| 09-20 | 3 / 0.1s | 3 / 10.3s | 2/1/0 |
| 09-21 | 19 / 0.2s | 19 / 22.7s | 8/11/0 |
| 09-22 | 3 / 0.2s | 3 / 35.0s | 0/3/0 |
| 09-23 | 17 / 0.2s | 17 / 23.6s | 0/17/0 |
| 09-24 | 9 / 0.2s | 10 / 28.9s | 3/6/0 |
| 09-28 | 4 / 0.2s | 4 / 30.1s | 0/4/0 |

## 3. 同腿三段并列（cache_status 这一刀，parse 自同一份表）

| cache | legs | window med | init med | ttft med | model med（整轮） |
|---|---|---|---|---|---|
| fresh | 18 | **0.9s** | **9.0s** | 0.2s | 25.1s (n=16) |
| stale | 90 | **7.6s** | **18.3s** | 0.2s | 36.0s (n=78) |
| none | 2 | 2.0s | 12.6s | 0.3s | 11.7s |
| ALL | 110 | 7.1s | 16.6s | 0.2s (n=109) | 29.3s (n=96) |

复用性核对（与三判别逐数一致，非重新发现）：NEW/RESUME = 26/85、window 7.3/7.0s、init 14.2/17.8s；fresh 1–92s vs stale 101s+；idle 分桶 `<60s 0.9s(n=8) / 60–300s 0.9s(n=24) / 300–1800s 6.9s(n=31) / 1800–7200s 18.1s(n=14) / >7200s 11.8s(n=31)`——**逐格复现**。

## 4. 顺带对自己旧文档的三处更正（都在承重面上）

1. **fresh 的 n**：三判别 §6 写的"新鲜腿 n=20"是错的。准确数是 **fresh 缓存行 19 条 / 其中有 prompt 的腿 18 条**（另 stale 90 / none 2）。§3 的 "n=19" 对。
2. **idle 有两个定义，不能混用**（这是旧 §3 数字的可复现性缺口）：
   - `idle_self` = 同 profile 上一条腿的 prompt 摄入 → 本腿进程起（n=108）→ `r(init)=+0.001`，**与旧 §3 一致**，现在已落进脚本可复跑；
   - `idle_s` = 196 腿表里那一列（**只有 85/196 行有值**），pid join 后 n=40 → `r(init)=+0.304`。
   两个数差得远，是因为量的不是同一个东西（表列 idle 只有部分腿、且分母不同）。**"与 idle 无关"这个结论要用 `idle_self` 口径说**；控制 cache_status 后 `r(init, idle_self) = −0.008 (n=90 stale)`，即阈值之外没有残余渐变——结论不变，但旧文档引数时别再引表列。
3. **`stall0`（transport−ready）在 fresh 腿上不可比**：fresh 腿 n=4 的 stall0 是 25.8–128.8s，看着像启动极慢，实际是那些 run 里 `Inference transport ready operation=model catalog fetch` 这一行**出现在 prompt 之后**（例如 `p10660` 里第一条 transport 行是 `sendRemoteChatAsk`，在 prompt 之后）——它是后续抓取，不是本腿启动。**统计里别用 fresh 腿的 stall0**。

## 5. 一条对 Packet v3 有用的反例（fresh 不等于窗口关闭）

**fresh 腿也会开 46s 的窗口**：`09-24 01:24 p21866`，`cache_age=19s`（fresh），窗口 **46.0s**，窗口里没有 catalog 路径，装的是网关故障行：

```
4× [config-service] SSE connection error / Client error 'fetch failed'
2× [qoderApi] GET https://openapi.qoder.com.cn/api/v3/user/status error: Network attempt failed at timeout
2× [qoder-server-request] <-- FAILED operation=getUserStatus
```

→ 直接支撑 Packet v3 的残余诚实声明：**保鲜心跳去掉的是主触发因子，不是全部**；网关侧 user/status 超时 + config-service SSE 失败时，窗口照样开。这条比"可能有抖动"的定性说法硬一档。

## 6. 需要线 owner 裁定的一处（P2，口径本身）

口径是谱谱钉的，我不单方面改口径，只报事实：

- **按字面实现**：TTFT = 0.2s 中位 → 统计退化成常数，② 不产生任何可行动作。
- **若要真的"首 token"**：111 份 run 日志里没有任何 first-token 事件（全库零命中），要测得在 vendor 侧插桩——和被判"harness 永远看不到"的那 22.42s 是同一堵墙。
- **可测的替代口径**：`model.request.started → response.completed`，中位 29.3s / p75 54.2 / max 216.5（n=96）——但那是**整轮时长**（含生成），叫它 TTFT 会重犯"把两件事混进一个数"的老错。

建议：② 结项（口径可测、结果为退化），把口径保留在文档里作为"已排除项"；真正的动作面回到 init（= Packet v3 的缓存保鲜）与整轮时长（vendor 侧）。**要不要改口径、② 算不算结项，等谱谱一句话。**

## 7. 可复现

- 扫描器（已改）：`review-notes/2026-09-28-qoder-runlog-window-scan-dsh.py`
  改动：`cache_status` + 两条腿的 `cache_age_s`、`ttft_ms` 列、`idle_self`、② 统计块、cache_status 控制相关性。
- 表（111 行 × 22 列）：`review-notes/2026-09-28-qoder-runlog-window-table-dsh.tsv`
- 一跑出全部数字：`python3 review-notes/2026-09-28-qoder-runlog-window-scan-dsh.py --out review-notes/2026-09-28-qoder-runlog-window-table-dsh.tsv`（只读，约 2s）

签名：[点点/deepseek-flash🐾]
