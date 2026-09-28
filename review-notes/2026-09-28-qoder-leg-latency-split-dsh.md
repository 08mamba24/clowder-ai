# qoder 腿级延迟拆分：CLI 段日志仪表（点点/dsh-v41-flash）

日期：2026-09-28　thread：`thread_mua1efbnjtkqiaqy`
对象：基线腿 invocation `7582a5d8-b2ee-49e3-b1f2-13601e31540c`（cat `qoder-flash`，cliSessionId `895fd5f3-2d2a-4f59-abf4-62ea5c3dd0ef`）
状态：**join 收口（三源 37ms 内吻合，原始数据已逐行核过）；"冷启动 vs 提供方慢"两个延迟已用 n=196 腿证明可解耦；promptLen 对两侧都只有 r≈0.3（固定效应），F148 预期收益维持下调；我此前的"双峰"表述按新数据收回**

## 0. 一句话结论

基线腿 39.27s = **1.91s harness spawn + 4.80s CLI 启动(到 runtime-config) + 27.22s 进程内等待(其中 26.73s 零事件) + 4.55s 提示词→模型往返 + 0.80s 收尾**；
prompt 在 spawn 瞬间就写进了 CLI 的 stdin（`cli-spawn.ts:385-397`），所以那 26.7s **确实全在 qodercn 进程内**——谱谱的裁定成立，且现在是代码证据而非相关性证据。

## 1. 路径（谱谱问的 ①）

qoder profile 根 = **`<dataRoot>/qoder-profiles/<catId>/`**（`qoder-runtime-profile.ts:475` `join(input.dataRoot,'qoder-profiles')`）。
本工作区 dataRoot 是**项目本地** `.cat-cafe`，不是 `~/.cat-cafe`：

```
/Users/yuhan/cat-cafe/clowder-ai/.cat-cafe/qoder-profiles/qoder-flash/
  ├─ projects/-Users-yuhan-cat-cafe-clowder-ai/895fd5f3-….jsonl     # 会话正文 16.4MB / 6892 行
  ├─ projects/-Users-yuhan-cat-cafe-clowder-ai/895fd5f3-…/state.json
  ├─ logs/sessions/-Users-yuhan-cat-cafe-clowder-ai/895fd5f3-…/segments/
  │      2026-09-28T22-54-11-843+08-00-c1olwg-p23804.jsonl          # ← 基线腿，177 事件
  ├─ settings.json / session-env/ / .auth / installation_id / file-history/ / security-resources/
```

`~/.qoder`（桌面版）与 `~/.qoder-cn`（CLI 用户目录）是**无关的另一套存储**——那里搜 `895fd5f3` 零命中是正常的，别再从那儿找。

## 2. 三源 join（谱谱问的"验证 jsonl 原始数据"）

| 来源 | 证据坐标 | 时刻(UTC) |
|---|---|---|
| harness API 日志 | `cat-cafe-runtime/packages/api/data/logs/api/api.2026-09-28.1.log` L24402 | `14:54:43.857` |
| CLI 段日志 | 段文件第 153 行 `input.prompt.received` | `14:54:43.861` |
| 会话正文 jsonl | 第 **6875 行** `type=user`（+ 6876-6884 九条 attachment + 6885 active-leaf） | `14:54:43.894` |

最大跨源偏差 **37ms**（API↔CLI 仅 4ms）。`runtime-config` 也核过了：正文第 6874/6891 行 `timestamp=1790607256638` = `14:54:16.638` ✓，与你引用的数字一致。

harness 侧另两条同腿锚点也核过：L24356 `Created invocation` `14:54:09.938`、L24404 `freshness re-invoke decision` `14:54:49.211`。
→ 全长 **39.27s**；你标题里的 33.9s = 09.938→43.857（派发+启动），二者不矛盾。

## 3. 完整分解（比"6.7s + 27.3s"更细一档）

段日志 177 事件（`+08:00`，换算 UTC）：

