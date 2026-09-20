# upstream #1454 救援 runbook — 谱谱/glm-5.3

- **作者**: 谱谱/glm-5.3（operator 2026-09-20 01:33 UTC 授权"动手"）
- **对象**: zts212653/clowder-ai PR #1454（strict readonly boundary）按维护者三条整改门槛重建
- **状态**: 分支 B 已获跨族 review **APPROVED**（2026-09-20，无 P1/P2/P3，见 `2026-09-20-upstream-readonly-carrier-b-approved-pupu.md`）→ operator 执行 §三①B + ③（PR B body 用该 note 的 paste-ready 版）；分支 A 有 P1 阻塞，等 reviewer 重发详情后修复再走 ②④⑤

## 一、产出（本地，共享 .git）

| 分支 | SHA | 基座 | 内容 |
|---|---|---|---|
| `fix/mcp-strict-readonly-union` | `c55345aff` | `upstream/main@9ab0eaf28` | 单 commit，14 文件 +267/−35：strict-readonly 修复 + 测试，已去 F317 anchor、已含 3 处 formatter 修复 |
| `fix/mcp-evidence-coverage-regex` | `486241a87` | `upstream/main@9ab0eaf28` | 单 commit，1 文件 1 行：evidence coverage 正则转义（既有测试 bug，独立 carrier） |

两条分支相互独立（B 不含于 A），均不在 main 上。worktree：`/Users/yuhan/cat-cafe/clowder-ai-wt-upstream-readonly`（当前 checkout 分支 A）。

## 二、验证证据（Node 24.18.0，2026-09-20）

1. **干净 upstream 基线红**（`9ab0eaf28`）：`evidence-tools.test.js` 单文件 30/31，唯一失败 = `(sacred)` 未转义正则；node 一行证明：buggy regex `false` / escaped regex `true`（`/tmp/regex-proof.mjs`）。
2. **分支 A**：mcp-server 全量 801 tests / 800 pass / 1 fail（唯一红即上述基线 bug，非本分支引入）；api 目标两文件（antigravity executor + mcp-config adapters）64/64；`biome format` 14 文件全清（原 3 处 formatter 错误已修入 commit）。
3. **分支 B**：单文件 31/31；mcp-server 全量 794/794 全绿；biome 清。
4. 嫁接适配：`agentKeyUnion` 双条件落在 `ToolsetEnv` 新结构、participation/desktopMode 优先级分支之后；`registerFullToolset` 单次解析 env 贯穿各族。

## 三、operator 执行步骤（顺序敏感：③ 依赖 ② 拿到 issue 号；B 建议先于 A 合并）

```bash
# 1. 推两条分支（在 /Users/yuhan/cat-cafe/clowder-ai）
git push origin fix/mcp-strict-readonly-union
git push origin fix/mcp-evidence-coverage-regex
```

2. **开 issue**（zts212653/clowder-ai，文案见 §四）→ 记下 issue 号 `#N`。
3. **开 PR B**：https://github.com/zts212653/clowder-ai/compare/main...08mamba24:clowder-ai:fix/mcp-evidence-coverage-regex ，body 见 §六。
4. **开 PR A**：https://github.com/zts212653/clowder-ai/compare/main...08mamba24:clowder-ai:fix/mcp-strict-readonly-union ，body 见 §五（把 `#N` / PR-B 号填进去）。
5. **关 #1454**：评论文案见 §七，然后 close。

## 四、issue 文案

**Title**: `CAT_CAFE_READONLY unions agent-key write tools from ambient env — strict readonly should not widen from inheritance`

**Body**:

> ### Observed exposure
> On current main, `CAT_CAFE_READONLY=true` plus ambient `CAT_CAFE_AGENT_KEY_SECRET/FILE/FILES` inherited from the parent environment makes `tools/list` return 66 tools (39 write operations, including `cross_post_message`, `teleport`, `register_scheduled_task`) instead of the 27-tool readonly allowlist. Any third-party read-only mount (MCP client, CI, inherited shell) that accidentally inherits agent-key vars silently gains that write surface. The union itself is intentional for agent-key collaboration (V3 codex APPROVE contract); the exposure is the *incidental* widening from environment inheritance.
>
> ### Expected strict-readonly behavior
> `CAT_CAFE_READONLY=true` → exactly `READONLY_ALLOWED_TOOLS`. The readonly+agent-key union applies only when the launcher explicitly opts in via `CAT_CAFE_READONLY_AGENT_KEY_UNION=true` **and** agent-key credentials are present.
>
> ### Affected consumers
> - Anyone mounting the MCP server readonly in an environment where `CAT_CAFE_AGENT_KEY_*` is ambient.
> - Intentional union users: the antigravity executor and the antigravity desktop baseline (in-repo producers).
>
> ### Compatibility expectation for intentional agent-key union users
> The two in-repo intentional consumers keep behavior unchanged — they set the opt-in automatically when they actually hand agent-key credentials to the mount. External launchers that deliberately relied on the implicit union must set `CAT_CAFE_READONLY_AGENT_KEY_UNION=true` explicitly. The default flips from "union on ambient creds" to "strict readonly"; this is the intended hardening.

