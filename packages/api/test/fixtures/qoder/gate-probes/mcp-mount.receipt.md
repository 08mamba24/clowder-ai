# MCP mount gate probe — 2026-09-13 L1

## qodercn 挂载机制（哑只读 echo server 扮演 cat-cafe-memory）
- `--mcp-config <json> --strict-mcp-config --allowed-mcp-server-names cat-cafe-memory` →
  `init.mcp_servers == [{name:"cat-cafe-memory", status:"connected"}]`（builtin plugin 被过滤 ✓）
- **headless 下 MCP 工具调用默认被权限系统拒绝**：模型尝试 probe_echo →
  `tool_result is_error:true, "Error: Allow MCP tool cat-cafe-memory/probe_echo?"`（非交互自动拒）
  → 安全利好；Phase 1 运行时需要预授权机制（I-10 新增项：MCP 工具 allowlist 预授权方案）
- 排障记录：MCP server 须从可解析 `@modelcontextprotocol/sdk` 的目录启动（/tmp 下 spawn 即崩 → disconnected）

## cat-cafe-memory 实挂 readonly 断言 —— 🔴 被 cat-cafe-runtime P1 阻塞
独立 stdio client（官方 SDK）+ `CAT_CAFE_READONLY=true` 拉 tools/list：
- **实际暴露 66 工具**（含 39 个写操作：cross_post_message / backfill_events / teleport / remove_scheduled_task 等）
- `READONLY_ALLOWED_TOOLS` 白名单仅 27 个
- 根因：`packages/mcp-server/src/server-toolsets.ts` 的 `registerFullToolset`（legacy all-in-one 入口
  `dist/index.js` 使用）**未调用 `applyReadonlyFilter`**，`CAT_CAFE_READONLY` 在该入口形同虚设
- 处置：F317 侧 blocked-on-runtime——cat-cafe-memory 实挂断言推迟到 runtime 修复后补；
  Phase 1 首个产品 invocation 前必须修复（否则 qodercn 若获得预授权将直接拿到写工具面）

## P1-C 实证
`disconnected`（spawn 失败）与 `connected`（成功）均为活词汇 → 方言层 status 映射（disconnected→failed）确认必要
