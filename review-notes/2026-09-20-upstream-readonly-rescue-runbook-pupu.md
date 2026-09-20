# upstream #1454 救援 runbook — 谱谱/glm-5.3

- **作者**: 谱谱/glm-5.3（operator 2026-09-20 01:33 UTC 授权"动手"）
- **对象**: zts212653/clowder-ai PR #1454（strict readonly boundary）按维护者三条整改门槛重建
- **状态**: ✅ **§三 全序列执行完毕**（点点/@dsh-v41-flash，2026-09-20）：双分支已推 fork（SHAs 逐位一致）→ issue **#1492** → PR B **#1493**（794/794 全绿）→ PR A **#1494**（801 tests / 800 pass，唯一红 = #1493 修的 coverage regex）→ #1454 已评论并 **close**。**当前等外部条件：维护者 review / 合并（B 先于 A，A 的 mcp-server CI 才会转绿）。** 执行回执与独立验证见 §十。历史：双 carrier 均复审 **APPROVED**（A `a71b70c0e` 原 P1 关闭见 `2026-09-20-upstream-readonly-carrier-a-approved-pupu.md`；B `486241a8` 见 `2026-09-20-upstream-readonly-carrier-b-approved-pupu.md`）；§三 原由 operator 2026-09-20 06:29 UTC 交接给点点。**→ 更新（2026-09-20T08:09:40Z）：#1494 formal CHANGES_REQUESTED（P1×2/P2×1），已派修 zcode，见 §十一**

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

## 十、执行回执（点点/@dsh-v41-flash，2026-09-20）

GitHub 外部序列已由 点点 在 gh 凭证（`08mamba24`，`repo` scope）下执行完毕：

| 步骤 | 结果 |
|---|---|
| ① push 双分支 | A `a71b70c0e…`、B `486241a8…`（`ls-remote` 逐位一致；未 force，未推 main） |
| ② issue | **#1492** `CAT_CAFE_READONLY unions agent-key write tools from ambient env…`（文案 = §四） |
| ③ PR B | **#1493** `test(mcp): escape literal parens in evidence coverage regex`（base `main`，1 文件 +1/−1） |
| ④ PR A | **#1494** `fix(mcp): make CAT_CAFE_READONLY strict — agent-key union requires explicit opt-in`（base `main`，14 文件 +407/−40，body 填 `#1492`/`#1493`） |
| ⑤ 关 #1454 | 评论已贴（`issuecomment-5748169324`）→ **CLOSED** |

**执行者独立验证（复跑，非转述 runbook）**——在 carrier 自己的 worktree / clean env（`env -u CAT_CAFE_*`）下：

- 分支 B @ `486241a8`：`evidence-tools.test.js` **31/31**；mcp-server 全量 **794 tests / 794 pass / 0 fail**；`biome format` 1 文件干净。
- 分支 A @ `a71b70c0e`：mcp-server 全量 **801 tests / 800 pass / 1 fail**，唯一红 = evidence coverage matrix 断言（即 B 修的 `(sacred)` 正则，红在断言而非测试名）；api 目标两文件（antigravity executor + mcp-config adapters）**68/68**；`biome format` 14 文件干净。
- 公开披露面检查：分支 A diff 中 `F317`/`qodercn` **零命中**（必须 `git grep` 对 tree-ish——对工作树查会因 main 内容误报，第一次就踩了这个坑，已用正确姿势复核）；`F061`/`F213` 是 upstream 既有惯例（base 已大量存在：F167 1043 处、F311 571 处），非新增泄漏；非 ASCII 文案与 `env-registry` base 既有中文惯例一致（base 419 行非 ASCII、`'(空)'` 10 处）。
- **环境陷阱（重要，留给下一位）**：在本 cat 的 ambient shell 里直接跑 mcp-server 全量会看到 **43 fail**；base 与 A **同为 43**（A 新增 7 个测试全过 ⇒ 零新增失败）。根因 = ambient `CAT_CAFE_*`（16 个，含 `CAT_CAFE_CREDENTIAL_FILE`/`CAT_CAFE_STRICT_PROFILE_DEFAULTS`）污染 callback/agent-key 类断言，**不是 carrier 缺陷**。复跑必须 clean env。

> PR A body 相对 §五 有一处**增补**（非改写）：P1 commit `a71b70c0e` 把 union opt-in 合成从「name-gated baseline」改为「managed provenance（`source === 'cat-cafe'`）+ final merged env」，§五 原 bullet 只说「确有凭证时」，故补第 4 条如实描述该 delta。

**剩余 = 纯外部条件**：维护者 review / 合并（B 先于 A）。issue #1492 由 PR A 的 `Fixes #1492` 在合并时自动关闭。

