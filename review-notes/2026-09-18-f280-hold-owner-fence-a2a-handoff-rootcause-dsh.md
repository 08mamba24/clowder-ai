# F280 Phase D — `HOLD_OWNER_FENCE_UNAVAILABLE` 根因定罪（跨猫 A2A 交接）

**作者**: 点点/奶牛猫 (deepseek-flash) · 2026-09-18
**毛线球**: `0001789660832109-000080-31e0f479`
**方法**: 只读（live API 日志 + 生产 Redis 只读读键 + 代码阅读）；未改代码、未重启、未写任何持久键。

## 一、结论（一句话）

故障点是 `resolveHoldWaitOwnerFence` 四个合取条件里的 **`targetCats` 那一支**：
**跨猫 A2A 交接时，parent invocation 的 `targetCats` 记的是「上一只猫」，永远不含「接球这只猫」**，所以凡是靠 @ 从别的猫手里接球的 invocation，`hold_ball(wakeWhen)` 必 503。

## 二、判定过程（把 A/B 从「未定罪」推到定罪）

任务卡原文把根因留成二选一：A = `!stored`（parent 记录已回收/TTL）；B = 记录在但字段不匹配。

### A 分支排除
- 代码：`RedisInvocationRecordStore.ts:37` `DEFAULT_TTL_SECONDS = 0`（persistent，不设 EXPIRE）+ live 进程 env 实测 `THREAD_TTL_SECONDS=0 / MESSAGE_TTL_SECONDS=0 / SUMMARY_TTL_SECONDS=0`。
- 全仓 `del(` 检索：`invoc:` detail 键**没有任何删除路径**（命中项全是 message/proposal/dossier/draft 的 detail）。
- 结论：parent 记录不会因 TTL 或回收而消失。

### 直接读数（live 生产 Redis，只读）
失败样本来自 live API 日志 `packages/api/data/logs/api/api.2026-09-18.1.log:37016`（同日 4 次重试，同一对 id）：

- 子（发起 hold_ball 的当前 invocation）：`fef84cb1-e381-47ee-8563-e60d7e6ea9fc`
- 父：`b5989ff8-0694-4b6c-b3a8-1e9ce64f52cd`

| 来源 | 读数 |
|---|---|
| `cat-cafe:invoc:b5989ff8…`（父记录，**存在**） | `threadId=thread_msqw8n1bqpvmob6f`、`userId=default-user`、**`targetCats=["zcode"]`**、`status=failed`、`error=a2a_dispatch_disposition_missing`、`userMessageId=0001789701390441-000162-5c6d9e56` |
| `cat-cafe:turnexec:record:fef84cb1…`（子 immutableIdentity） | `catId=dsh-v41-flash`、`threadId=thread_msqw8n1bqpvmob6f`、`userId=default-user`、`parentInvocationId=b5989ff8…`、`causal.triggerMessageId=0001789701446751-000164-ea69f452` |

逐个条件对（`callback-hold-ball-routes.ts:382-403`）：

1. `!stored` → 父记录在 ⇒ **否**
2. `stored.threadId !== record.threadId` → 同 thread ⇒ **否**
3. `stored.userId !== record.userId` → 同 user ⇒ **否**
4. `!stored.targetCats.includes(record.catId)` → `["zcode"].includes("dsh-v41-flash")` = false ⇒ **命中，抛错**

## 三、机理（为什么第 4 条在跨猫交接下必然失败）

`parentInvocationId` 是**因果父**：父 = 产出「触发我这条消息」的那次 invocation。
链路实测：砚砚 verdict（`…000162`）→ 父 `b5989ff8`（**zcode 自己的回合**，故 `targetCats=["zcode"]`）→ 谱谱在该回合产出交接消息 `…000164`（@dsh-v41-flash）→ 子 `fef84cb1`（**我**，catId=dsh-v41-flash）挂父 `b5989ff8`。

于是 `targetCats` 记的是「父回合归属的猫」，而断言要的是「子回合归属的猫」——只有当一只猫把球交给**自己**（或父记录本身是多目标 fan-out）时才碰巧成立。
**@ 单猫交接 = 家里最常见的传球形态，因此必然 503。** 这解释了任务卡观察到的「凡以 A2A dispatch 形态接球的猫都拿不到 wakeWhen 载体」，也解释了为什么无 parent 的 invocation（co-creator 本地触发）走 `containing_task` 分支、直接成功。

## 四、影响面

- 所有跨猫 @ 交接后调用 `hold_ball(wakeWhen)` 的猫：拿不到托管载体 → canonical full gate 只能由 merge owner 降级跑（PR #37 / #38 已两次降级）。
- 无 parent（co-creator 直接触发）与自交接路径不受影响。

## 五、修法方向（**不含结论**，留给 owner + review）

这是**安全栅栏**，放宽需过跨族 review。可考虑但不预判：

1. 交接场景下改为查「派发记录」而非父回合记录——但实测 `*fef84cb1*` 下**没有**独立 a2a dispatch 键，需先补这类记录，成本前置。
2. 重新论证第 4 条的防护目标：它想挡的是「不是我的球我也能持」。authority 是否本可由「同 thread + 同 user + 子记录自身是该 thread 的合法 invocation」承载，删掉 targetCats 合取项的收益/风险需要单独评估。
3. 若保留语义，至少要给跨猫交接一条显式合法的 owner fence 分支，而不是 fail closed 到 503。

## 六、边界与未查完

- 全程只读：未改代码、未写 Redis 键、未重启、未碰 live 状态。
- **未查完**：① 父记录 `status=failed / a2a_dispatch_disposition_missing` 与本次 503 是否互为因果（zcode 载体无 cat_cafe 工具 → 无法 complete dispatch；本报告只证明它不是 fence 抛错的直接原因，未证明二者无关联）；② fan-out（多 targetCats）场景下第 4 条是否真的成立，未取样本验证。
- **样本数 3/3（跨两天，非单点）**，同法读键，机理完全一致：

| # | 时间 | 子 invocation | 子的 catId | 父 invocation | 父 threadId / userId | 父 targetCats |
|---|---|---|---|---|---|---|
| 1 | 09-17T14:56:26 | `fc1af125…` | `dsh-v41-flash` | `ea803bdf…` | thread_msqw8n1bqpvmob6f / default-user | `["zcode"]` |
| 2 | 09-17T15:57:03 | `ba7d4c1a…` | `dsh-v41-flash` | `afa1b942…` | 同上 | `["zcode"]` |
| 3 | 09-18T03:23:59～03:24:06（4 次重试） | `fef84cb1…` | `dsh-v41-flash` | `b5989ff8…` | 同上 | `["zcode"]` |

三次都是「父 = zcode 的回合，子 = 接球的 dsh-v41-flash」，thread/user 全等，唯一不等的就是 `targetCats`。
