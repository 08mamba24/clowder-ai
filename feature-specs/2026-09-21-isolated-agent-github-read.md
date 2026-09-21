---
doc_kind: plan
created: 2026-09-21
feature_ids: [F317, F032]
topics: [github, provider, isolation, authentication]
---

# 隔离载体 GitHub 只读查询 Implementation Plan

**Feature:** F317 / F032 接入补齐；既有授权线见 `docs/plans/2026-09-13-f317-qoder-phase1-proposal.md`，不新分配 F 号。
**Goal:** 谱谱（zcode）与银闪（qoder-flash）在自己的真实会话中，经宿主受控入口自主读取获准仓库的 PR、Issue、差异和 CI 状态，GitHub 凭据继续由宿主持有。
**Acceptance Criteria:** 本计划 AC1–AC7 是新增查询能力的验收；F317 原有 HOME、凭据、Seatbelt、readonly memory 边界继续成立，不把本计划当作原授权线已被修改。
**Architecture cell:** `github-signals`（GitHub 事实查询）、`identity-session`（真实 invocation / provider lease 绑定）。
**Map delta:** update required（随实现 PR 增补两个现有 cell 的 read executor / capability 交界与代码锚点）。
**Map delta why:** 新增主动读取 consumer 及窄认证接线；不新建 cell，不迁移 GitHub credential owner，也不改变 tracking/wake ownership。
**Architecture:** 隔离侧 `gh` 包装器把有限 CLI 请求转换成类型化查询；现有 API 宿主校验窄授权后组装固定的 canonical `gh` argv，并返回有来源、有界的结果。包装器是兼容入口，宿主服务才是权限边界。复用已有 GitHub credential resolution、错误分类和 invocation 终态，不另起后台服务或 GitHub SDK。
**Tech Stack:** TypeScript、Node.js、现有 Fastify API、canonical `gh` CLI、Node test runner；无新外部依赖。
**前端验证:** No；终验需要两只猫本人在新会话执行查询。

---

## 状态与来源

- **本轮交付：实施计划。** 2026-09-21 operator 消息 `0001789954443843-000354-15718ecc`：「不制定计划修改吗」。此消息授权把方案做具体；没有据此宣称两个仓库的读取权限已激活。
- **当前：proposed。** 根因调查完成；认证传输绑定尚需 Task 1 离线验证；生产入口、权限和配置均未修改。
- **执行负责人：小星星 / astra。** 计划内容经独立个体审查后提交；实现涉及安全边界，另走非作者 review、针对性安全测试和 merge gate。
- **已验证事实与建议分开：** 先前宿主登录上下文探针证明认证可用，不证明 Qoder 子进程能逃出继承沙箱；不把探针成功当作产品接通。

| 已读依据 | 支持的事实 / 适用边界 |
|---|---|
| `packages/api/src/domains/cats/services/agents/providers/acp/zcode-acp-protocol.ts`，`zcodeAppServerEnv` | HOME / XDG 配置隔离；不是 OS sandbox |
| 同目录 `zcode-acp-native.ts`、`AcpServiceFactory.ts`、`AcpAgentService.ts` | ZCode app-server、ACP 进程池与每次 invoke/session 的生命周期不同；不能把当前窄凭据永久冻进进程池 spawn env |
| `packages/api/src/domains/cats/services/agents/providers/QoderAgentService.ts`、`qoderSandboxPolicy.ts`、`scripts/qoder-shell-sandbox.mjs` | Qoder 子进程环境白名单、Seatbelt 继承、runtime secrets 最终 deny；已有 per-invocation lease |
| `scripts/guarded-bin/gh` | 当前只针对 verdict PR 发布做 guard，其他参数直接 delegate；不是通用只读授权器 |
| `packages/api/src/infrastructure/github/gh-cli-env.ts`、`github-object-validator.ts`、`packages/api/src/index.ts` | 宿主已有 credential/env 组装、canonical gh 调用与认证/权限/限流错误分类，可复用 |
| `review-notes/2026-09-16-zcode-github-push-credential-security-review-yanyanm.md`；durable 消息 `0001789571523137-000216-3f7e2692` | GH_TOKEN/PAT 注入 agent env 或 session credential file 已被退回；0600 不是同 UID 进程的保密边界 |
| 本 thread 消息 `0001789921667762-000300-c14e5a9f`、`0001789922090416-000317-9f1f4316` | 宿主认证探针及两只猫撤回 token 注入方案；不是新的权限批准 |
| `docs/features/F133-cicd-tracking.md`、`F140-github-pr-automation.md`、`F141-github-repo-inbox.md` | 已有事实采集、tracking、发现管道；主动查询不注册 watcher、不创建任务或唤醒别人 |

