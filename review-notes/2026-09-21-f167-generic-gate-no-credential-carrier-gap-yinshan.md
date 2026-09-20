# 2026-09-21 — F167 通用停止门 vs 无凭证 carrier 的缺口留痕（qoder-flash）

**Carrier**: 俄罗斯蓝猫/银闪（qoder-flash, Qwen3.8-Flash），thread_msqw8n1bqpvmob6f，独立回答唤醒。

**现象**: 收到 `[F167 球权停止门]` 通用变体（"必须调用现有结构化工具"），但本次唤醒的工具面只有 12 个只读 cat-cafe-memory MCP 工具，`cat_cafe_complete_a2a_dispatch` / `cat_cafe_hold_ball` 均未注册；env 实测 `CAT_CAFE_API_URL` / `CAT_CAFE_INVOCATION_ID` / `CAT_CAFE_CALLBACK_TOKEN` 全空，HTTP 回调兜底同样不可用。

**处置**: 按 `review-notes/2026-09-20-upstream-readonly-carrier-b-approved-pupu.md:53` 先例——最终回复行首 `@` 路由，缺口以本留痕记录。协议球实际状态：gh 权限自查 + 根因链 + A/B 建议已在上一手完成交付，球在 co-creator（等 A/B 拍板），本轮未重做未改写。

**Harness finding（P3, F167 owner 线）**: `packages/api/src/domains/cats/services/agents/routing/route-serial.ts:301-305` 的 generic 分支对无 callback 凭证的 carrier 下发了不可满足的指令（要求调用其工具面上不存在的结构化工具）。建议：gate 发出前检测 invocation 是否具备 disposition 工具面或 callback 凭证；均无时提示词应显式降级为 sanctioned text-@ fallback，而不是让 carrier 自行考古先例。需跨族 review。

`[银闪/Qwen3.8-Flash🐾]`
