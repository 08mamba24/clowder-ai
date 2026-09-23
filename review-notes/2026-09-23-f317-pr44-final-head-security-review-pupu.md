# F317 PR #44 final-head security review（云端 EYES=0 的 fallback）

- **Reviewer:** 谱谱 / zcode（glm-5.3）——非作者独立个体、跨族（Ragdoll/zcode vs 作者 GPT/astra）；未写过本 PR 任何代码。
- **Subject:** 08mamba24/clowder-ai#44 @ `0401bf440511374d9139d75edbfd0bf271899453`（请求来源：砚砚6 / cat-3wffwdg9，2026-09-23 @zcode review request）。
- **参照：** code-bearing 已审 HEAD `bc837cd72`；frozen base `0d161361c`（PR #42 merge）；本地实现 review 砚砚6 APPROVE（durable fact `local-review:0001790150636598-000148-085142b7:approved`）；云端 context-blind 扫描两次触发评论 5791310942 / 5791421229 EYES=0，本 review 为声明的 fallback。

## Verdict

**APPROVE — 安全 review 通过。P1=0，P2=0，P3=1（不阻塞）。**
Merge gate 仍按既有流程另需 CI 绿（评审时 `0401bf440` 的 checks 全部 IN_PROGRESS）；AC1 两猫新会话 live 终验保持开放，PR 未声称关闭。

## HEAD 前进核验（bc837cd72 → 0401bf440）

- `git diff --name-only bc837cd72..0401bf440` 仅 `feature-specs/2026-09-21-isolated-agent-github-read.md`，4+/4-；`git diff --check` 两段范围均干净。生产代码/测试与已审 HEAD 逐字节一致——请求中的说法属实。
- 4 行内容逐一读过：状态段改为「PR #44 已有完整门禁与非作者 review 证据、合入/验收/激活/重验待完成」、worktree 名修正为 `../cat-cafe-qoder-github-live`、持球人改为砚砚6（co-creator 移交消息 `0001790151559613-000172-09d19e58`）、2026-09-21 完成线标记为历史记录。与 PR body 一致，无过度声称。该 commit 作者为砚砚6（bc837cd72 的实现 reviewer）——docs-only 且内容经本 review 核对，final-head review 连续性以此补齐。
- 修复 worktree `../cat-cafe-qoder-github-live` 当前 clean、HEAD=`0401bf440`、与 origin 同步。

## 独立核验的证据（本机复跑，非转述）

1. `git fetch origin pull/44/head`；commit 线性：`1118454a4`(code, astra) → `bc837cd72`(test, astra) → `0401bf440`(docs, 砚砚6)。
2. 通读 HEAD 全文 `QoderAgentService.ts`（1180 行）：lease 顺序 = open → 写 0600 mcp-config（lease root，scratch 外）→ 真实 sandbox probe → spawn；`finally { revoke() → dispose() }`；read_only 策略把 `toolAccess` 判为 disabled，`openGitHubReadLease` 物理不可达；`expectedInit`/`buildQoderArgs`/recorder `declaredServerNames` 同源于 `githubReadLease` 单一变量；init 门对 tools/mcpServerNames 精确全等 + 全部 connected + model 精确匹配，未过门前任何 assistant/user 事件即断流（fail closed）；token 只存在于 config 文件，不进 env/argv/prompt。
3. `agent-github-read-capability.ts`：构造强制 loopback http（127.0.0.1/[::1]、无 userinfo）+ 固定 mcpUrl；open 仅 ENABLED_CATS（zcode/qoder-flash）+ owner userId；43 字符随机 token 以 sha256 键存储；query 前后双次 principal 重验；成败均审计；同 invocation 旧 grant 先 revoke。
4. `routes/agent-github-read.ts`：`onRequest` 钩子对含 `/mcp` 全路由先 `broker.authenticate`，401 返回泛化 `capability_unavailable`（无 oracle）；MCP 只注册 `github_read` 单工具、zod schema 前置（写操作 schema 层死亡，runner 不触发）；bodyLimit 16KB；无状态 transport。
5. `scripts/guarded-bin/gh`：readonly 模式仅放行 `args.length===1` 的 `--version`，其余 exit 1 指向 MCP 工具；host 侧 verdict-publish guard 分支未动。
6. `scripts/qoder-shell-sandbox.mjs`：shell-prefix 翻译路径整体移除；一切 shell（含 native envelope）进 Seatbelt；`CAT_CAFE_GITHUB_READ_ONLY=true` 无条件注入；policy 选择按单 shell 词精确匹配。
7. `git grep` 确认生产代码零悬挂引用（`agent-github-read-client` / `CAT_CAFE_QODER_GITHUB_READ_CONFIG` / `github-read.json`）。
8. clean worktree @ `0401bf440` 复跑：`node scripts/check-feature-truth.mjs` PASS；`node --test scripts/qoder-shell-sandbox.test.mjs` 2/2 通过。
9. 门禁日志 `/tmp/f317-qoder-native-6sol-gate.log` 存在（5.4MB），尾部 test 1209s + lint/check 208s 通过。全量 gate 未由本人复跑——以 GitHub CI 对同一 tree 的结果为准。

## Findings

- **P1：无。**
- **P2：无。**
- **P3-1（不阻塞，验收项）：** 真实安装的 qoderclicn 1.1.51 上，「双 server（cat-cafe-memory stdio + clowder-repository-read http）+ 精确 19 工具」的 init 契约与 model-driven `tools/call` 未被直接证明——`probe-http-mcp.mjs` 只覆盖单 HTTP server 形态，service 级 19-tool 断言用的是合成 fixture。安全影响为零（init 门对任何漂移 fail closed，先于模型内容），但若厂商 CLI 对多值 `--allowed-mcp-server-names` 或混合 config 有异议，激活后 granted 调用会硬失败（可用性而非越权）。PR body 已如实声明此边界；由合并后 qoder-flash 新会话验收关闭。

## 边界记录（非 finding）

- 本 review 覆盖 carrier 生命周期与项目契约语义；云端 context-blind bearer/isolation 扫描两次 EYES=0，无结果回流，按 PR body 声明由本 fallback 承担。
- 评审时 CI pending；merge gate 需自行等待 CI 绿，不因本 APPROVE 豁免。
- F167 disposition：本 carrier 会话无 `CAT_CAFE_API_URL`/`CAT_CAFE_INVOCATION_ID`/`CAT_CAFE_CALLBACK_TOKEN`，`cat_cafe_complete_a2a_dispatch` 不可达，无法落结构化 disposition；verdict 以本 note（commit 进 main）+ 回复内 @砚砚6 交还球权为凭。

[谱谱/glm-5.3🐾]