## 五、PR A body（fix/mcp-strict-readonly-union）

> Fixes #N
>
> ## What
>
> `CAT_CAFE_READONLY=true` becomes strictly read-only: the toolset no longer unions `AGENT_KEY_TOOLS` into the readonly allowlist just because ambient `CAT_CAFE_AGENT_KEY_*` variables are present. The union now requires an explicit opt-in (`CAT_CAFE_READONLY_AGENT_KEY_UNION=true`) **and** agent-key credentials.
>
> ## Why
>
> Observed on current main: a readonly mount whose parent environment carries `CAT_CAFE_AGENT_KEY_*` exposes 66 tools (39 writes) instead of the 27 readonly allowlist entries. The union is by design for intentional agent-key collaboration (V3 codex APPROVE), but any third-party read-only mount inheriting those env vars silently gains the same write surface — a defense-in-depth violation. Details in #N.
>
> ## Fix
>
> - `server-toolsets.ts` / `canonical-tool-registry.ts`: the union requires `agentKeyUnion && hasAgentKey` (double condition); `parseToolsetEnv` recognizes the new switch; precedence unchanged (desktopMode/participation still highest).
> - `registerFullToolset` parses env once and threads an injectable `ToolsetEnv` through every family (no `process.env` races; tests inject fixtures).
> - The two intentional union consumers keep behavior: antigravity `McpToolExecutor.buildMcpEnv` and the antigravity desktop baseline set the opt-in only when agent-key credentials are actually handed to the mount.
> - `env-registry` documents `CAT_CAFE_READONLY_AGENT_KEY_UNION`.
>
> Carrier scope: exactly the strict-readonly change and its tests, rebuilt cleanly on current main per the review request in #1454. The pre-existing `evidence-tools` coverage-regex failure on main is fixed separately in #PR-B — landing that first turns this PR's mcp-server CI green.
>
> ## Verified
>
> - mcp-server suite on this branch: 801 tests / 800 pass — the single remaining failure is the pre-existing coverage-regex bug on main (companion PR fixes it).
> - api targeted suites (antigravity executor + mcp-config adapters): 64/64.
> - `biome format` clean on all 14 changed files (the formatter errors from the earlier review round are fixed in this carrier).
> - Rebased onto the #1465 refactor: `agentKeyUnion` slots into the existing `ToolsetEnv`; the double condition lands after the participation/desktop-mode precedence branches.

## 六、PR B body（fix/mcp-evidence-coverage-regex）

> ## What
>
> One-line fix: escape the literal parentheses in the evidence coverage assertion regex.
>
> ## Why
>
> `/^\[matchType:direct\] Redis production Redis (sacred)$/m` treats `(sacred)` as a capture group, so it can never match the literal `(sacred)` in the rendered output — `evidence-tools.test.js` fails deterministically on current main (verified in isolation on a clean checkout: single file 30/31, only this assertion red; the regex mismatch is env-independent). Escaping makes the test assert its clear intent and the mcp-server suite goes green on main.
>
> Split out of #1454 per its review thread: unrelated pre-existing test bug, own carrier. Recommend landing before #PR-A so its CI is green.
>
> ## Verified
>
> - Single file 31/31; full mcp-server suite on this branch 794/794; `biome format` clean.

## 七、#1454 关闭评论

> Superseded by #PR-A (the same strict-readonly fix, rebuilt as a clean single-purpose carrier on current main per this PR's review thread) and #PR-B (the split-out pre-existing regex test fix). The exposure report now lives in issue #N. Closing this PR; implementation custody remains with 08mamba24.

## 八、跨族 review 请缅因猫核对（P1 清单）

1. 分支 A 语义嫁接：`applyReadonlyFilter` 与 `projectCanonicalToolRegistry` 双条件位置是否在 participation/desktopMode 之后、`!readonly` 早退之前无误（`server-toolsets.ts:75-101`、`canonical-tool-registry.ts:62-91`）。
2. 两个合法并集消费者是否只在确有凭证时置 opt-in（`McpToolExecutor.ts` buildMcpEnv、`mcp-config-adapters.ts` buildAntigravityCatCafeEnvBaseline）。
3. 既有测试语义平移是否等价（schedule-tools / skill-consumption 补 `agentKeyUnion: true` 只是显式化原并集断言）。
4. 去 F317 化是否彻底：`git grep -n "F317\|qodercn" $(git diff --name-only 9ab0eaf28..fix/mcp-strict-readonly-union)` 应为空。
5. commit message 无 F317/内部代号；PR body 无内部信息泄漏。

## 九、背景索引

- 维护者整改意见：PR #1454 评论（zts212653，2026-09-13T12:52:44Z）——issue-first / 去 F317 anchor / 干净分支 + 拆分 carriers。
- 原 PR body 与 scoped review 历史：#1454 评论区（08mamba24 scoped review CHANGES_REQUESTED → 79eda8e16 APPROVED）。
- upstream 侧漏洞仍在：`upstream/main@9ab0eaf28` `server-toolsets.ts` 仍是 `readonly ∪ (hasAgentKey ? AGENT_KEY : ∅)`。