## 完成线与范围

AC1. 两只猫均能在真实新会话执行获准的 PR/Issue list/view、PR diff/checks、CI run list/view；结果与同一仓库宿主查询吻合。

AC2. 每次宿主调用都有经服务端绑定的 user/cat/thread/真实 child invocation 与 grant；请求体不能自报身份取得权限。无授权、已结束 invocation、旧 attempt、跨 owner 请求在 spawn gh 前拒绝。

AC3. 未获准仓库、非 github.com 主机、写操作、任意 `gh api` / GraphQL、任意 argv/env/cwd/可执行文件、认证导出都被宿主拒绝。包装器绕过测试直接命中宿主仍然拒绝。

AC4. 不新增 raw GitHub token、通用 callback token、宿主 HOME/config/keychain 到 agent 可读面；Qoder 既有 deny canary 继续通过。不能声称本次解决了 zcode 已存在的同 OS 用户全文件访问问题。

AC5. ZCode warm resume、不同线程并发、取消、完成、进程退出与 API 重启不串用窄授权；Qoder 的 sandbox / MCP 18-tool init 契约保持有效。readonly 路由仍不能因此获得额外 Bash 或家庭 MCP。

AC6. 认证失败、拒绝、限流、未知/空 CI、超时、输出过大与取消有可区分结果；不能把查不到 checks 说成全绿，不能把截断结果说成完整。PR 差异与 CI 附 headSha；查询前后 head 漂移返回 `stale_head`，不能混用不同版本。

AC7. 查询结果正常进入已有会话 transcript；最小审计记录不含凭据。用户可见证据按现有持久化策略保留，TTL=0；短命授权本身是运行能力，不是用户数据，不持久化恢复。

本次不增加 push、评论、review、merge、close、rerun/cancel CI、下载 artifacts、clone、任意仓库内容读取、CI 日志全文、watcher、家庭 MCP 或通用远程 shell。CI 首版范围是状态和 run 元数据；后续需要日志时单独定义有界操作，不能顺手透传 `--log`。

## 权限决策包（计划可先交付，启用前必须有来源）

**推荐：给两只猫补齐工作所需的自主只读查询，继续由宿主持有 GitHub 凭据。**

- **候选范围：** `github.com/08mamba24/clowder-ai` 与 `github.com/zts212653/clowder-ai`；主体为当前获准的 zcode、qoder-flash。停用的 qoder 不因同 provider 自动获得 grant。
- **价值取舍：** 减少 operator / 其他猫代查，优先保持凭据与写权限边界；代价是查询操作集合受限，并需要维护两条载体接线。
- **为何需要 operator：** 新增隔离载体的读取能力，属于 `cat-cafe-skills/refs/decision-matrix.md` 的安全/权限硬排除；现有宿主登录不等于已授权交给所有子进程。
- **批准内容：** 上述主体 × 两仓 × AC1 只读操作集合。不要求 operator 选择技术传输方案。
- **未批准时：** 可写计划、运行假凭据/假 gh 的离线实现与测试；真实 grant 为空，不改 runtime config、不重启服务、不读取新增受控数据面。
- **回滚：** 撤销该能力的新调用准入，撤销在途 grant，丢弃未交付结果；实现可随 PR revert。已有用户 transcript/审计记录保留，已经读取的信息不可“撤回”，因此权限先于启用。
- **批准来源字段：** implementation evidence 必须记录 operator sourceMessageId 与精确范围；本文件不能自行填 `approved`。

