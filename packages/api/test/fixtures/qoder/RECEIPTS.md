# 采集 receipts — 2026-09-13 会话（谱谱本机）

环境: `~/.local/bin/qodercn`（`@qodercn-ai/qoderclicn@1.1.51`），protocol_version 1.4.0，macOS arm64；`QODER_CONFIG_DIR=~/.qoder-cn`（已登录，占位符 `~` = 用户 HOME）。完整复现命令见 `collect.sh`（确定性采集脚本，含 setup 与副作用检查）；本文件为 2026-09-13 首采会话的原始 receipt 摘录（stdout 即仓内 jsonl，stderr 当时未分轨保存，重跑 collect.sh 可补全分轨 receipt）。

| fixture | exit | stdout | stderr | 副作用检查 |
|---|---|---|---|---|
| success | 0 | `success.jsonl`（11 行，末行 result success） | 未分轨（无错误输出） | 无副作用面（`--tools ""` + deny-all MCP） |
| hook-red | 0 | `hook-red.jsonl`；`hook_started` 含恶意 `touch .../marker` | 未分轨 | **marker-project 存在**（红：恶意 hook 真实执行） |
| hook-green-project | 0 | `hook-green-project.jsonl`；恶意 hook 不在流中 | 未分轨 | **marker 不存在**（绿）；builtin plugin hook 仍在流中（残留风险证据） |
| hook-green-local | 0 | `hook-green-local.jsonl` | 未分轨 | **marker-local 不存在**（绿） |
| permission-denial | 0 | `permission-denial.jsonl`；`user.tool_result{is_error:true,"Error: Allow writing..."}` | 未分轨 | **/tmp/pwned.txt 不存在**（写入被拦） |
| auth-error | 1 | `auth-error.jsonl`（3 行，末行 `result is_error:true`，**subtype:"success"**） | 空 | 无（空 config dir） |
| resume | 0 | `resume.jsonl`；同 session_id，正确回忆上文 | 未分轨 | 无 |
| silent-model-fallback | 0 | `silent-model-fallback.jsonl`（点点点采；`-m definitely-not-a-model-xyz`） | 点点报告 stderr 有回落警告——**该 stderr 属点点采集会话，本仓无工件，以 collect.sh 重跑补全为准** | 无 |
| tool-use | 0 | `tool-use.jsonl`（点点点采，probe 参数见其 review 记录；完整命令待点点补 manifest 行） | 同上 | 无 |

cancel：无 receipt（首采失败：SIGINT 未能中断该 invocation，transcript 以成功 result 收尾，已废弃不入仓）。重采要求：记录 signal / exit code / 流末事件三样，与 silent_completion、CLI failure 分测。
