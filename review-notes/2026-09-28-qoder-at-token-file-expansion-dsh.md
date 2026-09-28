# qoder 图片通路的注入点定位：CLI 把自己的 prompt 里的 `@token` 模糊解析成了文件路径（点点/dsh-v41-flash, F317）

**触发**：`2026-09-28-qoder-image-path-scoping-dsh.md` §5 留下的未定项——"谁把头像放进这次调用"。上一轮只做到排除法（不是 argv / 不是 harness 的 imagePaths 通道 / 不在 CLI 日志文本里），剩余两候选：CLI 会话附件重放 vs prompt 文本图片引用。

**结论：候选 2 命中，且比"图片引用"更糟**——qoder CLI 会把注入 prompt 里**所有** `@token` 当成文件引用来解析，命中后**就地改写成仓库内某个匹配文件路径**。`@opus` 命中的是装饰头像 `packages/web/public/avatars/opus-45.png` → 该腿多出一张 image 附件 → 每 spawn 重传 1.38MB。

复跑脚本：`review-notes/2026-09-28-qoder-at-token-scan-dsh.py`（只读，口径见下）。

## 0. 一句话

不是"谁把图塞进了调用"，而是 **CLI 把 prompt 里的 `@opus` 解析成了头像文件**。同时它还顺手把 L0 里的 `@author` / `@reviewer` / `@co-creator` / `@zcode` / `@gpt-pro` 全改写成文件路径——**猫读到的队友句柄是错的**。

## 1. 分母与覆盖（先定分母）

扫 `.cat-cafe/qoder-profiles/*/projects/*.jsonl` 的 `type=="user"` 记录（= CLI 自己存的 prompt 副本），排除 `logs/` 段：

- qoder L0 prompt **103** 条；含"路径形态 @token"的 **69** 条（67%）
- 首次 **2026-09-15T16:09:47Z**，最近 **2026-09-28T14:54:43Z（今天）** —— **仍在活跃发生**
- 每条受影响 prompt 命中 1–25 个 token（去重 8–10 个）
- 全样本去重后 **20** 个不同 token，**其中只有 1 个是图片**

## 2. 铁证：token → 仓库路径的逐条对应

| prompt 原文（harness 侧真实字符） | CLI 改写后 |
|---|---|
| `@zcode` | `@.git/refs/heads/backup/zcode-acp-d51b3846` |
| `@author` | `@node_modules/.pnpm/@modelcontextprotocol+sdk@…/dist/cjs/server/auth/handlers/authorize.js` |
| `@reviewer` | `@packages/api/src/domains/cats/services/collaboration/reviewer-matcher.ts` |
| `@co-creator` | `@packages/web/src/components/__tests__/hub-co-creator-editor.test.tsx` |
| `@gpt-pro` | `@packages/api/src/domains/cats/services/agents/agent-key/gpt-pro-agent-key-sidecar.ts` |
| `@astra` | `@tmp/net-mode-review-v4-20260923/test/astra-repros-v2.zsh` |
| `@句柄`（L3 路由规则例） | `@packages/api/src/domains/cats/services/agents/routing/multi-mention-state-machine.ts` |
| **`@opus`** | **`@packages/web/public/avatars/opus-45.png`** ← 唯一的图片 |

出现频次最高的 6 个 token 各命中 44–45 条 prompt（即 L0 固定段），`@opus` → 头像命中 **30** 条。

**未命中就原样保留**：`@dsh-vision` / `@dsh-v41-flash` / `@猫名` / `@ 队友`（带空格）都没被改写——匹配是"能找到才换"。

## 3. 为什么判定是 CLI 干的，不是 harness

1. 改写后的文本**存在 CLI 自己的 session 记录里**（`type=="user"` + `humanInput.text`），harness 侧没有这条写回路径；qoder 适配器是 `stdinInput: prompt` 纯文本直传（`QoderAgentService.ts:1058`，上一轮已核）。
2. **harness 全文没有这种映射**：`assets/prompt-templates/`、`packages/api/dist/` 里都不含 `opus-45.png` 字面量；`@author` → `authorize.js` 这种**模糊匹配**在 harness 里没有任何对应实现。
3. **同一条模板在别的猫那里是干净的**：本猫（dsh）收到的 L0 是 `1. 另一只猫能做 → @句柄` / `review 完 → @author`，句柄原样。同一份模板只有 qoder 侧被改写。
4. **触发边界（本样本内逐条一致，仍标为推断）**：单条 prompt 内 69 个 `@token` 中 20 个被换成路径、49 个幸存，判别条件是"**`@token` 后紧跟空白（空格/换行）**"——
   - 被换：名册单元格 `|@zcode · glm-5.3|`（后跟空格）、决策树 `→ @author / 修完`（后跟空格）、`[正确] @zcode` + 换行、`` `@opus 请确认这个安排` ``（后跟空格）；
   - 幸存：`` `@opus` `` / `` `@co-creator` `` / `` `@显示名` ``（后跟反引号）、`@句柄（` / `@愿景守护猫）` / `@句柄，` / `@句柄。`（后跟标点）、`Content from @zcode:`（后跟冒号）；
   - 后跟空白但**没被换**的只有 `@dsh-vision` / `@qoder-flash` / `@砚砚6` —— 与"找不到文件就原样保留"相符。
   一句话：它认的是**路由语法**（`@句柄 ` + 正文），正好是 L0 里所有示例的写法。
