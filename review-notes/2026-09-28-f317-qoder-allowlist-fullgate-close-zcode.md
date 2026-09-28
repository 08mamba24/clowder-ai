# F317 Qoder allowlist full gate — 证据汇编与 owner 关账决定

- Task: `0001790220533031-000102-410e5539`（F317 Qoder allowlist 修复：完成安全 full gate 并交回 PR 证据）
- Owner: zcode（谱谱）· 决定时间: 2026-09-28T14:1xZ
- 关联: AC1 终验 task `0001790229466052-000124-62483064`（仍 blocked，owner 砚砚6 路由不可达，待 operator 改派/签名——与本卡关账互不阻塞）

## 决定

**以现有证据关账，不再跑本地 full gate。** 理由：CI 已在修复 PR 的 head 树上全量跑过 public gate 并绿（下表 #1），同一棵树本地重跑不产生新信息（P1 面向终态，不绕路）。

## 证据汇编（多源，各带时间戳与取证人）

| # | 证据 | 结果 | 来源 / 时间 (UTC) |
|---|---|---|---|
| 1 | PR #51（head `9f8b12925`）checks | state **pass**：Test(Public)、Public test pure-1..4、serial、Public test evidence、Public contract surfaces、Directory Size Guard、Build、Public test plan、Lint 全 SUCCESS；serial bootstrap **designed skip**；Windows Smoke SUCCESS。严格计数 **13 pass + 1 designed skip**（#48/#49 同型） | 谱谱 受控 `github_read` pr_checks，14:02:15Z，sourceUrl `…/pull/51` |
| 2 | 合入身份 | squash 树 OID 与 PR head 树 OID 逐位相同（`a1b88d653…`），base 为 head 祖先——"合入=已审"密码学级成立；合入真值时间 **17:37:43Z** | 点点 宿主 gh，14:0xZ |
| 3 | 部署面 | `packages/{api,mcp-server,shared}/dist/.build-commit` + `packages/web/.next/.build-commit` 全 = `f2fe8be51`，API 进程加载 runtime dist（引用路径勘误：runtime 顶层无 `dist/`） | 点点，21:15–21:19 local mtime |
| 4 | 修复语义 live 双重复核 | 阴性 `issue_view #1524`（PR 号）→ `not_found`：MCP transport 腿（谱谱 14:06:38Z）+ 部署 dist 直打腿（点点 14:09:07.186Z）；阳性对照 `#1544` 真 issue → `ok:true`（14:09:09.527Z），证明门是甄别而非无差别拒绝。前提现取：zts `hasIssuesEnabled=true`（排除 `issues_disabled`）、宿主 `gh issue view 1524` 别名缺陷活着复现 | 谱谱 + 点点，互补覆盖 |
| 5 | 两仓两腿 AC1 | 谱谱腿 08m 5/5；银闪腿 08m+zts 16 项 + 负向 `scope_denied`，含 #51 两个新预期（`issues_disabled/retryable:false`；真 issue 返真数据），runtime `f2fe8be51` 行为 canary | 各自 thread 报告，13:4xZ |

## 残留（已声明，非阻塞）

- 旧 grant 取消后重放：需 hub 侧对已结束 invocation 主动回放，猫侧无构造工具。
- per-grant 并发上限 2：协议要求严格串行，未压测。
- Seatbelt 磁盘审计自证：沙箱拒读 runtime 目录 = 隔离生效，非缺陷。
- transcript 落盘：会话密封前不可自读，留 threadId 锚点复核。

## 结论

qoder 已知缺陷清单为空（双猫两仓 live 全绿 + CI 全量 gate 绿 + 合入/部署/语义三级独立复核）。本 task 实体完成，**owner 决定关账**；机械关账动作待带回调面的 zcode 会话或 operator 在 Hub 执行。

[谱谱/glm-5.3🐾]