## 十一、#1494 formal review 回执 + 派修（点点/@dsh-v41-flash，2026-09-20 08:1x UTC）

**裁决：CHANGES_REQUESTED**（zts212653，`2026-09-20T08:09:40Z`；reviewed exact HEAD `d1f8d6b0b380184348b68d4997acc09134ee1219` @ base `6291ff0791edde280133320b08a3bfb3e755bd5c`；3 条 inline thread 全 `isResolved=false`，review body 自述 continuity 由 `git range-diff` 复核 `=`、patch 逐字节一致）。

方向 **WELCOME 未变**；custody 仍归 `08mamba24`（原文：*"retains fix custody. Please push the fixes and regression tests to this PR; I will review the resulting delta."*）。**#1493 明确不折进本 PR**（维护者称其为独立 lane）。

### 三条 finding（我已逐条核到源码，非转述）

| # | 级别 | 位置 | 事实 |
|---|---|---|---|
| 1 | P1 | `packages/api/.../antigravity/executors/McpToolExecutor.ts:145` | `buildMcpEnv` 只要 `SECRET/FILE/FILES` 任一非空即 `merged.CAT_CAFE_READONLY_AGENT_KEY_UNION='true'`，把显式 `false`、`''`、`'1'`、`'TRUE'` 一并覆盖 → 生产路径传 `process.env`，显式拒绝被抹掉。 |
| 2 | P1 | `packages/api/src/config/capabilities/mcp-config-adapters.ts:242` | 判据是「变量为非空字符串」而非「凭证可用」：`_FILES='{}'`、坏 JSON、仅空路径、指向不存在的 sidecar 都算有凭证（`'{}'` 时 resolver 拿不到任何 key，mount 却拿到 80 工具并集）。 |
| 3 | P2 | `packages/mcp-server/src/server-toolsets.ts:281-320` | memory/signal/limb/audio/finance 五族 `registerTools(server, buildXTools(env))` 缺第三参 → 默认重新 `parseToolsetEnv()` 读 `process.env`，parse-once/注入承诺不成立（`CAT_CAFE_MCP_PROFILE='invalid-ambient-profile'` + 注入 fixture 会在 memory 族抛 `Unknown CAT_CAFE_MCP_PROFILE`）。 |

**同类审视（补锅匠防线）**：同类「非空即视为有凭证」判据共 4+1 处 —— `server-toolsets.ts:57`（本 PR 要改的 server 判据）、`McpToolExecutor.ts:145`、`mcp-config-adapters.ts:242`，外加 `callback-tools.ts:1845-1850`（`hasAgentKeyCreds`，rich-block 路由用）。前四处必须同语义；第 5 处若判定不改需在 commit body 说明。
**语义基线（P4）**：`callback-tools.ts:149-193` 是唯一权威 —— `parseAgentKeyFileMap`（JSON 非数组对象；值须非空 trim 字符串；坏 JSON/空 → `{}`）+ `readAgentKeyFile`（同步读、trim；缺失/空 → 不可用）+ 优先级（`_FILES` 非空时不再回落 SECRET/单 FILE）。api 无 `@cat-cafe/mcp-server` 依赖、两边都依赖 `@cat-cafe/shared` → 纯判据应抽 shared 共用一份。

### 维护者复现口径（复审 delta 的对照基线）

strict ambient-secret mount = **34 tools**；显式合法 opt-in = **80**；executor 显式 `false` = **80（错，应 34）**；显式 opt-in + `CAT_CAFE_AGENT_KEY_FILES='{}'` = **80（错，应 34）**。另：`registerFullToolset(server, {readonly:true})` 在 ambient 非法 profile 下必须不抛。

### 本 PR 当前状态（gh 实查）

OPEN / non-draft，HEAD `d1f8d6b0b`，base = upstream `main@6291ff079`（= main tip，无 BEHIND），`MERGEABLE` / `mergeStateStatus=blocked`（缺 1 个非作者 approval，预期）。`strict_required_status_checks_policy=true` + `dismiss_stale_reviews_on_push=true` ⇒ 本轮修复的 push 不会冲掉任何既有 approval（当前 0 个）。

### 分工

- 修复：@zcode（谱谱）在 `/Users/yuhan/cat-cafe/clowder-ai-wt-upstream-readonly` 分支 A `d1f8d6b0b` 上**新增 commit**（不 amend / 不 force → 维护者要复审 delta）+ 回归测试。
- push / CI / PR 回帖：点点 的 gh 凭证（`08mamba24`，fork admin）；push 前由点点独立复跑上述四条复现口径。
- 毛线球：`0001789891992618-000203-7c3fd40f`（owner zcode）。
