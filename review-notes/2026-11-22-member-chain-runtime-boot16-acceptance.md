# 成员链路：runtime boot16 部署后验收

记录人：砚砚61 / gpt-6.1-sol。时间：2026-11-22 UTC（本地2026-11-23），承接16:09部署回调。原父Task `0001795349706232-000671-8fce4bcd`，线程 `thread_owned_5df7c329505b2cd48350dbb88294ebc6ef96de23`。

## 结论

#79 点点续聊和 #80 谱谱受控 gh **只读**通道已部署并通过真实入口验收；#78 银闪此前已通过。四项中只剩 Pro 外部 MCP 隧道429。没有把构建、Alpha通过或模型自述单独当成线上恢复。

## 部署真相与实际构建

原 generation3 回调 `0001795363785384-000000-6b339a19` 的 waitOutcome 已回读为 matched/delivered。`http://127.0.0.1:3004/health` 实测 status=ok、deploymentRevision=`61f95378fe805ec0d15b338190b6282fada324c1`、bootId=`90313d9d-963a-4b19-bc92-3497a61e729f`、sequence=16；服务PID16180的cwd是 `cat-cafe-runtime/packages/api`，启动于16:09:24 UTC。Git ancestry确认该revision包含冻结 #80 合入 `39534073ff190b67d455269d30938e830f5429cf`，并包含 #79 合入 `10dd3dc20ce9a734e3451250d49c665b3634bfaf`。

实际runtime下列产物与已验收Alpha字节完全相同，mtime早于新API启动；根wrapper与实际MCP分发wrapper也相同。

| runtime产物 | SHA-256 |
|---|---|
| packages/api/dist/domains/cats/services/agents/routing/incremental-rebuild-replay.js | `3dc0052a6ec9c017b0c4e10cd221034c356ba7aff45dbd7e4f2386e49b0625a3` |
| packages/api/dist/domains/cats/services/agents/invocation/invoke-single-cat.js | `53379e2f5af66857b70f1ada8faf25263b605575e87e075ba766f4117013061e` |
| packages/api/dist/domains/cats/services/agents/providers/acp/zcode/zcode-acp-adapter.js | `a36579dd7f66c545af889246004d583d78e62c75b7607f1ef5b9d5dc598a16ed` |
| packages/api/dist/domains/cats/services/agents/providers/acp/zcode/zcode-github-read-lease-file.js | `e8a5d198e27f6e172e542d99f1761e1e9a3f861ab9f3cdf7b59461f6b91f2072` |
| packages/mcp-server/dist/runtime/scripts/guarded-bin/gh | `1ce0f12c90b9c4583375a1b82e63d5cd246d05f9ca60063fe4644a895d3e9769` |

## 本轮隔离执行

直接对已部署runtime构建运行，未重建或改写正在使用的dist；canonical `with-test-home.mjs` 使用临时HOME、隔离测试数据与不可连接Redis。

```
node packages/api/scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 test/native-acp-incremental-rebuild-route.test.js test/native-acp-rebuild-route.test.js test/context-assembler.test.js test/acp/zcode-acp-adapter.contract.test.js test/acp/zcode-github-read-carrier.test.js test/acp/zcode-github-read-lease-file.test.js
```

Node24.22.3；**98/98，0 fail/cancel/skip，exit0**。另运行原独立双adapter探针，仅把checkout路径替换成runtime，真实service/broker/adapter、无模型fixture：同HOME各自lease、重叠期和B退出后A均按A审计、load清除/恢复、native MCP=[]、run_list/checks、实际目录清理均通过，exit0。

- `/tmp/20261122-member-chain-runtime-boot16-tests.log`：SHA-256 `4640e71eb40773514f05013c8141757cc15167c186cbcfc04a3ef68dcf28cb8d`。
- `/tmp/20261122-pr80-runtime-boot16-adapter-probe.mjs`；`/tmp/20261122-pr80-runtime-boot16-adapter-probe.log`：SHA-256 `a758de7bd1c6467d2041e3f99d2cbdca99c2109f27868974f47e174291081b03`。

## #79 点点真实续聊

只派一次正常续聊确认，source=`0001795363935027-000002-20eda3b8`，invocation=`606e010b-f59b-4d43-af38-e38df987a8f2`。持久回复 `0001795363935129-000004-1dd38bb6` 精确replyTo该source、catId=dsh-v41-flash，正文为“收到”。已读完整消息，运行态已结束。

实际PID16180 API日志 `packages/api/data/logs/api/api.2026-11-23.2.log` 按该thread/cat/invocation核对：16:12:17.873 UTC从原旧session `d5923e1e-de35-4071-853f-cec634d000f2` 进入无resume能力的显式replacement分支；重放校验未报错，新session=`24be81ee-7910-42f1-bd6d-f0624a954395`，16:12:21.008 UTC promptStream completed/eventCount=1。没有省略旧session、重置历史或绕开fail-closed门；这是原故障入口的成功续聊。

## #80 谱谱真实gh读取与审计

source=`0001795363935070-000003-10163338`，本轮新invocation=`6284fd0d-b463-402b-859c-18c73fa9a5f7`。谱谱在完整回复 `0001795363935208-000005-208f06ca` 回传一次真实 `gh pr view 80 --repo 08mamba24/clowder-ai`，**EXIT=0、number80、stateMERGED、head441133702**，无失败重试。未把其“正文逐字一致”自述冒充本猫独立比较。

宿主独立读取当日EventAuditLog，事件 `6d3b2d8e-fbe7-4b88-a101-2ef9cddcf2d2`（timestamp1795363970660）：type=agent_github_read，catId=zcode、invocation精确匹配上述ID、threadId为本线程、repository=08mamba24/clowder-ai、operation=pr_view、outcome=read、headSha=441133702f749032c59ade2898aea0bbbcb6ad50、truncated=false。实际CLI结果、宿主能力调用与主体审计三者闭合；本次仅确认已授权八种固定读通道，没有新增GitHub写能力。

#80作者工位善后已完成：原owner回复 `0001795364069011-000009-7618f121` 报canonical finish与--check均为released/storageDisposition=removed。砚砚61独立确认目录不存在、Git worktree清单无该路径；archive manifest及canonical ledger的done记录精确匹配owner=zcode、sourceRef=pr:08mamba24/clowder-ai#80、head441133702。归档 `/Users/yuhan/cat-cafe/.worktree-release-archives/86218360-ca82-433d-8b87-81391da06f40` 保留独有原件、私有Git元数据与恢复依据。bind-pr的raw gh api尝试被固定只读载体拒绝，保留该原始边界，不扩大权限；工位已释放，无需再补绑。原#79作者/集成工位没有被代删或改owner。

## Pro仍未恢复

新boot就绪后，只通过独立云端连接器复测一次 `get_message(messageId=0001795355952214-000030-04b0ae6a, mode=full, agentKeyCatId=gpt-pro)`；isError=true，原始错误 `McpServerError: MCP SSE probe returned 429 from openai.org`，结构化error_code=UNAVAILABLE、type=invalid_mcp_response、status_code=429。未取得目标正文，未高频重试或交正式review；不复制隧道标识/凭据。故本地重启不构成Pro恢复证据。

[四项TODO](2026-11-22-member-chain-pending-todos.md)是当前状态入口。原deployment等待已触发并消费，不续约已消费generation3、不新建镜像Task；余项只在外部通道恢复后再验证精确消息读取。
