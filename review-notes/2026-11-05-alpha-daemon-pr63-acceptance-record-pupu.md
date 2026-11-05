# PR #63 Alpha 验收记录——部署链 PASS，UAT 卡 canary（谱谱）

日期：2026-11-05　thread：`thread_mvhqzo9b2l03e98g`
对象：[PR #63](https://github.com/08mamba24/clowder-ai/pull/63)（merge-only 上游同步 + 祖先修复，merge commit `ad0c52d20`）在 alpha 通道的实测验收。
前置：`2026-11-05-alpha-daemon-pr63-acceptance-handoff-pupu.md`（现场登记）。本文记录实测结果。

## 0. 结论

**部署链路验收 PASS；UAT 主体 BLOCKED 在 canary 门，两条 journey（compaction / replacement）未执行。**
`node scripts/f296-alpha-uat.mjs --api-url http://127.0.0.1:3012 --redis-url redis://127.0.0.1:6397` →
`{"schemaVersion":2,"outcome":"failed","reason":"canary_not_found"}`

## 1. PASS 项（全部当场实测）

| 项 | 结果 | 证据 |
|---|---|---|
| 合并树构建 | shared / api / mcp-server dist + **web 生产构建**（exit 0）全过，四枚 `.build-commit` 戳一致 = `ad0c52d20` | `packages/*/dist/.build-commit`、`packages/web/.next/.build-commit` |
| 规范部署态 | `--prod-web --quick` 启动，3011/3012/4111 + redis 6397（alpha 数据目录，数据自昨晚 dump 连续，dbsize 25） | lsof、redis-cli |
| API 身份 | `/health` → `deploymentRevision: ad0c52d2009b…`（UAT 的 `wrong_revision` 门已过：= origin/main） | curl 3012 |
| 就绪 | `/ready` → `status: ready`（redis/sqlite/sessionHooks 全 ok） | curl 3012 |
| 前端 | 3011 = HTTP 200（next start 生产模式，bundle 内烘入 `127.0.0.1:3012`，无 3004 泄漏） | curl、rg .next/static |
| UAT 前置门 | canonical contract ✓ / alpha coordinates (3012+6397) ✓ / session ✓ / revision ✓ / readiness ✓ | 走到 canary 才失败，即此前全过 |

## 2. BLOCKED：canary_not_found（UAT 主体验收未完成）

- 根因：`scripts/lib/f296-alpha-uat-contract.mjs:100-102` 硬校验 canary 猫 `clientId==='openai' && carrier==='app_server'`（默认 `--cat-id codex`）。
- 事实：alpha 当前 roster 9 只（opus/sonnet/opus-45/fable-5=anthropic·cli，glm52=opencode·cli，grok-build/dsh/zcode=acp，qoder=qoder·cli），**无一只 openai/app_server**；主 runtime catalog 亦无该组合。F296 时代（2026-08 关闭）的 codex canary 已不在当前家庭 roster——**harness 期望与 roster 漂移**，非 PR #63 回归。
- 影响面：journeys 未跑；F296 的 compaction/replacement 两条链路在本合并树上未获 UAT 级验证（该功能本身 2026-08-31 已 production loaded，PR #63 对其无代码改动）。

## 3. 发现清单

| 级别 | 发现 | 锚点 |
|---|---|---|
| **P2** | legacy `alpha-worktree.sh start` 路径 redis 坐标漂移：14:39 一次启动落在本机 6398 + `$CAT_CAFE_RUNTIME_ROOT`（zcode app-server）名下数据目录，而非契约 6397 + alpha 目录；`start-dev.sh --quick` 重现。手工先起 6397（alpha 数据目录）后启动可稳定复现正确坐标 | `scripts/lib/alpha-redis-identity.sh:54`（legacy fallback 位）、`f296-alpha-uat-contract.mjs:8`（契约口） |
| **P2** | F296 UAT canary 断言与当前 roster 不兼容（见 §2） | `f296-alpha-uat-contract.mjs:100-102` |
| P3 | MCP 4 项 alpha 特有缺口：`zai-mcp-server/zread/web-search-prime/web-reader` 不在 alpha capabilities.json（主 runtime 四项全有）；重启不自愈，凭证 00:09-00:12 供给晚于解析。UAT 不依赖（canary 只查猫），不阻塞本次 | daemon log `acp-mcp-resolver` level-50 |
| P3 | SOP 端口文档漂移：`docs/SOP.md:57` 写 6398，实际 alpha 契约口 6397 | `f296-alpha-uat-contract.mjs:8`、`alpha-worktree.sh` usage |
| P3 | level-40 周期警告（跨启动累计）：worktree expiry 缺 thread 溯源 112x、PR subjects 无法验证 97x、origin mismatch 97x、connector-media 路径 4x——维护项，非 #63 回归 | daemon log |
| 已解 | whisper 口径：当前 `enabled=false` 且无进程，自洽；昨晚"进程在跑"为崩溃残留 | `.cat-cafe/services.json`、ps |

## 4. 现场留存

- alpha 栈保持 prod-web 运行中（3011/3012/4111 + 6397，token 同 handoff），canary 决定后可直接续跑 UAT。
- 本机 git：clowder-ai 本地 main ahead 6+1（本记录），push 仍缺凭证。

## 5. 下一步（二选一，需铲屎官拍板）

- **A（建议）**：给 alpha 补一个 openai/app_server 的 canary 测试猫（测试夹具，配置动作）→ 谱谱重跑 UAT 把两条 journey 跑完，本次验收闭环。
- **B**：改 harness（canary 断言参数化/对齐当前 roster）走 PR + 跨猫 review——长期正确，但另立一条线，本次验收以"部署链 PASS + UAT canary 受阻如实归档"收口。

[谱谱/glm-5.3🐾]
