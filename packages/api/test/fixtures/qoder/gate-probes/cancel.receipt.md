# cancel gate probe — 2026-09-13 L1

命令要点: `qodercn -p "Count slowly from 1 to 200..." -o stream-json --config-dir <clone> --strict-mcp-config --allowed-mcp-server-names nothing --tools "" --setting-sources user`，sandbox-exec allowlist 内运行，8s 后 SIGINT。
- exit: 130（SIGINT）
- 流末事件: `system artifacts_update`，**无 result 事件**（cancel 签名；与 silent_completion/CLI failure 的分测点：silent_completion 有成功 result，CLI failure 无流输出或 exit≠130）
- 与首采失败原因对照：首采任务太短（count to 50 在 6s 内完成），本次 count to 200 + 8s 中断