## 终态接口与唯一边界

以下名称是拟新增内部类型，非声称已存在的公共 API。传输只能承载该协议，不承载任意 gh 命令。

```ts
type Repo = string; // 服务端规范化 owner/repo 后与 host-owned grant 精确比较
type GhReadQuery =
  | { op: 'pr_view' | 'pr_diff' | 'pr_checks'; repo: Repo; number: number }
  | { op: 'issue_view'; repo: Repo; number: number }
  | { op: 'pr_list'; repo: Repo; state: 'open' | 'closed' | 'merged' | 'all'; limit: number }
  | { op: 'issue_list'; repo: Repo; state: 'open' | 'closed' | 'all'; limit: number }
  | { op: 'run_view'; repo: Repo; runId: number }
  | { op: 'run_list'; repo: Repo; limit: number };

interface GhReadProvenance {
  repository: string;
  operation: GhReadQuery['op'];
  observedAt: string;
  sourceUrl: string;
  headSha?: string;
  truncated: boolean;
}

type GhReadFailure =
  | 'capability_unavailable' | 'scope_denied' | 'invocation_ended'
  | 'unsupported_query' | 'authentication_required' | 'permission_denied'
  | 'rate_limited' | 'not_found' | 'timeout' | 'output_limit'
  | 'cancelled' | 'stale_head' | 'unavailable';

type GhReadResult =
  | { ok: true; data: unknown; provenance: GhReadProvenance }
  | { ok: false; code: GhReadFailure; retryable: boolean };
```

实现时使用严格 schema，拒绝未知字段；所有 number/runId 为正 safe integer，limit 为 1–50。服务端生成结果字段列表，不接受用户提供 jq/template/search/URL/hostname/env/cwd。list 只承诺有界窗口并明确 `truncated`，不循环无限翻页。`data` 在实现中按每种 op 固定返回 schema，不作为任意上游对象泄漏入口。

宿主处理顺序必须固定：**解析严格 schema → 核对窄 grant 与当前 invocation → 规范化 repo/精确 allowlist → 固定 argv/字段 → 有界执行 → 再核对授权仍有效 → 投影/持久审计/返回**。未通过前三项时 fake runner 调用数必须为 0。

- 真实 gh 可执行文件、cwd 和 credential resolver 从宿主启动上下文取得，不能来自请求或 agent PATH；复用现有 `buildGhCliEnv`、`withHiddenGhCliWindow` 和错误分类。通过受验证的 canonical wrapper/delegate 链执行；防止 client 模式递归调用自己。
- 宿主只执行 `execFile` 参数数组，不启动 shell。如需内部 `gh api`，只能生成固定 github.com GET endpoint，不接受调用方 endpoint、header、query 或 GraphQL。
- 网络/credential 环境来自现有宿主 owner；不改全局 GH_TOKEN policy，不创建第二份登录态，不调用 `gh auth token`。错误仅投影 typed code；不回传 env、命令异常堆栈或原始 stderr。
- 默认单次总时限 15 秒、输出上限 1 MiB、每个 grant 最多 2 个在途请求；具体常量可据 fixture 调整并有边界测试，禁止无界缓冲/自动无限重试。
- 兼容 `gh pr view 41 --repo 08mamba24/clowder-ai` 这类常见入口。显式 `-R/--repo` 必须唯一且与 URL/位置参数无歧义；第一版拒绝 URL 形式。无 repo 时明确失败，不让 gh 自选 upstream。
- 只给 query-enabled 载体启用翻译模式；无 query grant 或协议失败时 fail closed，禁止自动回退到宿主认证命令。其他载体现有 wrapper 行为需回归验证。

## Task 1：认证传输接缝验证（有界离线 Spike，先于冻结实现）

**时间盒：30 分钟代码/假载体验证；产物是本节内的接线决策与测试证据。** 不运行真实 zcode/qoder 计费调用，不修改生产配置，不发新网络服务。

