# Alpha daemon 启动与验收 handoff（谱谱）

日期：2026-11-05（快照时间 00:18 CST）　thread：`thread_mvhqzo9b2l03e98g`
任务：[PR #63](https://github.com/08mamba24/clowder-ai/pull/63)（merge: sync upstream 42017e0c and restore merge ancestry）合入 main 后，按 SOP 在 alpha 通道拉起 daemon 并**实际测试验收**。任务由铲屎官发起、谱谱（zcode/glm-5.3）持有。
本文只登记现场，不改写、不清理。

## 0. 一句话状态

**daemon 已拉起且核心健康（API `/health` ok、`alpha:status` 全绿、与 origin/main 完全同步），但"实际测试"未开始**：F296 UAT 在本 daemon 上 0 次运行、启动时存在 1 条 MCP 缺口（alpha 特有，4 个 server 未解析）、前端 3011 本机探测 000 待复核。

## 1. 环境 / 进程快照（2026-11-05 00:18 CST 实测）

| 组件 | 状态 | 证据 |
|---|---|---|
| alpha worktree | `/Users/yuhan/cat-cafe/cat-cafe-alpha`，branch `alpha/main-sync`，head `ad0c52d20`（= Merge PR #63，2026-11-04 21:19 +0800），dirty 0，ahead/behind origin/main = 0 | `alpha-worktree.sh status` |
| daemon | `scripts/start-dev.sh --quick --cat-cafe-daemon-token=***`，wrapper PID 83699（23:45:41 启动），node 主进程 PID 84065 | `ps` |
| redis | `127.0.0.1:6397`（23:45:43 起），PONG，dbsize=12。6397 为 alpha 保留口（`start-dev.sh:451` 强制 `CAT_CAFE_DEPLOYMENT_ID=alpha` 才许用） | `redis-cli -p 6397` |
| API | `3012 /health` → `{"status":"ok", …, deploymentSubjectRef:"…:alpha", bootSequence:3}` | curl |
| preview gateway | 4111 监听（plain HTTP 返 400，属正常握手拒绝） | curl / lsof |
| Prometheus | 9464（`/` 返 404，指标路径应为 `/metrics`） | curl |
| 前端 | 3011 = next-server v14.2.35（PID 86000）——**127.0.0.1 与 [::1] 两次 curl 均 000（3s/8s），待复核**（next dev 首次编译可能超时） | curl / ps |
| whisper | 9876 在跑（PID 71249，00:10:27 重启）；但 `services.json` 记 `whisper-stt enabled=false` —— **口径不一致，待复核** | ps / `.cat-cafe/services.json` |
| 能力供给 | `capabilities.json` 00:09 更新；`mcp-creds/` 42 项，00:12 最后写入 | ls |

## 2. 已验证健康项

- API `/health` ok（3012）。
- `alpha:status` 全绿：`api_running: yes`，3011/3012/4111/6397 全登记，`env_source` 指向 alpha 自己的 `.env`。
- alpha redis PONG。
- daemon 日志：调度器（f309 artifact/modification-request recovery、f233 ball-custody-probe、F167 managed-command wake sweep、paw-feel-disposition）全部正常 tick，无 level-60。
- git：与 origin/main 同步（ahead 0 / behind 0），工作区干净，跑的就是 PR #63 合并结果。

## 3. 唯一 level-50：MCP 白名单缺口（alpha 特有）

日志 `15:45:52Z`（= 23:45:52 CST，启动即报），`acp-mcp-resolver`：

- missing：`zai-mcp-server`、`zread`、`web-search-prime`、`web-reader`
- resolved：`cat-cafe-memory`、`cat-cafe-collab`、`cat-cafe-signals`（3/7）
- 原文："MCP whitelist entries not found in capabilities.json — these servers will NOT be available to ACP agent"

**判定**：主 runtime（`cat-cafe-runtime/.cat-cafe/capabilities.json`）四个全有 → 缺口是 **alpha 实例特有**，不是全局配置问题。
**时序**：daemon 23:45:52 解析时 capabilities.json 尚无这 4 项；该文件 00:09 才更新、mcp-creds 00:12 仍在写 —— 凭证晚于启动到位，而 resolver 只在启动时跑，未重新解析。
**处置选项**：(a) 凭证现已到位 → 按流程 `pnpm alpha:stop` + `alpha:start` 重启后复验 7/7；(b) 若这 4 个 server 属用户级授权、不适用 alpha，则记录边界结论收档。**需验收人/铲屎官拍板，不要直接 kill 进程。**

## 4. 验收剩余清单（按建议顺序）

1. **F296 alpha UAT**：`scripts/f296-alpha-uat.mjs` 两条 journey（compaction / replacement）。daemon log 中 0 次提及 = **尚未运行**。⚠️ 脚本默认 `--redis-url redis://127.0.0.1:6398` 是 F125 时代端口，当前 alpha redis 是 **6397**，必须显式传 `--redis-url redis://127.0.0.1:6397`。
2. **前端 3011 可达性复核**（浏览器或更长超时；确认是编译慢还是真不可达）。
3. **MCP 缺口处置**（§3，二选一，落结论）。
4. **两条 level-40 周期警告 disposition**（每 5 分钟一条）："1 PR subjects could not be verified; checkouts remain untouched" / "1 worktree expiry facts lack verified thread provenance"——疑同一 worktree subject，验收时确认影响或登记 provenance。
5. **whisper 口径复核**：`enabled=false` 但进程在跑，二者取其一改正。
6. **归档**：验收记录写 review-notes + 任务终态更新。

完成定义：§2 全绿保持 + UAT 两 journey PASS + §3/§4 每项有结论落档。

## 5. 边界与注意

- 铁律：不 kill daemon（要停用 `./scripts/alpha-worktree.sh stop`）；不改 runtime 配置；6399 为主实例 redis、3003/3004 为主实例端口，**勿动勿碰**。
- daemon token 经 `ps` 可见（start-dev.sh CLI 传参设计使然，本机 dev 边界内已知行为）。
- PR #63 是 merge-only 祖先修复，后续上游同步不可 squash/rebase（PR body 明确要求）。

[谱谱/glm-5.3🐾]
