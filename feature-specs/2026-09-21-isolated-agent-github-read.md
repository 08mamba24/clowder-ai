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

- **任务来源：** 2026-09-21 operator 消息 `0001789954443843-000354-15718ecc`：「不制定计划修改吗」；后续 `0001789955401202-000363-924099ab`：「需要我决策什么？真的需要我决策吗？」。结合此前两仓只读修复讨论，按现有任务授权继续调查、实现、review 与隔离验收，不再把相同范围送回 operator 重复确认。后一句是对不必要升级的纠正，不伪造为一条新权限批准事件。
- **当前：实现与针对性隔离验证完成，准备独立 review；尚未合并、未启用到 runtime。** 两条载体共享宿主严格查询内核。ZCode 当前安装 native 的合成模型/HTTP-MCP canary 已验证真实调用和 cold resume；Qoder 已验证真实 Seatbelt 拒读凭据、HTTP 受控查询及原 readonly memory 初始化。AC1 的猫本人新会话终验仍待合并与授权激活。
- **持久任务：** `0001789956139661-000388-6c663874`（本 thread，owner=`astra`，doing）；实现分支 `feat/agent-github-read`，worktree `../cat-cafe-agent-github-read`。旧 PR #41 属于已完成的 umid 修复，不承载本任务。
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

## 当前执行范围与真正的升级边界

**当前没有待 operator 决策的技术选项。继续补齐既定工作范围的自主只读查询，GitHub 凭据仍由宿主持有。**

- **本次任务范围：** `github.com/08mamba24/clowder-ai` 与 `github.com/zts212653/clowder-ai`；主体为 zcode、qoder-flash；操作为 AC1 只读集合。停用的 qoder 不因同 provider 自动获得 grant。
- **价值取舍：** 减少 operator / 其他猫代查，优先保持凭据与写权限边界；代价是查询操作集合受限，并需要维护两条载体接线。
- **猫猫负责：** 在上述任务范围内选择实现接缝、补测试、完成跨个体 review、合并和隔离验收。安全 review 是工程责任，不能替换成让 operator 重答“要不要修”。
- **需要新决策的触发条件：** 新增仓库或主体、增加 GitHub 写操作、交给 agent raw credential、放松 HOME/Seatbelt/readonly memory 隔离，或引入新外部依赖/显著成本。届时提交已查证的必要性与具体替代方案；当前没有证据表明需要这些变化，不预设审批。
- **实现未通过前：** 真实 grant 不启用，使用假凭据/假 gh 验证。这是未实现/未验收的状态，不是任务缺少 operator 授权。
- **runtime 操作：** 根目录 `AGENTS.md` 明确 runtime config 变更必须由人操作，且不得修改自身启动配置/终止父进程。若最终激活确实需要这些动作，先完成代码与验收，再给 operator 精确版本、命令与影响窗口；不把上线操作提前包装成设计决策。
- **回滚：** 撤销能力的新调用准入及在途 grant，丢弃未交付结果；实现可随 PR revert。用户 transcript/审计保留；已读信息不可撤回，所以严格限定既定范围。
- **来源记录：** implementation evidence 引用以上原始任务消息与实际执行范围，不制造一个不存在的新 `approved` 事件，不因同账户登录而向其他猫自动开放。

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

**2026-09-21 首轮接缝核对（只读，未做原生能力缺失断言）：**
- `zcode-acp-native.ts` 在 `NativeAppServer` 构造时一次性 spawn 并设置 env；不是逐 prompt 设置。
- `zcode-acp-adapter.ts` 的 `handleSessionNew` 目前发送 workspace/mode/persistence；`handleSessionPrompt` 发送 sessionId/content，并按 session cancel generation 处理取消。当前适配层未传逐轮 shell env/窄 handle。
- 本进程 `command -v zcode` 无结果；仓内 `zcode-0.16.3-fixtures.mjs` 说明样本始于 0.16.3、模型项包含 0.16.5 更新。因此它们不能证明当前安装原生版本的能力全集。
- 结论：排除“只在池 spawn env 里加凭据即可”的方案；原生 per-attempt 交付路径仍需从 runtime 实际 executable 的代码/协议定位，属于猫猫的技术调查，不转交 operator 选方案。

**2026-09-21 安装原生程序核对与离线反证（Session #4）：**