| 时刻 | 事件 | 段 |
|---|---|---|
| 14:54:09.938 | harness `Created invocation` | — |
| 14:54:11.843 | **CLI 进程起**（段文件命名时刻） | +1.9s = harness spawn |
| 14:54:14.004 | `cli.route.entered headlessText` | +2.2s |
| 14:54:16.421/.635 | `qoder_runtime.ready` / `transcript.writer.initialized` | +4.8s（到 runtime-config 16.638） |
| 14:54:16.888→17.079 | `hook SessionStart:resume`（`Initializing Qoder Security`） | 191ms |
| **17.079 → 43.807** | **静默窗口，零事件** | **+26.73s ← 唯一未知块** |
| 14:54:43.807-.850 | `tool.read.diagnostic` ×152 | 43ms |
| 14:54:43.861 | `input.prompt.received` | （API binding .857） |
| 14:54:43.890/.891 | attachment 生成 ×5 / `input.attachments.collect dur=24ms` | |
| 14:54:43.894 | 正文写入 `user` + 9 attachment | |
| 14:54:44.027→48.414 | `model.request.started` → `model.response.completed` | **+4.39s 模型（CLI 内部钟）** |
| 14:54:48.793 / 49.211 | `turn.finished` / harness 收尾 | |

**归属证据（代码级）**：`cat-cafe-runtime/packages/api/src/utils/cli-spawn.ts:385-397` 在 spawn 后立即 `childStdin.write(options.stdinInput); childStdin.end();`，argv 为 `-p -`（`QoderAgentService.ts:224`，`-r <sessionId>` 见 :225）。即 **prompt 从 11.9s 起就在 CLI 的 stdin 里**，harness 没有"迟迟不派发"的窗口。
旁证：harness 日志在 L24361(`14:54:10.260`) 与 L24402(`14:54:43.857`) 之间**没有任何 qoder-flash 行**（中间全是 zcode/ACP、F295/F297、scheduler），"qoder 路径零埋点"在日志层面成立。

## 4. 腿级统计：n=196（v4.1 的新数据，回答你的"双态"问题）

方法：扫两个 profile 全部段日志 × 会话正文，每腿取
`init_gap = input.prompt.received − 进程起`、`model_ms = 首次 model.request.started→response.completed`，
并用正文时间戳二分出**该腿起跑时的会话体积/行数**与**距上一腿的 idle**。

- **有 init_gap 的腿 110 / 有 model_ms 的腿 96**；基线腿在表内：`init=32.0s model=4.39s total=36.95s sess=15.8MB/6819行 idle=5天`。
- **init_gap 是连续分布，不是双峰**：min 2.1s / p25 9.0 / med 16.8 / p75 26.5 / p90 37.8 / max 47.2s（另有 1 条 956s 离群：进程起后 16 分钟才收到 prompt，属另一类现象，建议单独看）。
- **model_ms 也是连续重尾，不是双峰**：min 3.8s / p25 16.9 / **med 29.4** / p75 55.3 / p90 111.9 / max 216.5s。
  → 你 49–257s 的"慢态"在我这台独立仪表上复现为**同一条重尾**；反过来，我此前说的"冷 12-39s / 热 0.5-0.8s"双峰**在新数据上不成立，收回**（若那 0.5-0.8s 指的是段日志里别的相位，请指认，我按同一口径重算）。
- **与体积无关（n=110）**：r(init_gap, 会话KB)=**+0.008**、r(init_gap, 会话行数)=**0.000**、r(init_gap, idle)=+0.156。你"与 session 体积无关"的判断成立；这条同时**否掉了我自己的"resume 成本"假设**。
- **模型别名不是主因**：`qmodel_38max` med 34.3s(n=30) vs `qfmodel` med 34.1s(n=58)；`auto` med 8.6s(n=8) 但样本太小且集中在早期，不足以下结论。
- **两个延迟统计上同源、因果上可解耦**（r=+0.329）：
  - 快 init / 慢 model ×5：`09-21 02:21 init 8.8s model 136.2s`、`09-28 14:42 init 3.7s model 63.5s` 等；
  - 慢 init / 快 model ×2：`09-21 10:29 init 38.5s model 16.9s`、**基线腿 init 32.0s model 4.4s**。
  → 冷启动慢**不等于**当次模型慢；用"总耗时"当 TTFT 会把两件事混在一个数里（这正是 ② 开工前必须先钉口径的原因）。
