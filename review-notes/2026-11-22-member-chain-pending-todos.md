# 2026-11-22 成员链路问题 TODO

- 会话：`thread_owned_5df7c329505b2cd48350dbb88294ebc6ef96de23`
- 原记录：谱谱 / glm-5.3；证据复核：砚砚61 / gpt-6.1-sol
- 更新：2026-11-22；下文时间均为 UTC。
- 接续来源：用户消息 `0001795349271656-000669-42e7567e`。
- Task：`task:work:0001795349706232-000671-8fce4bcd`。

## 四项问题

当前三项已恢复并验收，只剩Pro外部429。[boot16部署后验收记录](2026-11-22-member-chain-runtime-boot16-acceptance.md)包含实际加载、98项隔离回归、点点续聊和谱谱真实gh审计证据。

| 项目 | 当前状态 | 下一步 |
|---|---|---|
| 1. 点点 ACP 续聊失败 | PR #79 已在boot16部署，旧session受控重建并正常回复，验收通过 | 本项关闭；详见boot16验收记录 |
| 2. 银闪启动 canary 失败 | PR #78 已部署，隔离启动与真实回话验收通过 | 本项关闭 |
| 3. Pro 读取 429 | boot16重启后精确读取复测一次仍报外部MCP SSE probe 429 | 唯一未恢复项；外部通道恢复后验精确消息读取，当前不承担正式review |
| 4. 谱谱 gh 凭据 | PR #80 已在boot16部署，真实gh读取EXIT0且宿主审计归属匹配，验收通过 | 只读通道恢复，本项关闭；作者工位已归档并移除 |

### 1. 点点 ACP 续聊缺少受控重放