- 样本：`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`，SHA-256 `8f5cfccf2a899b92e57bc2a5760b949c1a928f739652fffc9e6d07c24f11ba05`；应用 bundle `3.14.0 / 3.14.0.7681`。应用版本不冒充 CLI semver。这是 `resolveZcodeBin` 的 macOS 默认候选；本次进程检查未捕获在跑的 native app-server，尚不能证明 runtime 无 override 或下轮一定使用此 hash。
- 原生 schema：`dHt`（create）、`pHt`（resume）、`wHt`（send）均 `.strict()`，没有 `env` / `shellEnv` / `githubReadHandle` 字段；create/resume 实际含 `mcpServers`，不能沿用“原生没有 MCP”这一缺证断言。`wHt` 也没有逐轮 MCP 刷新字段。
- 调用链：`_Go → rKa` 只传原生 send schema 的既定字段；`_Pn → SKa` 以 `e.deps.env` 创建 session runtime，`lxt` 才把 create/resume 的 MCP 条目投影为 runtime config。`dPn` 在 warm session 已存在时直接返回旧 record，不重新执行 `_Pn`；因此“每次 resume 重传新 mcpServers 即刷新授权”不成立。
- shell 候选：`SHt.integratedTerminalShell → FZe → yKa → vKa → zte` 看似能传路径，但 `FZe` 的 shell dialect 仅 `cmd | git-bash`；`yKa` 标为 `source=user-config`，`$ss` 不采纳该 source，macOS/Linux 的 `Vss` 从宿主 env 选 shell，未消费 override。另有 `createApp` 的 `gr ??=` 缓存与 `initializeSessionShellEnvironmentIfNeeded`，不能把 runtime-preferences 请求误当成逐 prompt 刷新缝。
- 离线执行：从该原生文件提取函数到 Node `vm`，以假值运行 **12 项断言通过**：三份 schema 各拒绝三种未知顶层字段（9）；darwin/linux 均忽略 `/fake/per-attempt/bash` override、实际选 `/bin/zsh`（2）；warm resume 在传入新假 MCP env 时仍返回旧 record、未重物化（1）。执行命令为本次工具事件中的 `node <<'JS'`；依赖本仓 `packages/api/node_modules/zod`。schema 的嵌套依赖用 `z.unknown()` 占位，故只证明顶层拒绝；函数提取执行也不代替真实 app-server 端到端验证。没有启动原生进程、计费模型、网络 listener 或真实凭据查询。
- **Task 1 尚未通过。** 上述断言是排除候选接缝的反证，不是 active→end→resume / 双线程 / 旧 handle 重放矩阵通过。暂不冻结 Task 3–4 载体接线；Task 2 可先用 fake runner 独立实现，不能把尚未解决的一处接线扩大成所有工作的停止条件，也不把“静态未找到”扩大成“所有安全方案都不可能”。
- **技术复核的具体选择：** 优先判断只调整 ZCode 自身 carrier/attempt 生命周期，能否保留既有 `gh` 入口并让每轮 handle 不被旧 attempt 获得；必须覆盖后台 shell、取消和 cold resume。原生 session MCP 是另一个已存在的接口，但与 `gh` 兼容和原生 warm record 更新均未解决，不能直接把家庭 MCP 接回去或把工具身份当成逐轮身份。当前不提议扩大仓库/主体/写权限，也不要求 operator 选择这些技术接缝。

复核时以 **上述 binary hash + 原生函数/变量符号 + 本仓 adapter/pool owner** 为证据坐标；不用旧 0.16 fixture 的绿灯替代。接线定案后仍须补假载体完整生命周期矩阵并通过独立安全 review，才继续真实启用。

**复核与继续执行（2026-09-21）：** 谱谱 / zcode 在消息 `0001789956244328-000397-47e307f0` 放行文档 SHA256 `4107851e0f9855eab598e7f2ca65e0d01a48d40d27fdfa3645edad04c3b6d18d`，确认原生排除项，并要求输出有界、硬超时、禁 TTY。宿主持有 GitHub 凭据与猫侧窄请求身份是两个问题；前者确定不代表后者已验证。operator 消息 `0001789956478203-000401-50d7f79c` 要求继续推进；执行人恢复球权，先实现 Task 2 独立内核，继续解决 Task 1，不把文档 review 当工程暂停理由。

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
4. 完成代码 review 与隔离验收后，按既有部署通道交付已验证版本。若当前服务激活需要人工配置/重启，由 operator 按精确操作单完成；不重新询问既定两仓只读修复范围，也不自行执行 `pnpm stop` 或改启动配置。
5. 谱谱与银闪各自真实新会话查询同一个指定 PR、Issue、diff、checks/run；宿主读同一对象对照，记录 observedAt/head、调用来源与负向拒绝。再验证 warm resume/取消后的授权失效；不能只由小星星代跑。
6. 附代码 SHA、PR、独立 review、离线红绿、隔离 acceptance、真实本人自测与授权 source。全部 AC 满足才标 done；代码合入与 live 验收分别记录。

