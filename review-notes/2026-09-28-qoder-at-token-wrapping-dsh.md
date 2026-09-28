# qoder `@句柄` 脱敏实现（反引号包裹）+ 触发形态复算修正（点点/dsh-v41-flash, F317 hotfix）

**接**：`2026-09-28-qoder-at-token-file-expansion-dsh.md`（注入点定位）+ 谱谱 Packet v3.3 决策 1（实现归我、他跨族复核）。
**本轮交付**：`at-token-neutralization.ts` + `QoderAgentService.invoke()` 接线 + 13 条测试；**并复算修正了上一轮的两处措辞**。

## 0. 一句话

qodercn 会把 stdin prompt 里的 `@token` 当文件引用替换成仓库路径。修法 = **出境前把每个裸 `@句柄` 包成反引号形态**（`@zcode` → `` `@zcode` ``），使 token 后一个字符是反引号；自然数据里这个形态 **358/358 幸存、0 处被替换**。

## 1. 我独立复算的证据（口径：CLI 自己存的 prompt 副本，只读）

复跑：`python3 review-notes/2026-09-28-qoder-at-token-scan-dsh.py`（本轮实测）：

```
qoder user prompts (L0 copies) : 103
affected (contains path-like @token): 69      # 67%
first affected : 2026-09-15T16:09:47.032Z
last  affected : 2026-09-28T14:54:43.894Z
distinct tokens: 20
@packages/web/public/avatars/opus-45.png : 30  ← 全样本唯一图片
```

### 1.1 触发形态：后一个字符决定命运（本轮新做的定量口径）

- **469 处**被替换的 token，替换后紧跟的字符分布：`空格 385 / 换行 42 / ')' 42`；**0 处是反引号**。
- 替换时 CLI 会在替换文本前**插一个前导空格**（``` `@opus` ``` → ``` ` @packages/...png` ```），所以 469 处的**前一个字符全部是空格**。
- **358 处**"后一个字符是反引号"的句柄 occurrence：**358 幸存 / 0 被替换**（口径：把替换站点偏移与 token 偏移对齐后逐处判定，避免"同一段落里有别的替换"造成误判）。
- **同一 prompt 内的天然 A/B 共 30 处**：C1 段里 `` `@opus 请确认这个安排` ``（token 后跟空格）被替换成头像路径，而**同一行/同一段**的 `` （如 `@opus`） ``（token 后跟反引号）原样幸存。例：`05137e3b:3`（2026-09-22）。

### 1.2 两处措辞修正（都在我上一轮的 note 里）

1. **触发集比"空格"宽**：`)` 也会触发（42 处，形如 `(@zcode)` → `( @.git/refs/...)`）；而 `：`/`（`/`，`/`。`/`` ` `` 五类后跟字符在本样本里**从未**触发（0/866）。所以"后跟空白才改写"是**推断过窄**，我不再复用它当实现依据。
2. **"`` `@opus 请确认这个安排` `` 被改写"要精确到 token 粒度**：被改写的是"token 后跟空格"的那一处；同一 prompt 里"token 后跟反引号"的同类实例**没被改写**。上一轮 note §3 把两种形态写在一起，容易读成"反引号形态也会被改写"。

另外记录一个 CLI 的附带行为：反引号后的 token 会被**插入前导空格**（``` `@opus` ``` → ``` ` @opus` ```）——代码跨度被破坏，但 **token 文本完好、不触发替换**（这正是 §1.1 那 358 处）。

**诚实标注**：358/0 与 30 处同 prompt A/B 是**相关性证据**，不是 CLI 内部机制证明——同一份语料里"后跟空格"的 token 有 419 处**没有**被替换，说明还存在一个未知的第二条件（对本次修复是安全余量，不是风险）。全量机制仍要真腿才能钉死。

## 2. 实现

| 文件 | 改动 |
|---|---|
| `packages/api/src/.../providers/at-token-neutralization.ts` | 新增纯函数 `neutralizeAtTokensForFileExpansion(text)` |
| `packages/api/src/.../providers/QoderAgentService.ts` | `invoke()` 顶部生成 `deliveredPrompt`，**三处同源**：recorder 落档 body / 变异校验 / `stdinInput` |
| `packages/api/test/qoder-at-token-neutralization.test.js` | 新增 6 条（形态/边界/幂等/真实 L0 源不残留可解析形态） |
| `packages/api/test/qoder-agent-service.test.js` | 新增 1 条 carrier 级：stdin 出境字节 × recorder 冻结字节同源 |

**为什么接在 carrier 边界（`QoderAgentService.invoke`）而不是 L0 生成处**：

- L0 是**共享**模板（dsh 侧 L0 已证实干净），"把 `@` 当文件引用"是**载体属性**，不是 L0 属性；
- `invoke()` 是 qoder 的**唯一出境口**（`stdinInput`，argv 不带正文），接在这里天然满足"落档字节 = 出境字节"，且覆盖 compose 站点之外的所有调用方；
- 新增带同类行为的载体时，调同一个函数即可（不改共享路径）。

**形态与口径决定**：

- 形态 = 反引号包裹（§1.1 证据），已包裹形态幂等；
- **不碰**：真文件引用 `@packages/api/src/x.ts`（后接 `/` 或 `.`）、邮箱 `foo@bar.com`（`@` 前是词字符）、路径片段里的 `@`（如 `node@24/bin`）；
- **广口径**：不只包"证据里被替换过的形态"（空格/换行/`)`），连 `@队友:` 这类未观察到被替换的形态也一并包——**不赌触发字符集的外推**。代价是提示里反引号形态更多，而"模仿风险"正是留给真腿的那半边。

## 3. 验证（本机实跑）

```
cd packages/api && npx tsc                      # 构建通过（exit 0）
bash ./scripts/with-test-home.sh node --import $(pwd)/test/helpers/setup-cat-registry.js \
  --test test/qoder-at-token-neutralization.test.js      # 6 pass / 0 fail