- **纠正对象**：09:07 的失败消息 `0001795338434294-000612-889be875` 来自 `dsh-v41-flash`，metadata 为 `provider=acp, model=deepseek-flash`，`turnExecution.executionKind=ordinary`；触发者为用户消息 `0001795338434168-000611-e66d12ce`。不能把这条证据写成“A2A 派发到 zcode 失败”。
- **线上证据**：点点在 09:06:45 创建会话 `d5923e1e-de35-4071-853f-cec634d000f2`，首轮成功；09:07:14 进入 `route-serial`，增量投影实际读到了历史；09:07:16 因重放缺失抛出 `prompt_failure`，`eventCount=0`。
- **代码断点**：`QueueProcessor` 调用 `AgentRouter.routeExecution()`，提供 `currentUserMessageId`，不提供旧 `history` 参数。串行/并行路由的增量模式通过消息库组装上下文，但 PR #76 的 `rebuildContextPrompt` 仍只使用 `options.history`。库里有历史，不等于 carrier 收到了重放。
- **测试缺口**：`packages/api/test/native-acp-rebuild-route.test.js` 手动注入 `routeOptions: { history }`，没有覆盖线上不传该字段的入口。
- **修法**：从同一授权、可见性边界内的 canonical 历史生成有界重放，覆盖串行、并行与真实 Queue 入口。回归只向消息库准备历史，不手塞 `options.history`，验证前轮内容进入 replacement session、预算和可见性保持成立。
- **不采用**：直接省略旧 sessionId、删除旧 session 或放松重放校验；这些做法会掩盖失忆或审计断链。
- **状态**：宪宪已接责到 `task:work:0001795351395942-000685-f60ff146`，提交 [PR #79](https://github.com/08mamba24/clowder-ai/pull/79)，首轮 head `8772e134d85deb82be07c38a60727af84e571c5c`，二轮 `b15a563144df40ea34efc62c0fb12b2ab9ecd8f6`，最终被审 head `e276daef0ff147569ad26e61f56724f2e8b81ff1`。来源为 operator 并行授权 `0001795351305664-000679-1174615a` 与分派 `0001795351360491-000681-8415c0d8`。
- **独立审查**：砚砚61 用 Node 24.22.3 复跑新 3 条与旧 6 条回归，**9/9** 通过，API `tsc --noEmit` 通过；补充真实 Store / 路由 / ACP carrier 反例后给出 **CHANGES_REQUESTED，0 P1、2 P2**，typed fact 消息 `0001795353475809-000713-98b5c0fd`。作者工位源码未改、HEAD 与远端一致；未创建 reviewer 沙盒。
- **P2-1 / 选集窗口**：先取全线程最新 200 行、再过滤 viewer/boundary/delta，会让无关行挤掉旧历史。真实两轮中追加 205 条仅给 codex 的 whisper，第二轮当前问题仍进 prompt，但 replay 为空；真实 no-resume ACP 再报原 fail-closed 错误。205 条 delta 或 boundary 后记录亦能挤掉本来存在的 2 条旧历史。
- **P2-2 / 游标坐标**：旧 hash 无 visibilitySeq 时，cursorFor 返回 v1；与 v2 boundary 比较的 0 表示不可判定，不能按 `<=0` 放行。真实 Store 的权威 index 可证明 later 消息在 boundary 之后，但该 hash 缺字段时被 helper 放入 replay。需解析权威坐标或使用已 canonical 化的读取结果。
- **二轮复审**：`b15a563144df40ea34efc62c0fb12b2ab9ecd8f6` 独立回归 **14/14**、API `tsc --noEmit` 通过；原两支探针确认 205 条 whisper/delta/future 不再挤掉 replay，legacy 未来行不再泄漏，首轮 P2-2 已关闭。但新增预算逻辑仍有两个 P2，typed changes_requested 为 `0001795354407490-000752-b168f797`。
- **二轮 P2-1 / 候选 token 资格，已关闭**：当时把最终 assembler 会丢弃的长 `[错误]` agent、display-only system 或 briefing 计入 4000 token 停止阈值。真实 Store 对照：2 条有效旧问答、205 条别猫 whisper、1 条约 8000 token 的上述记录、当前问题；三种无效长记录各使 replay 为空，读取仅返回 100 行。最终提取唯一 `isRebuildReplayEligible` 供候选与组装复用；原探针四组 replay 均存在，新回归同时确认无效内容被排除。探针 `/tmp/20261122-pr79-review-delta-probes.mjs`。
- **P2-3 / raw scan 预算，已关闭**：当时 `getByThreadBefore` 内部过滤补读，外层仅数返回行；真实 `RedisMessageStore` 配纯内存计数桩，5000 canceled 加 anchor/prior 实测 fetched/hydrated=5002、rangeCalls=51。最终改用 `getByThreadBeforeBounded`、按 `scannedCount` 计费、按原始 `nextCursor` 续翻；独立原探针复测严格停在 fetched/hydrated=1000、rangeCalls=10，超出范围的历史不可达时 replay 为空，carrier 继续拦截。0 canceled 控制组正常回放，150 whisper 的跨页回归亦通过。探针 `/tmp/20261122-pr79-review-redis-scan-probe.mjs`；无 Redis 网络或生产数据访问。
- **最终复审**：砚砚61 对 `e276daef0ff147569ad26e61f56724f2e8b81ff1` 给出 typed **APPROVED**（消息 `0001795354937982-000756-6d5595de`），无剩余 P1/P2。独立运行新旧 replay 与 context-assembler 三文件共 **77/77**，API `tsc --noEmit` 与 `git diff --check` 通过；作者源码/工位未改、未建 reviewer sandbox。原反例已实跑闭环；未将作者 98 文件全量结果冒充独立执行。日志 `/tmp/20261122-pr79-e276-independent-tests.log` 与 `/tmp/20261122-pr79-e276-independent-tsc.log`。
- **合入责任**：批准仅覆盖被审代码，不代表已合入、部署或线上已恢复。原先交宪宪执行后续检查，当前按下述用户新指令拆分续办。1000 raw 行耗尽仍无有效历史时继续 fail-closed；in-memory store 保留自身全局尾部窗口语义。
- **合入续接**：宪宪在 `0001795354938086-000757-7c1081e0` 已进入 merge-gate，报告 5 个 fork 失败并在集成树验证；API 换代后没有终态证据回传。本轮只读核实 #79 仍 OPEN、head 仍为 `e276daef0ff147569ad26e61f56724f2e8b81ff1`，原 Task revision 5 仍写“等 review”。已沿原责任发送一次续接，要求先消费已有命令退出结果与基线证据，更新 Task；必要 gate 完成后交非作者合入，不重新索取旧批准。
- **额度中断与用户改派**：上述续接 `0001795358937549-000153-7dd21567` 已失败，回执 `0001795358937694-000154-58e2e4a7` 为 Claude 5 小时限额，不是代码失败。用户 `0001795359058599-000165-660e72ee` 明确要求将宪宪剩余工作拆给谱谱/银闪。砚砚61已建立两项持久拆分任务并发送执行分派；原宪宪 Task 保留原作者、批准与过程证据，不伪造其完成或改写 owner。
- **银闪 / 集成验证**：Task `0001795359172058-000171-eab2a698`，分派 `0001795359196193-000173-1a8a94bb`。负责隔离运行必要 fork/replay 缺项，回传真实退出码、选集、HEAD/base 和日志。现有干净验证工位 `worktrees/pr79-integration`，HEAD `7c343436e157c03eeceda71b2ee6fa540faea37d` 为 `8ae076016 + e276dae`、已带 #78；专用于验证，不改源码或切分支。原 `/tmp/pr79-int-fork.log` 实为 **25 pass、0 fail、6 cancelled / Interrupted**，不能当作通过或六个产品回归。若沙箱限制阻断验证，回传原始诊断，由砚砚61补宿主执行。
- **谱谱 / 旧失败归因与必要修复**：Task `0001795359172107-000172-808f2c0b`，分派 `0001795359223427-000176-3266bc87`。先收现行 #80，再核 `/tmp/pr79-fork-selected.log` 中五条 qoder canary 失败与 #78 ancestry/blob 的关系、current main 与 approved head 的交集。基线过期 exclusion 及中断均保留，不改日期、不伪绿；没有新缺陷就交可复核证据，确需修源码才另立工位交新 exact SHA 审查，不触碰银闪验证工位。最终合入门、非作者合入及部署后验收仍由砚砚61负责。
- **拆分交付已消费**：谱谱 `0001795359800254-000187-f6e71380` 提供 `/tmp/20261122-pr79-fork-attribution-zcode.md`，证明 approved head 不含 #78，而 main/集成树包含，五败与 #79 七文件零交集，未改源码。银闪 `0001795359196329-000174-355254ac` 从 exact 集成树导出后 build 三包通过、replay **77/77**；原 fork API **142/151、fail 9** 与 MCP **6/6** 保留，九败原始签名为 nested Seatbelt 拒绝八项及 `/tmp` mkdir EPERM 一项。其证据已由原创建者迁至 [集成验收索引](2026-11-22-pr79-integration-evidence/README.md)，原25份文件 hash 逐项匹配；自建1.8GB导出及原根目录日志空壳已收走，真正工位未动。拆分 owner 缺 task 回调工具，未冒充其身份代改完成态，交付与合入事实写回本父责任。
- **宿主补验与合入门**：同一集成工位用 Node 24.22.3、临时 HOME/不可连接 Redis 跑 qoder service、memory policy、origin boot smoke 三文件，**101/101、exit 0**，补足上述全部九个受限用例；日志 `/tmp/20261122-pr79-integration-host-gap-tests.log`。其余五个 API 文件50项与 MCP6项由银闪实际通过；全部唯一九文件选集均已有通过覆盖，不谎称单次157项命令绿。独立核对 current main 与 reviewed patch 的 C2 交集为空，集成树到合入前 main 仅共享 TODO 文档差异；旧 resolver 失败、旧五败和中断不改写。风险、原 accepted source、exact typed review、验证及 E1-E5 已写[合入证据评论](https://github.com/08mamba24/clowder-ai/pull/79#issuecomment-7081152712)，中文正文与评论均经 GitHub API 逐字回读。
- **已合入、未登记线上恢复**：砚砚61作为非作者执行 squash merge，PR truth 已回读 `MERGED`（2026-11-22 15:15:30 UTC），合入 SHA `10dd3dc20ce9a734e3451250d49c665b3634bfaf` 同时为远端 main tip；主仓已 ff-only 同步。原父 Task 最初登记 `deploymentWait` **generation 2**；#80合入后已由下述 generation 3 合并承接两项验收，subject 仍为 `deployment:380f50e6414ee4ba1c352c3c50511ff1f9faa09045f65cd02f452cd4fe6bc7bf:runtime`，等待精确合入 SHA 被 ready API 包含，baseline 为 boot15；不轮询、不自行重启。届时从隔离数据验增量/carrier，并做点点正常续聊回话确认。Alpha已ff-only到冻结合入 SHA并重建实际API/依赖；`managed-job-927ec69cf4e79e8c7ed54496e6644299fa688eed` 托管终态已消费为 `succeeded/exit 0`，新旧 replay/context-assembler **77/77、0 fail/cancel**。日志 SHA-256 `9ad90255b63dc3df1bb05a949370ba611864b399f2a00a97c0f09f8e135d5a50`。这只证明隔离验收；`main=landed:10dd3dc20`，`live=activated_and_accepted:boot16`，具体新代际证据见下条。
- **boot16真实入口验收已通过**：原generation3以matched/delivered唤醒，消息 `0001795363785384-000000-6b339a19`。health/PID16180/cwd/实际构建共同确认运行revision `61f95378fe805ec0d15b338190b6282fada324c1`，boot=`90313d9d-963a-4b19-bc92-3497a61e729f`/sequence16。该runtime实际dist在临时HOME/隔离数据下 **98/98、exit0**，双实际adapter无模型探针亦通过。只派一次点点正常续聊（source `0001795363935027-000002-20eda3b8`），持久回复 `0001795363935129-000004-1dd38bb6` 精确replyTo、正文“收到”。API日志确认 invocation `606e010b-f59b-4d43-af38-e38df987a8f2` 使用原旧session `d5923e1e-de35-4071-853f-cec634d000f2` 进入受控replacement，生成新session `24be81ee-7910-42f1-bd6d-f0624a954395`，promptStream完成且eventCount1。未重置历史或放松门；本项已恢复并关闭。
- **Pro 独立校准**：operator 授权消息 `0001795353530855-000718-e3237d6f`。首个长请求 `0001795353938185-000727-f003f5c8` 未完成审查：Pro 在 `0001795353966738-000732-9f2f1bd8` 报告材料截断、工具读写 404。代码核实云桥 `DELTA_PAYLOAD_MAX_CHARS=2000`，包含固定信封且 intent 出现两次，长源码在发送前已裁掉。随后改为 239 字符的单问题请求 `0001795354223080-000740-9dcdabe7`；Pro 在 `0001795354234451-000743-cb711790` 确认看见 END79，给出“返回可见行数不能限制底层扫描”的具体判断与反例。该判断经上述本地计数探针核实，已反馈作者；一次 advisory 校准已产出实质结果，不构成整 PR 批准，不追加常规修复轮次。

### 2. 银闪 Node 包元数据被沙箱拒绝

- **现象**：09:07 消息 `0001795338478168-000618-66590a4c`：`qoder sandbox guarded gh execution canary failed`。
- **复现**：实际 Node 24.22.3、包装器及生产 policy builder，在临时隔离目录执行 `gh --version`。四组对照中，无 literal 和只放行 runtime 根 `package.json` 均报 `ERR_INVALID_PACKAGE_CONFIG`；只放行 `packages/mcp-server/package.json` 与两者均放行都退出 0。包 manifest 单独放行时，根 manifest 的 `/bin/cat` 仍退出 1。
- **原因**：Node 在执行无扩展名的 `guarded-bin/gh` 之前解析 package scope，包装器的 readonly 提前返回尚未开始执行。不是 gh 登录失败。
- **修复**：只把包装器实际所属 `@cat-cafe/mcp-server/package.json` 加入 workspace policy 的 literal read allowlist；根 manifest 保持拒读，不开放整个 runtime，不移除 canary。初版额外放行根 manifest，经砚砚独立 review 提出最小权限 P2 后，作者补齐对照并收窄。
- **交付**：[PR #78](https://github.com/08mamba24/clowder-ai/pull/78) 已由非作者砚砚 squash merge；合入 `79d03e16b9f39ee0fa50f3f60c4a008c0a134fd3`，PR truth 为 MERGED（2026-11-22 12:54:36 UTC）。被审代码 head 为 `a887ef1c34fa64ed36677c5e01f046233e1b4399`，改动 `QoderAgentService.ts` 和现有 service 回归用例。
- **验证**：现有 `L2: macOS controlled PATH resolves guarded gh and a runnable pnpm before provider spawn` 修前以线上同一 canary 错误失败；新增根 manifest 拒读断言在初版补丁上失败，收窄后 Qoder service + 真实 Seatbelt memory policy 共 **99/99** 通过，API 构建和修后 TypeScript 编译通过。对照实验中 `.env` 与 runtime 的 `scripts/lib` 继续拒读。未调用真实模型，未改在线 runtime 或运行配置。
- **审查**：旧 SHA `37247e5549119b68e499f1d65e07cd9763f2935e` 的 typed verdict 为 changes_requested（消息 `0001795350798827-000675-56f7dbc9`）；修后 exact SHA `a887ef1c34fa64ed36677c5e01f046233e1b4399` 已获同一非作者 reviewer 复审 APPROVED（`0001795351370906-000683-a12a4bea`），无剩余 P1/P2。
- **合入检查**：canonical `pnpm --filter @cat-cafe/api run test:fork-compat` 的 build 完成，但因基线已过期的 F306 public-test exclusion 在选集前退出 1（job `managed-job-463fbf455a1815994f1027c76bc84d5b258a55c7`），保留此失败。registry、fork config、resolver 与基线 blob 均相同；未改日期或排除项。另从唯一 fork config 派生全部 9 文件，核实存在且与所有排除正则无交集，按原 runner 参数与隔离 test HOME 实跑 **API 151/151 + MCP 6/6 = 157/157**。补充选集 hash 为 `08b0c4b4aaf63efd54aaab296a05067d1a4a51fbbec6c698666860513530f596`；这份 targeted 绿灯不改写原命令失败。
- **合入证据**：[PR evidence](https://github.com/08mamba24/clowder-ai/pull/78#issuecomment-7079392266) 已远端逐字核对；非作者合入回执为 `0001795352108766-000698-19b676af`，作者另行回读 PR truth 和同步 main。
- **隔离验收**：Alpha 以 ff-only 同步到 `79d03e16b9f39ee0fa50f3f60c4a008c0a134fd3` 后重建 API 及依赖；真实 Seatbelt 的 controlled-PATH 与 missing/redirected HOME 两项均通过（**2/2**），job `managed-job-f0b00ee75c999915e6c7a0628d7326cb5679a2ad`、exit 0。Alpha 无运行服务；验收使用临时 HOME 和隔离数据。
- **工位收尾**：作者工位 `/Users/yuhan/cat-cafe/cat-cafe-member-chain-20261122` 已由 canonical finish 移除，`--check` 复验为 `released/storageDisposition=removed`。独有原件与 Git metadata 归档在 `/Users/yuhan/cat-cafe/.worktree-release-archives/2ef0dc57-e927-4339-8a71-3c0c90310f9f`，分支源码保留；PR 库存复查不代清其他 owner。
- **部署续办已触发**：原 Task 的 `deploymentWait` generation 1（subject `deployment:380f50e6414ee4ba1c352c3c50511ff1f9faa09045f65cd02f452cd4fe6bc7bf:runtime`）以 `matched/delivered` 回执唤醒，消息 `0001795355465110-000000-a9f5e2f9`。实际 boot 为 `b7557250-2f33-453c-bd63-413ff881578f`、sequence 15，running revision `8ae076016772625a97c87762aaecad7787ea6fb6`；Git ancestry 独立核实包含冻结目标 `79d03e16b9f39ee0fa50f3f60c4a008c0a134fd3`。未续约已消费等待，未由本猫重启服务。
- **实际加载与部署后验收**：新 API PID 82768 的 cwd 为 `cat-cafe-runtime/packages/api`，自有端口 3004 `/health` 返回 200/ok。实际 runtime 的 `dist/.../QoderAgentService.js` SHA-256 为 `736d381f0c586091cd2132e2bcdf92323112747d2899e308bef087b0fb38d223`，与已验收 Alpha 构建相同；mtime 为 2026-11-22 13:48:58 UTC，早于本次 API 启动。在该 runtime 构建上用临时 HOME、不可连接 Redis 执行真实 Seatbelt 的 controlled-PATH 与 missing/redirected HOME 用例，**2/2** 通过：guarded gh/pnpm 可启动，仓库根 manifest 和 runtime 凭据仍拒读；runtime 源码无改动。日志 `/tmp/20261122-pr78-runtime-boot15-acceptance.log`，SHA-256 `0421b35782ae8e461d2bbb72a1d14103a8073d01170c96972136eee9f702dbb1`。
- **真实正常回话验收**：承接用户 `0001795355220621-000758-840dfa65` 的 hi，仅派发一次当前服务上的正常回复确认，source `0001795355652994-000011-22ad7535`，invocation `53d97f74-19dd-42e9-982f-08053e7d2035`。银闪在本线程的持久回复 `0001795355653087-000012-8923609d` 已包含“收到”，且生命周期已不再 processing。未要求执行额外排查命令或改配置；这是实际回复证据，不以模型自述链路名称作为 provider 证据。
- **状态 / owner**：`main=landed:79d03e16b9f39ee0fa50f3f60c4a008c0a134fd3`，`live=activated_and_accepted:boot15`；本项启动故障已恢复并完成原 Task 的部署后验收。13:47 的空失败发生在旧 API 启动代际，不能代替本轮结果；其余问题不因本项成功自动关闭。

### 3. Pro 429 位于云端 MCP 隧道探测层

- **原始线索**：消息 `0001795339167201-000636-4e7063ae` 是 Pro 对读取失败的描述；callback 只能证明回复回传，不能单凭正文认定限流层。
- **本轮实测**：通过独立的云端猫咖连接调用只读 `cat_cafe_get_thread_context`（本线程、`limit=1`），返回 `isError=true`：`McpServerError: MCP SSE probe returned 429 from openai.org`。结构化错误为 `error_code=UNAVAILABLE`、`type=invalid_mcp_response`、`status_code=429`，URL 属于 OpenAI 内部 MCP tunnel service。本记录不复制隧道标识或凭据。
- **本地对照**：实际 API 日志在 09:06—09:24 UTC 的 HTTP 完成记录没有 HTTP 429；此结论仅覆盖已检查窗口与该 API 进程。
- **处理**：当前证据不支持调整本地 gateway per-token 或 API 全局限流。外部通道恢复后，验证“读出指定消息并核对 ID”，而非只发 hi。持续失败时保留时间与结构化错误，用于连接器恢复或服务支持排查；不做高频重试。
- **状态**：外部传输问题已复现，未恢复。原始 09:19 请求是否与本轮完全同因，缺少原始工具回执，不能追认。
- **后续观测**：首次 Pro 审查请求要求一次读取精确用户消息 `0001795353530855-000718-e3237d6f`；Pro 返回正文自述读写工具 404，尚无原始工具回执可核实失败层。短材料审查已有实质回传，但没有成功工具读取证据，不据此关闭 MCP 故障或把原 429 改判为 404 同因。
- **本轮读取验实**：operator 在 `0001795355952214-000030-04b0ae6a` 要求先确认 Pro 能收消息并读取上下文，才交正式 review。精简请求 `0001795356122804-000047-a8168142` 要求按该精确用户消息 ID、full、agentKeyCatId=gpt-pro 实际读取，未附预期正文；Pro 在 `0001795356142830-000050-0b2d59aa` 返回无 messageId/正文，错误为 `UNAVAILABLE / MCP SSE probe returned 429 from openai.org`。读取条件未满足，本轮不分派正式 review；保留先前单问题离线 advisory 的独立记录。
- **并行实施 / 银闪**：按上述用户授权，分派 `0001795356198261-000052-531ba656`，生命周期已进入 processing。目标核清当前工具、Remote MCP、callback 读入口、主体/thread scope 的真实路径；仅对有证据的本地接线缺陷交最小修复和红绿回归，外部故障则回传失败层证据。保留既有鉴权、越权 404 与 2000 字符契约，不重试轰炸 Pro。父 Task、共享 TODO 与收口仍由砚砚61负责。
- **银闪执行异常与续接**：上述首轮分派已 failed，返回 `0001795356198355-000054-22d6bccd`。原 invocation `1030c930-ea7a-4751-a3e1-96e47099a3fa` 在 14:04:18 已绑定会话并执行多轮只读工具；14:11:29 的原始 CLI 诊断为 exit=1、signal=null、reasonCode=null、stderrEmpty=true、streamErrorCount=1，可见输出提示连接中断，具体网络/服务层未确认。这发生于 CLI 启动之后，不改写 #78 的验收结论。已保留部分诊断，仅以新 source `0001795356858902-000072-ae9c20d7` 从最后的 AuthHeaders/bound-identity 检查处续接一次；若再出现同类退出，停止重复派发，由砚砚61接续。不读取队友原始会话、不重启服务或修改网络配置。
- **银闪诊断已完成**：续接结果 `0001795356859034-000073-8590992c` 确认 cloud-pro-phase0 含 `get_message`；spike 无 invocation scope 时走绑定 agent-key，错猫选择器拒绝，API 保留 principal standing 与 owner/visibility 校验。银闪报告 agent-key / bound-identity 两文件 **21/21**，此数为作者实跑回执，未冒充砚砚61独立运行。本地路径已核出的失败形式是 401/403/404 或工具层错误；当前原始 OpenAI SSE probe 429 无法由这些接线证据解释，故不制造本地补丁。13:26 无原始回执的 404 自述仍不追认同因。
- **健康探针的适用性**：本轮宿主只读检查未发现默认 3098 监听或 cloudflared 进程；但 fork 的根 `package.json` 已无 `cloud:status` / `cloud:doctor` 注册，`scripts/port-drift/exported-scripts.mjs` 明确将该 supporting-service helper 标为 home-only。旧 F247 runbook 不能证明当前连接器仍采用该部署路径，因此没有访问未知端口、启动服务或据此把外部 429 改判成本地服务离线。后续恢复仍以实际连接器成功读取指定消息为准。
- **当前连接器复测**：砚砚61通过独立云端猫咖连接只调用一次 `get_message(messageId=0001795355952214-000030-04b0ae6a, mode=full, contextCount=0, agentKeyCatId=gpt-pro)`，仍返回 `McpServerError: MCP SSE probe returned 429 from openai.org`，未取得目标正文。该证据是本轮连接器实测，不是 Pro 成功读上下文；不追加高频重试或正式 review。

- **boot16后复测**：新runtime就绪后通过独立云端连接器仅复测一次上述精确消息读取，仍 `isError=true / UNAVAILABLE / invalid_mcp_response / status_code=429`，原始错误仍为 `MCP SSE probe returned 429 from openai.org`；没有拿到正文。重启没有恢复此通道；四项中仅本项未恢复，不追加高频重试或正式review。

### 4. 谱谱 gh：隔离事实与新授权分开

- **本轮复测**：宿主 `gh api user` 成功，login 为 `08mamba24`；仅切到 zcode 隔离 HOME / XDG_CONFIG_HOME、无 GH 覆盖的子进程中，`gh auth status` 返回未登录。未执行登录、复制凭据或冒烟写操作。
- **代码**：`zcodeAppServerEnv()` 重定向 HOME 与 XDG 目录；`agy-native-launch-env.ts` 有宿主 GH_CONFIG_DIR 接线先例，但别的 carrier 的实现不自动授予 zcode 同等权限。
- **现行边界**：本实例仓库操作走 canonical `gh` CLI。历史 GitHub read MCP 代码不构成继续使用已退役 GitHub MCP 的依据。保留 ZCode 自己的 HOME，按允许的仓库/读写操作接受控宿主 gh 调用，避免把原始凭据散发到模型环境。
- **纠正旧建议**：细粒度 PAT 可以缩小 token 的仓库/权限范围，但仍绑定生成它的 GitHub 用户，不会自动形成独立猫身份。参见 [GitHub 官方 PAT 说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。无需在聊天里发送 token。
- **谱谱实施与代发布**：按 operator 并行授权 `0001795355952214-000030-04b0ae6a` 与分派 `0001795356198305-000053-67fa8832`，谱谱交付分支 `feat/zcode-gh-canonical-read`、commit `2c9dc8a7fe21077dfa56110f4dc64405f325d7e9`，工位 `/Users/yuhan/cat-cafe/cat-cafe-zcode-gh-canonical`；正式传球为 `0001795357836564-000106-8aff12b3`。砚砚61已代推送、创建[草稿 PR #80](https://github.com/08mamba24/clowder-ai/pull/80)，通过 GitHub API 核实远端 exact HEAD、draft=true，正文与 `/tmp/20261122-zcode-gh-carrier-pr-body.md` 逐字一致。保留现有 host broker → reader → canonical gh，不复制宿主凭据、不增加写权限。
- **独立审查退回**：对该 SHA 给出 typed **CHANGES_REQUESTED，0 P1、2 P2**（`0001795358801258-000145-3d96ae63`）。现有 wrapper/pin **16/16**、API carrier/lease **4/4** 由砚砚61独立执行通过，`diff --check` 通过，但补充真实入口反例复现下述故障。作者源码/工位未改，未建 reviewer sandbox；这些绿测不等于迁移已完成。
- **P2-1 / 并发 lease 归属**：所有 zcode 调用读写同一个隔离 HOME 文件。真实 `AcpAgentService` + `AgentGitHubReadBroker`、两个可控假 provider、自有回环测试服务中，A 开始后 B 覆盖文件，A 环境的 `gh pr view` 被审计成 B 的 invocation/thread；B 先结束删除文件后，仍 active 的 A 读取报 `capability_unavailable`。只删本 token 的 cleanup 不能保证调用方始终取到自己的能力。要求按真实 attempt/进程绑定选择器，补重叠、B 先结束、A 继续正常且审计正确的回归；不能依靠当前 pool=1。`AcpServiceFactory.ts:298-312` 已给 zcode 设置 `retireAfterLease=true`，作者关于跨尝试 warm 复用的设计前提亦需纠正。
- **P2-2 / run list**：wrapper 将 `run_list` 也按带 state 的列表处理，`scripts/guarded-bin/gh:145` 的 `config.state.includes` 必抛 TypeError，HTTP 请求尚未发出。服务端 `run_list` schema 不接受 state，不能只给 includes 加可选链；应仅构造 op/repo/limit，补默认/显式 limit 与 state 拒绝的契约用例。独立反例 `/tmp/20261122-pr80-review-probes.mjs`、日志 `/tmp/20261122-pr80-review-probes.log`；无真实模型、GitHub 凭据或 Redis 访问。
- **修后复审已通过**：谱谱提交 `441133702f749032c59ade2898aea0bbbcb6ad50`，砚砚61已代推、更新 UTF-8 正文并通过 GitHub API 逐字核对。共享 HOME 文件机制已拆除：descriptor只作 ACP 传输，由实际 adapter消费为进程 provider runtime 目录中的0600文件，并在进入 native 前剥除；wrapper只读本进程路径，没有 HOME 兜底。run_list只构造 op/repo/limit、拒绝state，补齐八操作参数矩阵。typed **APPROVED**：`0001795360241643-000191-affb6fa2`，无剩余 P1/P2，保持原 source/revision。
- **修后独立证据**：scripts carrier/pin/secret-send **28/28**，API adapter/service/lease **21/21**，API `tsc --noEmit`、diff空白检查与 wrapper byte pin匹配通过。另用真实 `AcpAgentService`/broker、两个实际 adapter 进程（native为无模型fixture、同一HOME）贯通：各自lease目录不同；A在B重叠与B先退出后始终按A/thread-A审计；退出实际清自己的目录；session/load无descriptor清除、重下发恢复；native create/resume始终MCP=[]，run_list严格schema通过。探针 `/tmp/20261122-pr80-441133-actual-adapter-probe.mjs` 及同名log；独立日志 `/tmp/20261122-pr80-441133-scripts-tests.log`、`-api-tests.log`、`-tsc.log`。原作者源码未改、未建reviewer sandbox、未调真实模型或GitHub凭据/Redis。
- **作者合入门交付已消费**：`0001795360241726-000192-b2f402be` 与 `/tmp/20261122-pr80-merge-gate-evidence.md`；在被审 exact SHA `441133702` 上，唯一 fork 配置的 API八文件 **152/152**、MCP一文件 **6/6**，合计 **158/158、0 fail/cancel/skip**。砚砚61读取原始输出，未把作者执行写为独立重跑。原 canonical resolver 仍因既有 F306 exclusion 于2026-11-13过期 exit 1，保留失败、未改日期或排除策略。
- **合入门与远端真相**：current main `7c5de0b9e` 相对 oldBase `fb1740386` 的变更，与本 PR十三文件交集为空。#79仅补 routing/replay 历史生产，未改 read-descriptor、broker/schema 或 adapter/lease 契约；本 PR在AcpAgentService的净变更仅注释。merge-tree无冲突；原source/revision与typed APPROVED逐项对账，E1-E5通过。五轴风险已补正文；[合入证据评论](https://github.com/08mamba24/clowder-ai/pull/80#issuecomment-7081296737)与中文正文均经GitHub API逐字核对。砚砚61作为非作者执行squash merge，PR truth回读 **MERGED（2026-11-22 15:26:38 UTC）**，合入SHA **`39534073ff190b67d455269d30938e830f5429cf`** 已在origin/main；主仓ff-only同步。
- **合入后隔离验收**：Alpha ff-only到冻结 `39534073f` 后重建API/依赖；`managed-job-bb8999637e5b7087a39d3d00c5dee626f833baa1` 终态已消费为 **succeeded / exit 0**。carrier/pin/secret-send **28/28** + adapter/service/lease **21/21**，实际双adapter无模型探针再确认同HOME各自lease、重叠与B退出后A审计仍归A、load清除/恢复、native MCP=[]与实际目录清理。探针仅替换已审脚本的checkout路径，未模拟adapter消费；不触碰真实模型、GitHub凭据或用户数据。日志SHA-256 `00e4253da3958de07e416944d758953e950b12bc8dd3834db78b1a6fc7e755e3`；Alpha与作者工位跟踪文件均干净。
- **原父Task合并等待**：成功登记runtime `deploymentWait` **generation 3**，冻结目标 `39534073ff190b67d455269d30938e830f5429cf`；Git ancestry已证明它包含#79合入 `10dd3dc20`。该单次等待显式承接generation2的点点续聊验收，并增加#80实际gh读取验收，baseline仍boot15，autoRenew=false；未丢弃旧责任或新建镜像Task。触发后核对ready API实际加载/产物、隔离复验，再让谱谱在新invocation实跑 `gh pr view 80 --repo 08mamba24/clowder-ai`；读取成功且审计归属正确才登记恢复。`main=landed:39534073f`，`live=activated_and_accepted:boot16`，具体新代际证据见下条。
- **工位与边界（合入时记录）**：工位真实owner=zcode；其CLI显式 `--owner zcode` 后已通过owner检查，当时缺远端PR读取凭据，bind-pr未完成。保留原Task来源与作者工位至部署后验收，不冒充身份、改owner或代造别猫Task完成态；#79原作者与集成工位也未被代删。当前open PR库存仅见无关#74，本轮不接管。未来写能力、权限扩张、运行配置与账号动作另按现有边界处理；Pro实际读取条件未满足，未交正式review。

- **boot16真实gh验收已通过**：source `0001795363935070-000003-10163338` → invocation `6284fd0d-b463-402b-859c-18c73fa9a5f7` →完整回复 `0001795363935208-000005-208f06ca`。谱谱在该真实会话一次执行 `gh pr view 80 --repo 08mamba24/clowder-ai`，回传 **EXIT0、number80、stateMERGED、head441133702**。宿主当日EventAuditLog独立读到 `agent_github_read` 事件 `6d3b2d8e-fbe7-4b88-a101-2ef9cddcf2d2`：invocation/线程精确匹配、cat=zcode、repo=08mamba24/clowder-ai、op=pr_view、outcome=read、headSha441133702、truncated=false。CLI结果与主体审计闭合，已授权八种固定读通道恢复，不代表新增写权限。原generation3已消费，不续约。
- **作者工位善后已核验**：原owner按分派 `0001795364068927-000008-80a53696` 完成canonical finish及--check，回复 `0001795364069011-000009-7618f121` 报 `released/storageDisposition=removed`。砚砚61独立确认目录实际不存在、Git worktree清单已无该项；归档manifest与canonical ledger的done记录均精确匹配owner=zcode、sourceRef=pr:08mamba24/clowder-ai#80、head441133702。独有原件及私有Git元数据持久归档 `/Users/yuhan/cat-cafe/.worktree-release-archives/86218360-ca82-433d-8b87-81391da06f40`，未改owner或代造Task完成态。bind-pr尝试仍因其使用raw `gh api` 被八种固定读载体按契约拒绝，此边界不影响已验证的pr_view与canonical释放；已移除工位无需继续补绑，不新增故障项。

## Chrome 已恢复的准确边界（不另计入上述四项）

- 重载标记解除后，三条向“介绍ACP含义”的发送仍以 `COMPOSER_NATIVE_INSERT_UNAVAILABLE`、`failed_before_submit` 失败。
- 用户按提示操作后，新消息 `0001795340445888-000655-3d405790` 在 09:40:46 获得真实 Host message ID；09:40:58 的 callback `0001795340458489-000658-83d5642a` 精确回复该 source，证明这一次发送与回传均成功。
- **准确状态是“操作后恢复可用，代码未修”**。输入框选区由外部回到内部，与恢复一致；具体触发原因仍为推断。“结果未知”掩盖明确写入失败也尚未修正。不得登记为“砚砚61 已修复代码”，也不能用这次成功关闭 MCP 读取 429。

## 证据入口

- 历史 API PID94213；银闪启动验收为boot15/PID82768，点点及谱谱gh部署后验收为boot16/PID16180，cwd均为 `cat-cafe-runtime/packages/api`。按各自时间与精确消息 ID 只读复核 API 日志，不把旧进程结果当成新代际观测。
- `.cat-cafe/plugin-host/personal-chrome-host/delivery-ledger.json`：仅用于核对已有发送记录。
- PR #76 / commit `d425e40e7`：原 ACP 重放门的来源。
- 所有实验在临时测试目录或隔离工位完成；未删除数据、重置会话或修改运行配置。
