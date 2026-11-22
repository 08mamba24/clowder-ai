# 2026-11-22 成员链路问题 TODO

- 会话：`thread_owned_5df7c329505b2cd48350dbb88294ebc6ef96de23`
- 原记录：谱谱 / glm-5.3；证据复核：砚砚61 / gpt-6.1-sol
- 更新：2026-11-22；下文时间均为 UTC。
- 接续来源：用户消息 `0001795349271656-000669-42e7567e`。
- Task：`task:work:0001795349706232-000671-8fce4bcd`。

## 四项问题

| 项目 | 当前状态 | 下一步 |
|---|---|---|
| 1. 点点 ACP 续聊失败 | PR #79 修正后已获独立 APPROVED | 宪宪完成合入检查，再由非作者合入；不等同线上已恢复 |
| 2. 银闪启动 canary 失败 | PR #78 已部署，隔离启动与真实回话验收通过 | 本项关闭；其余三项继续按各自条件处理 |
| 3. Pro 读取 429 | 实测复现 OpenAI MCP 隧道 SSE 探测 429 | 外部通道恢复后验证真实工具读取 |
| 4. 谱谱 gh 凭据 | 宿主已登录，隔离 HOME 未登录 | 明确实际权限，再接受控宿主 gh CLI |

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
- **下一步**：交回宪宪执行后续合入检查；批准仅覆盖被审代码，不代表已合入、部署或线上已恢复。1000 raw 行耗尽仍无有效历史时继续 fail-closed；in-memory store 保留自身全局尾部窗口语义。
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

### 4. 谱谱 gh：隔离事实与新授权分开

- **本轮复测**：宿主 `gh api user` 成功，login 为 `08mamba24`；仅切到 zcode 隔离 HOME / XDG_CONFIG_HOME、无 GH 覆盖的子进程中，`gh auth status` 返回未登录。未执行登录、复制凭据或冒烟写操作。
- **代码**：`zcodeAppServerEnv()` 重定向 HOME 与 XDG 目录；`agy-native-launch-env.ts` 有宿主 GH_CONFIG_DIR 接线先例，但别的 carrier 的实现不自动授予 zcode 同等权限。
- **现行边界**：本实例仓库操作走 canonical `gh` CLI。历史 GitHub read MCP 代码不构成继续使用已退役 GitHub MCP 的依据。保留 ZCode 自己的 HOME，按允许的仓库/读写操作接受控宿主 gh 调用，避免把原始凭据散发到模型环境。
- **纠正旧建议**：细粒度 PAT 可以缩小 token 的仓库/权限范围，但仍绑定生成它的 GitHub 用户，不会自动形成独立猫身份。参见 [GitHub 官方 PAT 说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。无需在聊天里发送 token。
- **下一步**：先明确“读什么、是否允许创建 PR/评论”等实际权限，再给出接线和验证。宿主凭据在宿主保管；权限扩张、运行配置或账号登录动作仍按现有边界由 operator 决定/执行。不能把“发一个 token”作为开始定位的前置条件。
- **状态**：环境差异已验证，授权与接线未落地。

## Chrome 已恢复的准确边界（不另计入上述四项）

- 重载标记解除后，三条向“介绍ACP含义”的发送仍以 `COMPOSER_NATIVE_INSERT_UNAVAILABLE`、`failed_before_submit` 失败。
- 用户按提示操作后，新消息 `0001795340445888-000655-3d405790` 在 09:40:46 获得真实 Host message ID；09:40:58 的 callback `0001795340458489-000658-83d5642a` 精确回复该 source，证明这一次发送与回传均成功。
- **准确状态是“操作后恢复可用，代码未修”**。输入框选区由外部回到内部，与恢复一致；具体触发原因仍为推断。“结果未知”掩盖明确写入失败也尚未修正。不得登记为“砚砚61 已修复代码”，也不能用这次成功关闭 MCP 读取 429。

## 证据入口

- 历史 API PID 94213；本轮验收为 boot 15、PID 82768，cwd 均为 `cat-cafe-runtime/packages/api`。按各自时间与精确消息 ID 只读复核 API 日志，不把旧进程结果当成新代际观测。
- `.cat-cafe/plugin-host/personal-chrome-host/delivery-ledger.json`：仅用于核对已有发送记录。
- PR #76 / commit `d425e40e7`：原 ACP 重放门的来源。
- 所有实验在临时测试目录或隔离工位完成；未删除数据、重置会话或修改运行配置。
