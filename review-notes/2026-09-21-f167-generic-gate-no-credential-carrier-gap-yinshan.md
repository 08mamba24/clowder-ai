# 2026-09-21 — F167 通用停止门 vs 无凭证 carrier 的缺口留痕（qoder-flash）

**Carrier**: 俄罗斯蓝猫/银闪（qoder-flash, Qwen3.8-Flash），thread_msqw8n1bqpvmob6f，独立回答唤醒。

**现象**: 收到 `[F167 球权停止门]` 通用变体（"必须调用现有结构化工具"），但本次唤醒的工具面只有 12 个只读 cat-cafe-memory MCP 工具，`cat_cafe_complete_a2a_dispatch` / `cat_cafe_hold_ball` 均未注册；env 实测 `CAT_CAFE_API_URL` / `CAT_CAFE_INVOCATION_ID` / `CAT_CAFE_CALLBACK_TOKEN` 全空，HTTP 回调兜底同样不可用。

**处置**: 按 `review-notes/2026-09-20-upstream-readonly-carrier-b-approved-pupu.md:53` 先例——最终回复行首 `@` 路由，缺口以本留痕记录。协议球实际状态：gh 权限自查 + 根因链 + A/B 建议已在上一手完成交付，球在 co-creator（等 A/B 拍板），本轮未重做未改写。

**Harness finding（P3, F167 owner 线）**: `packages/api/src/domains/cats/services/agents/routing/route-serial.ts:301-305` 的 generic 分支对无 callback 凭证的 carrier 下发了不可满足的指令（要求调用其工具面上不存在的结构化工具）。建议：gate 发出前检测 invocation 是否具备 disposition 工具面或 callback 凭证；均无时提示词应显式降级为 sanctioned text-@ fallback，而不是让 carrier 自行考古先例。需跨族 review。

**第二例（同 thread 类型复现）**: thread_mua1efbnjtkqiaqy（net-mode nord/clash 分流实现响应速度测试），同一 carrier（qoder-flash/Qwen3.8-Flash）再次收到通用停止门。工具面/凭证状态实测同上（12 个只读 MCP 工具、callback env 全空）；本地 API `localhost:3004` 可达但 post-message 需 invocationId+callbackToken，无法冒用。处置同上：不重做上一手（响应速度自检 + 侦察报告已交付），最终回复行首 `@astra` 结构化传球（请求方案要点+脚本路径交接），以本留痕记录缺口。

**第三例（完成报告后仍触发）**: 同 thread，net-mode 候选包交付完成（RED→GREEN 17/17 + scratch 路径上报 + 行首 @astra 传球）之后的下一轮唤醒仍收到停止门——门对"sanctioned text-@ 已完成 disposition"不可见，对无凭证 carrier 形成重复空转。进一步佐证 P3 finding：gate 需按 invocation 能力降级提示词，且 disposition 判定应识别 text-@ fallback 先例。

**第四例（退回修正轮再触发）**: 同 thread `thread_mua1efbnjtkqiaqy`，收到 astra「退回，不放行安装」的复核轮唤醒时再次附带 `[F167 球权停止门]`。工具面实测与前三例一致：仅 12 个只读 cat-cafe-memory MCP 工具，无 `cat_cafe_complete_a2a_dispatch` / `cat_cafe_hold_ball`，callback env 全空。本轮处置同上：完成 6 项 P1 + 2 项 P2 修正、`test/run-tests.zsh`（PASS=124 FAIL=0）与审查方期望移植 `test/astra-repros-v2.zsh`（10/10）后，以行首 ` @astra` 文本传球交回复核，MANIFEST 已更新，缺口继续以本留痕记录。四例同型 → P3 finding 的复现证据累积完毕，仍待 F167 owner 线跨族 review。

**第五例（v3 修正轮再触发）**: 同 thread `thread_mua1efbnjtkqiaqy`，v2 退回（剩余 6 P1 + 1 P2）后的修正轮唤醒再次附带 `[F167 球权停止门]`。工具面与凭证实测与前四例完全一致：仅 12 个只读 cat-cafe-memory MCP 工具，无 `cat_cafe_complete_a2a_dispatch` / `cat_cafe_hold_ball`，callback env 全空。本轮处置同上：完成 R1–R7 修正、`test/run-tests.zsh` 扩至 `PASS=229 FAIL=0`、`test/astra-repros-v2.zsh` 保持 10/10、新增 `test/astra-repros-v3.zsh` 9/9（并以审查方原脚本 + 审查方自带 shims 对已修包复跑 9/9），MANIFEST 重生成 27 项 `shasum -c` 全 OK，随后以行首 ` @astra` 文本传球交回复核。五例同型：gate 对"已用 sanctioned text-@ 完成 disposition"依旧不可见，无凭证 carrier 每轮都要重新考古先例 → P3 finding 复现证据继续累积，仍待 F167 owner 线跨族 review。

**第六例（zcode 载体，跨载体复现；AC1 验收完成轮后再触发）**: thread_msqw8n1bqpvmob6f（PR42/F317 AC1 live 只读验收），carrier 为 zcode/谱谱（glm-5.3）。AC1 验收矩阵（两仓 13 ok / 3 unavailable / 越仓 scope_denied / op=pr_create schema 层 -32602 拒绝）已在上一手完整交付并以行首 `@astra` 文本传球后的下一轮，仍收到 `[F167 球权停止门]`。工具面实测：无 `cat_cafe_complete_a2a_dispatch` / `cat_cafe_hold_ball` / `submit-game-action`；本载体 sanctioned 先例为 `review-notes/2026-09-20-upstream-readonly-carrier-b-approved-pupu.md`「执行面缺口（F223 备注）」（同载体 zcode/glm-5.3 已裁决）。env 实测 `CAT_CAFE_API_URL` / `CAT_CAFE_INVOCATION_ID` / `CAT_CAFE_CALLBACK_TOKEN` 全空，HTTP 回调兜底不可用。处置同先例：不重做已交付验收，行首 `@astra` sanctioned text-@ 交回，缺口以本留痕记录。意义：缺口从 qoder-flash 扩展到 zcode 载体（跨载体复现），且再次命中"完成交付 + sanctioned text-@ 已完成后仍重触发"的空转模式，P3 finding（route-serial.ts:301-305 gate 需按 invocation 能力降级提示词、disposition 判定应识别 text-@ fallback）复现证据 +1。

**第七例（zcode 载体连续第二次，设计核对轮）**: thread_msqw8n1bqpvmob6f，astra 交谱谱做 F317 qoder 入口方案设计核对（HTTP MCP vs shell envelope 解析），唤醒再次附带 F167 通用停止门（要求 `cat_cafe_complete_a2a_dispatch` / `hold_ball` / 结构化传球）。实测同第六例：工具面无任何 `cat_cafe_*` 球工具，`CAT_CAFE_API_URL` / `CAT_CAFE_INVOCATION_ID` / `CAT_CAFE_CALLBACK_TOKEN` 全空。处置同 sanctioned 先例：完成设计核对交付，行首 `@astra` 文本交回，本留痕记录。zcode 载体连续两轮触发（六、七例），P3 finding 证据 +1。

`[银闪/Qwen3.8-Flash🐾]`

`[谱谱/glm-5.3🐾]`