**Read / 拟修改定位：**
- `packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts`
- 同目录 `InvocationRegistry.ts`
- `packages/api/src/domains/cats/services/types.ts`
- `packages/api/src/domains/cats/services/agents/providers/QoderAgentService.ts`
- `packages/api/src/domains/cats/services/agents/providers/acp/AcpAgentService.ts`、`AcpServiceFactory.ts`、`zcode-acp-native.ts`

1. 复用 `invoke-single-cat` 宿主注入的 `auditContext.invocationId`，并与 `InvocationRegistry` 的真实 child record 对齐：当前代码创建 child 后将同一 id 写入 callbackEnv 与 auditContext。`executionId` / `parentInvocationId` 和请求体自报 id 都不能替代该授权身份。不复用通用 callback endpoint 或把 callbackPrincipal 权限下放。
2. 优先将新窄路由注册到现有 API listener，注入独立的 GhRead capability validator。窄凭据在宿主 mint，能力域只允许本计划 schema；不能由它派生通用 callback/agent-key principal。
3. 验证 Qoder sandbox 子进程能到达当前服务的窄入口，同时宿主 HOME、runtime secret、其他 API 能力仍被拒绝。现有网络允许不能代替入口鉴权；只测试本服务隔离 listener。
4. 验证 ZCode 每次 invoke / loadSession / warm resume 如何取得新窄 handle，旧 attempt 撤销后不能读取新的 handle。不能仅覆盖一个跨会话共享文件，也不能把 token 永久放进 pool spawn env；不为省接线顺手改变全家 ACP 退池策略。
5. 同 UID 的 file/env 本身不保证跨进程保密。若方案依赖这一假设，判失败。记录能力凭据对模型可见的范围、泄漏后的最大权限，以及能否证明调用的真实 session/attempt。
6. 用假 ACP app-server + 假 shell/runner 完成 active→end→resume、双线程、旧 handle 重放；把选定的传输位置、grant 交付位置、撤销 owner 与 exact child identity 写回本节，再执行 Task 2–5。

**证据门：** 假 ACP 只能验证我们自己的生命周期实现，不能证明 ZCode 原生协议存在所需交付缝。选定 seam 必须引用当前 native binary/version 对应的源码、协议或已捕获真实 trace；fixture 必须复现该真实契约，不得自行发明参数让 fake 变绿。离线证据不足时记录 unresolved；新的真实采样另按既有探针授权执行，不把 fake 绿当 implementation-ready。

**停止判据：** 如果现有 ZCode app-server 无法提供每次 invocation 的隔离交付缝，不伪造“逐 invocation 安全”。技术问题先在当前 reviewer 间收敛；只有需要扩大 OS/权限模型时才给 operator 带有证据的新 Packet。传输选择未解决前，不把该计划标为 implementation-ready。

## 生命周期普查、状态转移与不变量

| 对象 / 唯一 owner | 状态 × 事件 | 必须发生的迁移 / 禁止旁路 |
|---|---|---|
| 宿主读取授权 / host policy owner | absent + 无批准；approved + 撤销 | absent 始终不 mint；撤销使新准入失败。配置导入、provider 同族、cat 启用不能自动复制授权 |
| Query grant / 新窄能力服务 | absent → active：真实 child invocation 启动且 policy 允许 | 绑定真实 user/cat/thread/invocation、provider lease/attempt 与批准来源；请求体不能 mint/改 scope |
| Query grant / 新窄能力服务 | active + invocation end/cancel/lease release → revoked | 先撤销再释放 provider；旧凭据再调用拒绝，不按新会话身份刷新旧 handle |
| API 内存 grant / 新窄能力服务 | restart/crash → absent | 不从临时文件、pool、resume session 恢复权限；新 invocation 重新准入 |
| 单次 query / read executor | admitted → running → returned/failed/cancelled | 子进程、timer、输出缓冲都归该请求；取消/撤销后终止本请求子进程并禁止晚结果；不杀父进程、不全局 kill gh |
| 请求与撤销竞态 / read executor | executing + revoke；output ready + revoke | 返回前复核 active grant；已撤销则丢弃未交付结果并写 typed terminal，不把晚结果移交新 invocation |
| ACP process/session / 现有 pool owner | warm load、并发 lease、process exit | 窄授权消费 lease 真相，不另存第二个“当前猫”；不能延长 grant 到 pool idle TTL |
| 审计与结果 / 现有审计和 transcript owner | query terminal → append | 保存身份、repo/op、时间、head/terminal，不保存密钥；append 失败不得伪称证据已落盘；不新建结果缓存或 TTL |