bash ./scripts/with-test-home.sh node --import $(pwd)/test/helpers/setup-cat-registry.js \
  --test --test-concurrency=2 test/qoder-agent-service.test.js   # 见 §5 结果
```

关键断言的"红"是可判定的：carrier 级用例同时断言 `bytes !== raw` 且 `raw` 含裸形态——脱敏不生效时该用例必红。

## 4. 未验证 / 残留（不包装成已规划）

1. **真腿模仿半边**：L0 示例全部反引号化后，qoder 猫的路由输出是否仍是**行首半角 `@`**——本轮没跑 CLI，未验证。这是谱谱 Packet v3.3 里点名的后半，需要一条真腿（或在下一批 L0 副本里看输出行为）。
2. **10–12s 上传前静默**仍未归因（上一轮标为假设：CLI 文件检索）；本轮不动它。
3. **全量套件未跑**：只跑了 qoder 两个文件；`pnpm gate` 未跑（本机 github 连不通、耗时）。

## 5. 提交与推送（已落远端，非"本地未上"）

| 项 | 值 |
|---|---|
| commit | `3f9e853f8` fix(f317): qoder 出境 prompt 的 @句柄脱敏（反引号包裹） |
| branch | `fix/f317-qoder-at-token-neutralization` → `origin`（08mamba24/clowder-ai） |
| PR | **#53** https://github.com/08mamba24/clowder-ai/pull/53 |
| base | `main`（origin/main = 205d216e5，本分支领先 1 个 commit） |
| merge | squash **`2460b7c00`**（2026-09-28T18:12:17Z，by 08mamba24）。CI 于复核 SHA `0e939ba4b` 13 绿 + 1 条件跳过（`Public test (serial bootstrap)`）；跨族 APPROVE（谱谱）覆盖同一代码面——`0e939ba4b` 只加 1 条 review-notes，代码面 4 文件 / 201+ / 3- 与复核时逐项一致 |

**生效路径**（重要，别误判）：live runtime 跑在 `/Users/yuhan/cat-cafe/cat-cafe-runtime/`，**不是本 worktree**——本 PR 合并/sync 进 runtime 之后才对真实 qoder 腿生效。本 worktree 里 `npx tsc` 只影响本机的 dist 与测试。

### 5.1 Activation truth（合并后亲验；勿误判）

`main = landed:2460b7c00` ； `live = dormant`

| 检查项 | 实测（2026-09-28T18:1xZ） |
|---|---|
| runtime worktree | `/Users/yuhan/cat-cafe/cat-cafe-runtime`，branch `runtime/main-sync` @ `f2fe8be51`，**落后 main 13 个 commit**（#52、#53 均未进） |
| 脱敏文件 | `providers/at-token-neutralization.ts` 在该 worktree **不存在** |
| 接线 | `QoderAgentService.ts` 无 `deliveredPrompt` / `neutraliz*` 命中 |
| 远端 runtime 分支 | `origin/runtime/main-sync` = `49fec0472`，与 main **无祖先关系**（分叉，非 ff） |
| 重启契约 | ADR-039 被动冻结：**只在显式 `pnpm start` 时 sync + rebuild**，无 watch 自动重载；重启另需 `CAT_CAFE_RUNTIME_RESTART_OK=1` |
| 授权 | 部署需 **operator 显式授权**（同 #52 先例）；`packages/api` 运行时进程当前**活着**，但跑的仍是旧代码 |

**→ 推论（给真腿验证的人）**：部署前跑真腿，`@opus` 仍会被改写成头像路径、仍会重传 1.38MB——这是**假阴性**，不可归因于修复失效。真腿（含 `opus-45.png` 重传字节测量）的前置条件是**先部署**。

签名：[点点/deepseek-flash🐾]
