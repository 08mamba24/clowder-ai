# collective-connector owner 默认值分歧修复（毛线球：误伤本地全量门禁）— 谱谱/glm-5.3

- 分支：`fix/collective-connector-owner-default`（worktree `clowder-ai-wt-pr33-r4`，base = `origin/main` `5f8897e1a`）
- commit：本 commit（note 随 fix 同 commit 进分支，循 PR #32 `0d026d417` 先例；**本地待 operator push**）
- 背景：PR #33 merge gate 首轮 1/23633 红，瞳瞳/dsh-vision 根因定位为 env artifact（毛线球 `0001789636161909-000022-299c2dfb`，owner zcode）

## 根因（瞳瞳诊断，我独立复核 + 复现）

`DEFAULT_OWNER_USER_ID` 未设时，同一 owner 概念有两个默认值 + 两种检测语义：

| 处 | 表达式 | 求值时机 | 裸 env 值 |
|---|---|---|---|
| `plugin-official-routes.fixture.js:99`（session 头） | `env ?? 'owner-user'` | 模块加载时 | `owner-user` |
| `collective-connector-routes.test.js:27`（thread createdBy / callback userId） | `env?.trim() \|\| 'owner_1'` | harness 调用时 | `owner_1` |

route 判 `thread.createdBy !== sessionUser` → 裸 env 必 422。CI 靠 `ci.yml:145` 的 `DEFAULT_OWNER_USER_ID=default-user` 一直遮着；分歧自 sync commit `9f6ac2069` 起就在 main 上。

## 实际关闭面（dsh 复审实测：4 类分歧，不止 1 类）

| env（import 前设定） | pre-fix | post-fix |
|---|---|---|
| unset / `''` / `'   '` / `' owner '` | **DIVERGE ×4** | AGREE |
| `default-user` / `owner_1` / `alice` | AGREE | AGREE |

`??` → `?.trim() ||` 顺带把空串、纯空白、带空格三类也收敛了。

## 我的红→绿证据（macOS 本地，base 5f8897e1a）

- **红（修前）**：裸 env 单文件 `collective-connector-routes.test.js` → **8 pass / 1 fail**，失败用例与门禁红逐字一致（`persists an owner-only Host route…`，422 ROUTE_THREAD_UNAVAILABLE）
- **绿（修后）**：裸 env **9/9**；CI parity（`DEFAULT_OWNER_USER_ID=default-user`）**9/9**；显式 `owner_1` **9/9**（dsh 复跑同绿）
- **回归**：fixture 四个消费方 **28/28**（裸 env 与 CI parity 双模式，dsh 独立复跑同果）；biome 0 error；`git diff --check` 干净

## 修法（P4 单一真相）

新 helper `packages/api/test/helpers/default-owner-user-id.js`：`resolveDefaultOwnerUserId() = env?.trim() || 'owner-user'`。两处调用点全部换用。

- canonical literal 取 `'owner-user'`：fixture 消费方全部是变量对变量的等价性比较，字面量选择对它们零扰动（dsh 追认调用链：route 侧 `collective-connector-routes.ts:203` 用会话派生 `access.operator`，与生产 `cat-config-loader.ts:934` 的 `'default-user'` 无关）
- **残留时序面（记录，不改）**：helper 统一了字面量与检测语义，未统一求值时机——fixture 头仍模块加载时冻结、harness 侧调用时读。import 后改 env 两侧仍会分歧（dsh 实测）。今天不可达：本文件唯一改 env 的 417 行用例走自带 header，另外 4 个消费方 0 处改 env。不变量已写进 helper docstring；**不**改为 lazy getter（爆炸半径大于原 bug，dsh 立场，我同意）。

## 勘误（本 note 初版，dsh P3-1 指出）

- 初版写「现网无空白设值（grep 证实只有 'default-user'/'owner_1'/'configured-owner'）」——**错**：我只 grep 了非空字面量，漏了空白/空串赋值。实际有 3 处：`callback-auth-hide-similar-route.test.js:77`（`''`）、`owner-gate-single-user.test.js:51/:102`（`'   '`）。结论不受影响（这 3 处都不是 fixture 消费方、不 import 本 helper 面），但 durable 证据里的错误 grep 结论已在此更正。

## 范围边界（明确不动，dsh 独立验证 0 处 env 引用）

- `collective-agent-verifier.test.js` / `collective-ingress-dispatcher.test.js` 的 `'owner_1'` 是**同文件自洽**夹具（两侧同源、不读 env），无分歧面，不属本修复
- 过程教训：helper 初版把 TS 返回类型注解写进 `.js`（SyntaxError，双模式 1/1 红）——低级错，当轮抓住修正；此为自留记录，不影响产物

## review 记录

- dsh-v41-flash（点点）跨族 review：**APPROVE**（红→绿独立复现：pre-fix 基线树 `78fff4c3d` 8/9 → post-fix 三 env 形态 9/9；分歧矩阵直接 import 真实模块实测；范围边界独立验证）
- review 产出：P2（note 未随分支，本 amend 已修——即本文件随 commit 进分支）+ P3-1（grep 论据勘误，见上节）+ P3-2（时序不变量进 docstring，已加）

## 下一棒

- operator：`git push origin fix/collective-connector-owner-default` → PR → merge gate

## 收档（2026-09-17 10:11Z）

- 点点代推并作为非作者 merge owner 完成 merge gate：**PR #35 MERGED**（squash `f04205eec`，CI 13/13，E1–E5 独立复跑全过，合入后另起临时 worktree 复跑裸 env 9/9 证明 main 树真绿——注意这是他补建 dist 后的第二次结果，首跑因缺 dist 报 1 fail，他已自行更正）。毛线球 `0001789634270458-000019-b0e76bf8` 判 done，验收证据 = PR #35 evidence manifest。
- 同日 runtime 重启验收（PR #33 载入）：live health 自报 `deploymentRevision=5f8897e1a`；受控链四项资产就绪（wrapper 可执行非 symlink / memory dist / guarded gh / sandbox-exec）——E2E 验收探针待 Slice 3（cat-template 条目）解锁。

## 补遗：锚定勘误（应点点审计 C7，2026-09-17 10:20Z）

- **review 记录补 SHA 锚**：上文「review 记录」节的 APPROVE 绑定 **`reviewedHeadSha=f388847df`**（`fix/collective-connector-owner-default` 分支），其后作者 amend `2c2b02704` 经 C1 连续性桥接（非注释代码行 delta = 0）覆盖同一 verdict；最终合入 SHA `f04205eec`（main）。原 note 正文缺此锚，已在 PR 评论 manifest 侧由 reviewer 补齐，本节补齐 note 侧。
- **SHA 归属标注**（沿用 reviewer 的 `<branch>@<sha>` 约定）：`f388847df` / `2c2b02704` ∈ `fix/collective-connector-owner-default`；`78fff4c3d` ∈ `check/pr33-merge-main`（集成检查分支，不在 main——「pre-fix 基线树」指其树内容为修复前状态，引用有效）；`f04205eec` ∈ main。
- 上文第 4 行「本地待 operator push」与「下一棒：operator push」两处叙述已被本收档节取代（实际由 reviewer 代推）。
- 作者侧采纳同一规则：今后我写的 review note，verdict 必带 `reviewedHeadSha`，跨树引用必标 `<branch>@<sha>`。

`[谱谱/glm-5.3🐾]`
