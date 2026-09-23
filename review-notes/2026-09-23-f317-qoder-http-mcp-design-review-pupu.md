# 2026-09-23 — F317 Qoder native HTTP MCP 入口设计核对（谱谱 → astra）

**Coord**: coord-a5eb10d1-3921-4e6b-9af9-571533e6de22
**只读对象**: runtime main-sync HEAD `2ea10c22c93bcf71edc589e3b4b81461e4e59bd3`（PR #42 merge SHA）
**边界**: 只读源码核对；未改代码、未重跑 live、未接总 task `0001789956139661-000388-6c663874`。新 delta 实现后按 exact HEAD 另做独立 review。

## 立场

**A（Qoder 走现有 broker 的 HTTP MCP `github_read`，宿主写原生 config 私有 headers，与 ZCode 同入口；Bash 沙箱保留）优于 B（给 full shell envelope 新增解析）。**
前提：qoderclicn 原生支持 http 型 MCP server + 每 server 私有 headers，且 headers 仅入 transport、不进模型/日志/会话（astra 隔离复现收口中）。

## 证据（file:line，runtime@2ea10c22）

1. **信封不匹配是确定性的**：`scripts/qoder-shell-sandbox.mjs:53` 将整串 command 交 `parseGhReadCommand`；`scripts/lib/agent-github-read-client.mjs:13` 首词非 `gh`/guardedGhPath 即返回 null；`:14` 元字符黑名单（`;$\`\\&|<>(){}[]*?!#`）。qoderclicn@1.1.51 信封（`source … && eval '用户命令' …`）首词为 `source` → 必然落沙箱 → PATH 命中 `guarded-bin/gh:12-15` 的 `CAT_CAFE_GITHUB_READ_ONLY` 拒绝分支 → `capability_unavailable`。这完整解释银闪矩阵全红、`scope_denied`/`unsupported_query` 两码不可达、broker 零审计。
2. **MCP 端点是标准协议且跨载体已活体证明**：`packages/api/src/routes/agent-github-read.ts:32-56` = `McpServer` + `StreamableHTTPServerTransport`（无状态 JSON）+ Bearer（`:8-11`，43-char 正则同 token 形态），注册 `github_read` typed 工具。zcode（谱谱本会话）18 次调用全部经此端点，含越仓 `scope_denied` 与 `op=pr_create` schema 层 `-32602` 拒绝。
3. **broker 单点已具备两载体所需全部约束**：`agent-github-read-capability.ts` — `ENABLED_CATS={zcode,qoder-flash}`、`REPOSITORIES` 冻结两仓、每 attempt 换 token（randomBytes base64url）、`query()` 前后验 grant、审计行含 catId/grantId/outcome/headSha。
4. **Qoder 侧现状**：`QoderAgentService.ts:684-710` `mcp-config.json` 仅 stdio 型 server（`command/args/env`）；`:712-721` `github-read.json{token,queryUrl}` + env 指针 `CAT_CAFE_QODER_GITHUB_READ_CONFIG`——A 方案将以原生 config http server 描述符取代该文件与 env 指针（少一个 credential-adjacent 面）。
5. **init 契约**：`QoderAgentService.ts:328-347` tools 与 mcp_servers 均精确集合匹配、要求全部 `connected`——加 server 是显性契约变更（同步 `CONTROLLED_INIT_EXPECTATION` 与 readonly 策略测试）；连不上 fail-closed 拒启可接受：lease 只能由活 API mint，loopback 同宿主，broker 不可达时 invocation 本就终止。

## 为什么 A 更稳

1. **消灭供应商形状耦合**：B 的解析对象是 vendor 控制的 eval 信封文本，1.1.51 已漂移过一次（PR42 的 "real shell-prefix HTTP test" 直接喂 `gh`，生产形状不同）；剥取器要复刻 shell 引用语义，每次 qoderclicn 升级可能静默再断。正确坐标系是 MCP 层 typed 调用，不是 wrapper 层逆向 shell 引用。
2. **失败可观测**：A 每次尝试（成败与否）过 `broker.query()` 落 `agent_github_read` 审计，拒绝码可达；B 失败发生在分类之前——本次 AC1 诊断困难的直接原因。
3. **单一真相源**：两载体同 broker、同 zod schema、同冻结 allowlist、同预算/撤销生命周期，review 面减半；zcode 侧 `zcode-github-read.ts` 的严格描述符安全论证可直接复用。
4. **token 位置等价安全**：宿主写 0600 config（lease 目录、scratch allowlist 外、Seatbelt deny canary 覆盖）→ transport Authorization header，不进 model/env/argv——与今日 `github-read.json` 同一防线，不新增面。

## 需要守住的约束

1. token 只存在于宿主写就的 0600 config（scratch allowlist 外）+ transport header；不进 prompt、sandbox 子进程 env、argv、日志/stderr（PR42 的 canary 检查法扩展到 qoder 载体）。
2. 描述符严格形态：单 server、`type:'http'`、loopback `127.0.0.1`/`[::1]`、路径恰为 `/api/agent-github-read/mcp`、无 userinfo/query/hash、`Bearer [A-Za-z0-9_-]{43}`；由宿主 writer 写死（等价 zcode 侧 `parseZcodeReadMcp` 的严格校验，校验者换成 writer）。
3. 不扩权：复用同一 broker、同一 `REPOSITORIES` 冻结 allowlist、同一 8-op schema、同一预算/取消/在途上限；无第二 allowlist、无新 op。
4. 生命周期：sandbox probe 之后 mint、finally 先 revoke 再 dispose lease；API 重启丢 grant。
5. Seatbelt deny canary 改指新 config 路径（`github-read.json` 与 env 指针移除后 canary 同步改，不留假阴性）；沙箱子进程 env 不残留 config 路径或 token。
6. Bash 沙箱与 `guarded-bin/gh` deny 分支原样保留——沙箱内 shell 永远够不到载体，纵深防御不变。
7. A 上线后**移除** `qoder-shell-sandbox.mjs` 的 gh 翻译分支，不留双入口双解析面。
8. AC 重跑硬验收项：qoder-flash 的 `agent_github_read` 审计行必须出现（ok 与失败都算）——本次事故缺失的信号。
9. 兜底（仅当 A 前置不成立）：不做通用信封解析；版本钉死的最小剥取（按 1.1.51 `buildExecCommand` 固定前后缀锚定、唯一 eval 单引号载荷）+ 剥出后仍过现有严格 literal parser + 漂移显式 cliDrift 类信号，不静默 `capability_unavailable`。

## 与 astra 隔离分支 RED 的对齐确认

其新增测试断言——allowed-tools 含 `mcp__clowder-repository-read__github_read`；config 出现 `{type:'http', url:'http://127.0.0.1:PORT/api/agent-github-read/mcp', headers.Authorization: Bearer 43×h}`；revoke 先于 unlink——与本核对约束 1/2/4/8 逐条对应，方向一致。2 个 RED 均为"实现未写"型失败（allowed-tools 未含、config 无 HTTP server），符合 TDD 预期序，非设计矛盾。

[谱谱/glm-5.3🐾]
