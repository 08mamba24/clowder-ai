# PR #67 Alpha 真实 journey 验收——cold/compaction PASS（谱谱）

日期：2026-11-08　thread：`thread_mvhqzo9b2l03e98g`
对象：PR #67（fix(f296) alpha UAT harness 对齐统一投递生命周期）合入后，按砚砚61 授权接续的隔离 Alpha cold/compaction 真实 journey 验收。
绑定 merge SHA：`cee530314313ab43164536f94a4d2f60bdf3177a`（squash 单父 `93618b047`，独立经 mcp 只读通道 + git fetch 双核实 MERGED）。
结果工件：`2026-11-08-f296-alpha-uat-pr67-result.json`（UAT 原样输出，exit 0）。

## 0. 结论

**验收 PASS。** 在 merge SHA `cee530314` 的隔离 Alpha 栈上，真实模型链路（canary `f296-canary` → 账号 `my-codex-walle` api_key → 中继 → `gpt-5.6-sol`）跑通：

| journey | 结果 | 证据要点 |
|---|---|---|
| cold | **passed/observed** | no_prior_session，latency 17682ms，trace a35cd76c… |
| resumed-small | **passed/observed** | hot resume_confirmed，16596ms |
| resumed-large | **passed/observed** | hot resume_confirmed，delta=large，8316ms |
| authoritative-compaction | **passed/observed** | 服务端 `POST …/compact-native → 200`（req-2z，24707ms），trace c3ff4942… |
| replacement | unsupported / `replacement_input_missing` | 无运营侧 `--oversized-native-thread-id` UUID 输入，harness 按约本地分类、未发请求（PR #67 设计行为） |
| dynamicPresentation | unsupported / `canonical_dynamic_producer_unavailable` | 真实 alpha 无 canonical dynamic producer 路由，harness 自身设计分类（f296-alpha-uat.mjs:309-316），非失败 |

对照 2026-11-06 基线：当时 cold 卡 `invocation_rejected`（harness↔schema 漂移）、compaction 卡 409 级联。**本轮在 PR #67 代码修复 + §2 两项部署前提修正的共同作用下**，400 契约拒绝未再出现、compaction 走到真实 200；账号拓扑与 web 构建戳修正的贡献属部署前提，不归代码修复本身（第一轮 UAT 在账号拓扑未修正时 compaction 仍报 `native_session_busy` 级联，即为证）。

## 1. 部署链（全部当场实测）

- alpha worktree `cat-cafe-alpha` fast-forward `ad0c52d20 → cee530314`（behind 13 清零，工作区干净），lockfile 无变化。
- 四构建戳一致 = `cee530314`：shared/api/mcp-server dist + web `.next`。**web 戳一度滞留 `ad0c52d20`**（见 §2 坑②），`--no-quick` 全量重建后对齐。
- 启动：从**主仓** `clowder-ai` 跑 `./scripts/alpha-worktree.sh start -- --prod-web`（坑①修正后），redis 6397 全程存活（PONG，dbsize 112，数据连续）。
- 健康门：`/health` ok + `deploymentRevision=cee530314…`；`/ready` ready（redis/sqlite/sessionHooks 全 ok）；3011=200；4111=400（正常握手拒绝）；9464 `/metrics`=200（`TELEMETRY_HMAC_SALT` 缺失则遥测不初始化，本次启动前新生成注入）。

## 2. 过程中定位的两个部署坑（根因级，均已修在操作层）

1. **launch 上下文错绑 WORKSPACE_ROOT → 账号库失联（P2）**：在 alpha 树内直跑 `alpha-worktree.sh`，其 `PROJECT_DIR`（脚本 line 6 = 脚本父目录）落为 alpha 树，`apply_alpha_env` 据此导出 `CAT_CAFE_WORKSPACE_ROOT=cat-cafe-alpha`。账号库拓扑（`account-store-topology.ts:45`）以 WORKSPACE_ROOT 为 primaryRoot → 找 `cat-cafe-alpha/.cat-cafe/accounts.json`（不存在）→ 队列反复 `bound account "my-codex-walle" not found`，表象为 cold 超时 + `all_candidate_slots_busy` 噪声 + compaction `native_session_busy` 级联。**修正：从主仓 `clowder-ai` 启动 wrapper**，WORKSPACE_ROOT=主仓 → 账号库回到 `clowder-ai/.cat-cafe/accounts.json`（`my-codex-walle` 实存，顶层 dict 键），catalog 仍从 alpha（canary 所在），与 11-06 可用态一致。凭据零新增、零复制。
2. **`--prod-web --quick` 复用陈旧 `.next` → revision 门 null（P2）**：quick 路径见 `BUILD_ID` 即跳过 web 重建，web 戳滞留旧 commit；`resolveRuntimeDeploymentRevision`（`runtime-deployment-revision.ts:26`）要求 api 戳===web 戳，不等则 `/health deploymentRevision=null`，UAT revision 门必挂。修正：`--no-quick` 强制全量 web 生产构建。**建议后续给 quick 复用加"戳=HEAD"新鲜度校验**（另立小改，不属本次验收）。

## 3. 边界与如实声明

- 日用 runtime（`cat-cafe-runtime`，3003/3004/6399）全程未动；本验收只操作 alpha 栈与其保留口。
- replacement 未执行真实验收：需运营提供 oversized native thread UUID（`--oversized-native-thread-id`），本次无该输入；harness 已按 `replacement_input_missing` 如实分类，**不得**记为 PASS。
- dynamicPresentation 同理为分类性 unsupported，非 PASS 声明。
- 第一轮 UAT（账号拓扑修正前，exit 1，cold `invocation_timeout`）留档于 `/tmp/f296-uat-pr67.json`；其价值是暴露坑①，结果不计入验收。
- **trace/span 证据边界（UNVERIFIED）**：四条 journey 的 trace/span 引用是 harness canonical 输出的原样记录（格式合法、与归档 JSON 一致，独立复核已确认），但未保存独立的脱敏 span 快照；栈现已关停，无法逐 span 回读——**span 级原始证据标 UNVERIFIED**。journey 的 `passed(observed)` 判定依据是 harness 断言与服务端请求日志（compact-native req-2z 200），不依赖该回读。
- **alpha 栈状态（区分两个时点）**：验收当时（2026-11-08 04:0x UTC，UAT 运行窗口）3011/3012/4111/9464 全部在服务、redis 6397 PONG（dbsize 112）。**最终交接状态**（04:12 UTC 起砚砚61 与谱谱各自独立实读一致）：三口 + 9464 均 connection refused，仅 redis 6397 存活（dbsize 211，数据连续）。**停止原因未核实**：daemon 自身 JSON 日志至 04:05:19 `/health` 200 无任何错误，随后一行 pnpm `ELIFECYCLE Command failed`（wrapper 某子命令失败）触发 start-dev 收尾 trap 优雅关闭（"正在关闭服务…再见🐾"，非 API 崩溃）；失败的具体子进程与触发因素在留存日志中不可辨。谱谱未执行 stop/kill；砚砚61 声明其核验为只读、未执行 stop。复验需按 §1 配方重启（从主仓启动 wrapper，注意 §2 两坑）。

## 4. 工位（最终交接状态）

`cat-cafe-f296-fix`（我的 PR 工位）已于交接时 finish：确认 `8e9006bc7` 存在于 origin PR 分支后，`git worktree remove` + 删除本地分支；当前 `git worktree list` 已无该条目（独立复核同读）。alpha 验收实际在 `cat-cafe-alpha` 栈完成，该 worktree 保留。

[谱谱/glm-5.3🐾]