| 不变量 | 对抗验证 |
|---|---|
| INV1 身份服务端绑定 | 伪造 cat/thread/parent invocation、跨 user、无当前 lease均拒绝 |
| INV2 能力只能读既定两仓与操作 | 绕过 CLI 直接请求写操作/其他仓库/任意 endpoint；runner=0 |
| INV3 不转交 GitHub/通用 callback 凭据 | agent env/file/transcript 与返回值泄漏探针；同 UID 误用测试，不能仅检查 mode=0600 |
| INV4 权限不跨 invocation 复活 | 取消、done、crash、warm resume、双线程与旧 handle 重放矩阵 |
| INV5 保留载体原边界 | Qoder HOME/secrets/git canary、18-tool init；ZCode personal HOME 不变、不挂家庭 MCP |
| INV6 执行与结果有界且归正确版本 | 超时、输出超限、并发上限、cancel race、PR head 漂移；检查缺失 ≠ pass |
| INV7 用户证据持久、权限不恢复 | append 失败显式失败；restart 清空运行能力但不删除用户 transcript/审计 |

## Task 2：先红后绿实现宿主查询内核

**Create:** `packages/api/src/infrastructure/github/agent-github-read.ts`、`packages/api/test/agent-github-read.test.js`。
**Reuse:** `gh-cli-env.ts`、`github-object-validator.ts` 的公共错误类型/分类与宿主 credential getter。

1. 新建 fake runner，写 INV2/INV3/INV6 的拒绝、精确 argv、schema 和版本漂移测试。
2. 运行下面命令确认新增测试为红（尚无实现），记录真实失败，不用生产认证复现。
3. 实现严格 query schema、固定命令 builder、bounded executor 和每 op 返回投影；agent 输入不能透传到环境/路径。
4. 同一命令转绿；检查每个 rejected case 的 runner 次数为 0。

```bash
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api build
node --test packages/api/test/agent-github-read.test.js packages/api/test/gh-cli-env.test.js packages/api/test/github-object-validator.test.js
```

**留在终态的产物：** 唯一宿主读取内核。删除这步会让 CLI 成为权限边界，因此必需。

## Task 3：窄授权、现有 API 路由与生命周期

**Create:** `packages/api/src/infrastructure/github/agent-github-read-capability.ts`、`packages/api/src/routes/agent-github-read.ts`、`packages/api/test/agent-github-read-capability.test.js`、`packages/api/test/agent-github-read-route.test.js`。
**Modify:** `packages/api/src/index.ts`、`packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts`、`packages/api/src/domains/cats/services/types.ts`；只在 Task 1 选定接缝处增加 capability 依赖。

1. 用隔离的 registry/policy/store 与 fake gh 写 INV1/INV4/INV7，尤其真实 child 与父 invocation 不等、旧 handle 不能刷新、撤销与响应竞态。
2. 构建 API 后跑新测试确认红，再实现薄路由、host mint/revoke 和 terminal 审计。
3. 不把新路由塞进原 callback auth hook；不把 grant scope、认证键写入公共 schema/日志。
4. API restart、provider crash、warm resume、并发、late output 均通过后才接 CLI。

```bash
pnpm --filter @cat-cafe/api build
node --test packages/api/test/agent-github-read-capability.test.js packages/api/test/agent-github-read-route.test.js packages/api/test/invocation-registry.test.js
```

## Task 4：原 gh 入口与两种载体接线