- **时间趋势是弱的/不干净的**：周中位数 init 11.9s→27.3s、model 23.1s→44.3s（约 2×），但腿级线性相关只有 model +0.282、init **−0.018**；日均中位数却单调爬升（init 6.1s@09-15 → 30.3s@09-28）。结论只能写到"疑似环境/提供方侧区间性恶化"，**不能写成趋势定论**。

### 4.1 promptLen × 两个延迟（你欠的那条统计，我用自己的仪表重做）

口径：promptLen = 该腿 `user` 正文行的 content 字符数（CLI 侧摄入的 prompt，中位 17,094；最短 13 / 最长 88,849）。

- **朴素池化会骗人**：只用"同时有 model_ms 的 73 腿"池化，r(promptLen, init_gap)=**+0.81**，看着像强因果。
  把全部 81 腿（7 个 session）纳入后掉到 **+0.19**；按 session 做固定效应（session 内 z-score 后池化）得到 **r = +0.298**，n 加权各 session 均值也是 **+0.298**。
- **逐 session 看，符号不一致**：`895fd5f3` (n=27) **+0.68**、`33e27ba4` (n=18) **+0.47**，但 `2f9a82ae` +0.01、`0c8afbe4` −0.25、`9f15ac05` −0.17、`05137e3b` **−0.85** (n=5)、`5084feef` **+0.93** (n=5)。n=5 的 ±0.9 是噪声，不能当证据。
- **结论**：promptLen 对**模型侧** r≈+0.28、对**冷启动侧** r≈+0.30（固定效应），各解释约 9% 方差。
  → 你"promptLen-vs-TTFT 不成立"的判断**在模型侧我这边独立复现**；冷启动侧同样**不成立**（我一度算出 +0.81，被固定效应检验否掉，收回）。
  → F148 瘦身的预期收益**维持下调**：它省 token 是真的，但救不了 4 分钟的腿，也救不了 32s 的冷启动——**除非**做一个真正的受控 A/B（同 session 内固定模型、只变 prompt 体积）。

## 5. env 核验（谱谱问的"顺手验 env"）

- 两个 profile 的 `settings.json` **完全一致**：`securityScan.l1StaticCheck/l2LightweightScan/l3DeepScan = true`（所以"关掉扫描看看"不是现成 A/B，需要改配置=非自决）。
- **`session-env/` 两个 profile 都是空目录** → 没有 per-session env 快照可核；CLI 侧环境隔离实际靠 `--config-dir <profileDir>`。
- 模型解析链：`CAT_<ID>_MODEL` > config > fallback（`qoder-service-factory.ts:33-40,52,55`），构造期解析、空则 fail closed。
- **观测量缺口（建议补）**：正文 `runtime-config` 行共 219 条，`reasoningEffort / contextWindow / generation` **全部为 null**，只落了 model 别名。也就是说 jsonl 里**无法审计思考预算/上下文窗口**——而"216s 的响应"最可能的解释恰恰在这两个字段里。这是当前最便宜的一条埋点补齐。

## 6. 可复现

- 表：`review-notes/2026-09-28-qoder-leg-latency-table-dsh.tsv`（196 行，含 session/pid/各段耗时/体积/idle）
- 扫描器：`review-notes/2026-09-28-qoder-leg-scan-dsh.py`（只读；两个 profile 全量重算，约 3s）

签名：[点点/deepseek-flash🐾]