5. **改写是字符级、会咬到相邻字符**：源模板里 `[正确] @zcode` + 换行 + `请帮忙` 这段，在 CLI 存下的副本里变成 `[正确] @zcoden请帮忙`（换行被吃掉、`\` 消失），紧随其后的另一处 `@zcode` 变成了 ` @.git/refs/...`（注意多出来的前导空格）。这也是"CLI 自己重写了这段文本"的直接指纹。

## 4. 与上一轮 scoping 的接合

- 上一轮已知：31 条带图腿传的**只有一个文件**、`19/31` 在 PUT 前有 10–12s 静默、`resume=false` 腿也照样上传、上传在首个 `inbound session_message received` 之前。
- 本轮的补充：图不是"谁塞进来的"，是 CLI **从 `@opus` 这个 token 解析出来的**。这也解释了为什么"只有一个文件、每次都一样、与 resume 无关"——决定权在 token 解析，不在会话历史。**候选 1（会话附件重放）被排除**：`resume=false` 腿的 session 文件里，`image_file` 附件记录（line 10）就紧跟在**该 session 第一条 user 消息**（line 2）之后，是新生成的，不是重放。
- 附带纠正：`@opus` 被换掉的那 30 条 prompt，与我上一轮数到的"31 条带图腿 / 24 条附件记录"是同一批（多出的计数是同一 run 的后续回合）。两个独立口径互相对上。

## 5. 对 Packet v3.2 的影响（重要）

Packet v3.2 决策 1 写的是"**不让头像进调用**……选项 a = 一处 payload 改动"。**这个动作面按现在的证据不成立**：harness 的 payload 里**从来没有图片块**（stdin 只有文本），图片是 CLI 自己解析 `@opus` 得到的。删 payload 里任何东西都不会让图消失。

可落地的替代（按代价排序，均未实施）：

1. **prompt 侧对 `@` 脱敏**（真修，harness 侧，小改）：对"CLI 会把 `@token` 当文件引用"的载体，在注入 prompt 里把 `@` 换成不被匹配的等价写法（如全角 `＠` / 零宽分隔）。**注意：前面加空格无效**——`（如 \` @opus\`）` 带空格仍被换成了头像路径，已有先例（concierge.ts 的 line-start mention neutralization）可参照。
2. **顺手修正确性**（同一处改动覆盖）：现在 qoder 读到的名册是 `|山猫纹布偶 glm5.3| @.git/refs/heads/backup/zcode-acp-d51b3846 · glm-5.3|`，路由段是 `另一只猫能做 → @node_modules/…authorize.js`——**它在被教着 @ 一个文件路径**。这是比慢更硬的 bug。
3. **不建议把"改头像文件名/挪目录"当终态**：能让 `@opus` 不再命中图片，但 token 改写本身还在（另外 19 个 token 照旧被换），属于把症状挪走。
4. 上游：qoder CLI 不该对 stdin 传入的任意 `@token` 自动套用文件模糊匹配（这是它的 `@` 文件引用补全被自动应用了）。值得单独报给它。

## 6. 未坐实的一环（诚实标注）

- **10–12s 上传前静默**仍**未坐实**归因。新假设：那段是 CLI 的文件检索（bundle 里带 ripgrep，且匹配结果包含 `.git/refs` 与 `node_modules` 这类必须先扫到的路径）。**可证伪预测**：静默应随"去重 token 数"变化，且在无 `node_modules`/`.git` 的仓库里显著变短。本轮数据内 token 数方差太小（L0 固定），**不足以判**，标为假设不标为结论。
- 我**没有**复现实验（没跑 CLI 造一条新腿）——全部证据为只读存量日志 + CLI session 记录 + harness 源码三源交叉。要 100% 钉死"改写发生在 CLI 内哪一步"，需要在 harness 侧记录 stdin 写入时刻并与 session 首条 user 消息逐字 diff（**这是下一步动作，不是已结论**）。

签名：[点点/deepseek-flash🐾]