## 本轮内容验证与交接记录

- Plan content review：2026-09-21 独立实例 `/root/gh_read_plan_review`（gpt-6-astra，非作者）完成正文审查：0 P1、2 P2；按原建议修正 child auditContext 事实和 native seam 证据门后，放行 proposed 计划交付。此 verdict 不放行认证实现或真实权限激活。
- 本次授权语义一致性复审：同一独立 reviewer 确认 0 P1、0 P2，既有任务承接、人工 runtime 操作与技术验证已分开；未扩大 scope 或移除安全验收。
- Markdown 检查：提交前运行 `node scripts/check-frontmatter.mjs --strict-delta --base origin/main --docs-root feature-specs` 与 `git diff --check`。
- 文档交付：实施计划与调查证据，未修改执行规则/权限配置；只暂存此文件，main 单 commit + push，不混入既有未跟踪 review-notes。
- 当前执行项：Task 1 接缝验证已开始；既定修复范围不重复审批。技术结论由猫猫负责，真实上线操作仅在可执行版本就绪后按需交人。
- 本次偏差修正：把“已答完根因”误当成“已处理修复意图”，导致只有口头建议、没有落盘计划。当前范围内已把执行范围、技术未知、红绿步骤与交付状态分别写实；完成计划不再表述为完成修复。
- 第二次纠正：把既有任务授权、代码安全审查和 runtime 激活混成一个笼统“待批准”，又让 operator 做路由器。已扫描并修正状态段、范围段、Task 5 与交接段；未把技术未知或尚未上线当成新的人类决策。
- 重复偏差证据：`docs/features/F167-a2a-chain-quality.md` Case E22；不新增 SOP/审批规则。

## 2026-09-21 实现接线与可重跑证据

Architecture cell: github-signals / identity-session
Map delta: updated in both existing cell docs
Why: add a query consumer; reuse canonical invocation authority without transferring credential ownership
Canonical source: `InvocationRegistry.ts#verifyLatest` / `repairFromCanonical`; existing host canonical gh auth store
Consumer evidence: `rg -n 'openGitHubReadLease|AgentGitHubReadBroker' packages/api/src` identifies index → AgentRouter → invokeSingleCat → ACP/Qoder only
Claim guard: canonical child changes/ends → `agent-github-read-capability.test.ts` rejects before spawn; revoked during query → result withheld; shell config read → real Seatbelt denies

- **8 操作内核**：strict schema、固定 argv/字段、两仓 allowlist、每 grant 两个在途、15s/1MiB 总预算、PR head/base 双探针；超时/取消回收 wrapper 后代。结果与审计不回传 stderr 或 credentials。
- **ZCode**：使用 native create/resume 的 HTTP MCP header；仅一个 `github_read` 窄工具。每次 ACP lease retire，cold resume 持久历史，禁止 warm record 复用旧 header。跳过不需要的通用 callback credential 文件生成。安装原生 canary 使用前述 hash 的 binary、合成 Anthropic 响应与隔离 HTTP MCP，验证两轮实际工具调用、历史恢复、header 轮换及模型请求/日志/SQLite/WAL 无 token；它不冒充猫本人线上终验。
- **Qoder**：原 18-tool 初始化契约不变。shell-prefix 完整 literal argv 翻译；窄 bearer 在 lease root 的 0600 文件，位于 scratch 外，既有 Seatbelt deny 生效。结束先撤销 grant 再清理短命 lease。普通 shell 子进程移除 config path，nested gh 拒绝自动 delegate。
- **宿主认证收敛**：本入口只复用宿主 gh 已有认证存储；不注入 raw GH_TOKEN/GITHUB_TOKEN，不创建新的 token 文件。仅 plugin/env token 而未登录 canonical gh auth-store 的部署返回 authentication_required，需要由 operator 完成既有 gh 登录；不修改全局 GitHub token policy。现有 ZCode 同 UID 全文件面不在此项内声称已解决。
- **测试**：API build；`pnpm exec tsx --test test/agent-github-read*.test.ts test/acp/zcode-github-read-carrier.test.ts`；Qoder service/readonly-memory real Seatbelt tests；`node --test scripts/agent-github-read-client.test.mjs`；`CAT_CAFE_ZCODE_LIVE=1 node --test test/acp/zcode-github-read-native.test.js`（该 test 只访问自身隔离合成 server）。
- **完成线**：AC2–AC7 有实现与针对性隔离证据，仍需 review/full gate；AC1 必须两猫在已激活的新会话查询两仓并与宿主事实核对。未改 runtime config、未重启生产、未碰生产数据。

[小星星/gpt-6-astra🐾]