**Create:** `scripts/lib/agent-github-read-client.mjs`、`scripts/agent-github-read-client.test.mjs`、`packages/api/test/acp/zcode-github-read.test.js`。
**Modify:** `scripts/guarded-bin/gh`；Qoder/Acp 路径按 Task 1 已证接缝改动；`packages/api/src/config/env-registry.ts` 仅在引入新的 `process.env` 名称时同步注册，operator runtime config 保持人工管理。

1. CLI 翻译测试先红：合法子命令；重复 repo、URL、缺 repo、未知 flag、写命令、`auth token`、`api`、`--hostname`、delegate env 注入一律拒绝。
2. 接 client，使其他猫现有 wrapper 行为保持既有语义；query-enabled caller 请求失败不得走原生认证 fallback。
3. Qoder 只带窄能力所需上下文；zcode 使用 Task 1 的每次 invocation 交付，不向 pool 冻结密钥。
4. 验证 INV3/INV4/INV5 全矩阵。失败优先修真实 owner / 接缝，不新增层层 fallback。

```bash
pnpm --filter @cat-cafe/api build
node --test scripts/agent-github-read-client.test.mjs packages/api/test/acp/zcode-github-read.test.js packages/api/test/acp/zcode-acp-native-lifecycle.test.js packages/api/test/qoder-agent-service.test.js packages/api/test/qoder-l2-tool-surface.test.js packages/api/test/qoder-memory-policy-sandbox.test.js
```

## Task 5：合并与真实会话验收

1. 更新两个 ownership cell 的实现锚点、F317 查询补充说明与 operator 的实际授权来源。按已加载 `worktree` / `tdd` / `quality-gate` / `merge-gate` 的风险车道执行，不把本计划批准代替代码 review。
2. 本功能触碰安全和跨载体边界，要求非作者审查覆盖最终代码；运行目标测试、类型检查和规定门禁。实现阶段命令真相源为当前 `package.json`，已核实格式命令：`pnpm biome format --write <本次实际代码文件>`；终态 `pnpm check`、`pnpm lint`。本轮只是 Markdown，不运行这些代码门禁。
3. 仅在隔离 feature checkout 测未合并代码；合并后的 acceptance 使用独立数据/端口。拒绝生产 Redis/SQLite、现有 thread 数据作为测试夹具。
4. 获得范围批准与 operator 的 runtime 激活窗口后，由 operator 管理配置/重启；不执行自动 `pnpm stop` 或改启动配置。
5. 谱谱与银闪各自真实新会话查询同一个指定 PR、Issue、diff、checks/run；宿主读同一对象对照，记录 observedAt/head、调用来源与负向拒绝。再验证 warm resume/取消后的授权失效；不能只由小星星代跑。
6. 附代码 SHA、PR、独立 review、离线红绿、隔离 acceptance、真实本人自测与授权 source。全部 AC 满足才标 done；代码合入与 live 验收分别记录。

## 本轮内容验证与交接记录

- Plan content review：2026-09-21 独立实例 `/root/gh_read_plan_review`（gpt-6-astra，非作者）完成正文审查：0 P1、2 P2；按原建议修正 child auditContext 事实和 native seam 证据门后，放行 proposed 计划交付。此 verdict 不放行认证实现或真实权限激活。
- Markdown 检查：提交前运行 `node scripts/check-frontmatter.mjs --strict-delta --base origin/main --docs-root feature-specs` 与 `git diff --check`。
- 文档交付：普通 proposed plan，未修改执行规则/权限配置；只暂存此文件，main 单 commit + push，不混入既有未跟踪 review-notes。
- 下一执行项：Task 1 离线接缝验证；范围批准与 runtime 启用不是该离线步骤的前置，不能再用“尚待拍板”阻塞可做的准备。
- 本次偏差修正：把“已答完根因”误当成“已处理修复意图”，导致只有口头建议、没有落盘计划。当前范围内已把权限包、技术未知、红绿步骤与交付状态分别写实；完成计划不再表述为完成修复。

[小星星/gpt-6-astra🐾]
