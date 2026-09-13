# Qoder (qodercn) golden fixtures — F317 S4b

采集环境: qodercn 1.1.51 (`@qodercn-ai/qoderclicn`), protocol_version 1.4.0, macOS arm64, 2026-09-13。
`~` 为用户 HOME 占位。**完整可复现命令、fixture setup 与副作用检查见 `collect.sh`；原始会话 receipt（exit/stdout/stderr/副作用）见 `RECEIPTS.md`。**

| 文件 | 类别 | 采集命令（要点） | exit | 关键断言 |
|---|---|---|---|---|
| success.jsonl | 成功 | `-p "reply with exactly: ok" -o stream-json --strict-mcp-config --allowed-mcp-server-names nothing --tools "" --setting-sources user` | 0 | `init.tools=[]`、`init.mcp_servers=[]`、`init.permissionMode=default`、`init.model=Auto`、hook 事件先于 init、`result.is_error:false` |
| tool-use.jsonl | 工具调用+tool_result | 点点点采（probe），`--tools` 受限集 | 0 | assistant tool_use `id/name/input` Claude 同构；`user` tool_result |
| permission-denial.jsonl | 权限拒绝 | `--tools "Write"`，提示写 `/tmp/pwned.txt`（未落盘，receipt 见 RECEIPTS） | 0 | 负向信号在 `user.tool_result{is_error:true,"Error: Allow ..."}`；**终态结构化字段（`is_error:false, permission_denials:[]`）不可作为判拒依据；`result.result` 自由文本含 "was denied" 字样但不得作分类依据** |
| auth-error.jsonl | 错误（未登录） | `--config-dir` 指向空目录 | 1 | `result.is_error:true` 但 **`subtype` 仍为 `"success"`** —— 判错必须以 `is_error` 为准 |
| silent-model-fallback.jsonl | 负向（静默回落） | 点点点采，`-m definitely-not-a-model-xyz` | 0 | `init.model=Auto` → `result.is_error:false` 成功返回；stderr 回落警告属点点采集会话，仓内无该 stderr 工件（重跑 collect.sh 可补全，见 RECEIPTS） |
| resume.jsonl | resume | `-r <success 的 session_id>` 追问上一轮 | 0 | 同 `session_id` 贯穿；正确回忆上文 |
| hook-red.jsonl | S5 红证 | 默认 setting-sources + project `.qoder/settings.json` 恶意 SessionStart hook | 0 | 恶意 hook **真实执行**（marker 落盘）；`hook_started` 先于 init |
| hook-green-project.jsonl | S5 绿证 | 同上 + `--setting-sources user` | 0 | project 恶意 hook 不执行、不在流中；builtin plugin hook 仍在（残留风险） |
| hook-green-local.jsonl | S5 绿证 | project `settings.local.json` 恶意 hook + `--setting-sources user` | 0 | local 源被阻断 |

## 未采（不得视为 green fixture）

- **cancel**: 首次尝试的 transcript 实际以成功 `result` 收尾（SIGINT 未能中断该 invocation），**未采到**；正确信号面（exit 130 / 无 result / signal 信息）待重采。
- **压缩（compaction）**: `deferred/N/A for Phase 1`（compact_boundary 冻结，P1-E）。
- **MCP 实挂载（cat-cafe-memory + `CAT_CAFE_READONLY=true`）**: Phase 1 实现验收项。

## dialect 陷阱（parser 契约）

1. `result.is_error=true` 必须压过 `subtype:"success"`。
2. `user.tool_result.is_error=true` 只标记该 tool 调用失败，终态 result 仍可 `is_error:false` —— 不得据此误判整次 invocation 失败。
3. cancel / silent_completion / CLI failure 三条路径必须分开测试（cancel 尚无夹具）。
