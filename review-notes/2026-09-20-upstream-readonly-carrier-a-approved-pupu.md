# upstream #1454 救援 — 分支 A 复审 APPROVED，双 carrier 全绿 — 谱谱/glm-5.3

- **对象**: `fix/mcp-strict-readonly-union` @ `a71b70c0e1df5e501f0865b14f2647c97c0a6dd4`
- **Verdict**: **APPROVED，无 P1/P2/P3 finding，原 P1 关闭**（@zcode 送达 + 结构化 APPROVED durable fact 已写回原 thread，缅因猫/砚砚 2026-09-20 02:24 UTC）
- **复审范围**: 仅绑定 `c55345aff..a71b70c0e` 的 2 文件 P1 delta（ancestry 已核对：父提交精确为被退回的 `c55345affbd833a6c348066e68f608884f0e02de`）

## Reviewer 独立验证（verdict 要点）

1. API build / tsc 退出 0；`mcp-config-adapters` + `antigravity-mcp-tool-executor` 合计 **68/68**；Biome 两文件干净；`git diff --check` 干净。
2. 四项验收条件全部成立：
   - 自动合成仅在 `source === "cat-cafe"`、最终 merged env 确有 file/files credential、且 flag 未显式设置时发生；
   - preserved/fork-like 与 `source: "external"` 条目不再因 ambient credentials 获得 union；
   - 用户显式 opt-in 保留；managed descriptor 显式 `false` 保持严格只读；
   - 第二轮文件保留项按不可证明 managed 的 external provenance 处理。
3. 额外矩阵（reviewer 补测"凭证仅来自 descriptor.env"路径）：`managed=true, external=null, preserved=null, forced=false`。

## 谱谱本地复核（verdict 后）

双分支 HEAD 与被审 SHA 逐位一致、无漂移：A = `a71b70c0e1df5e501f0865b14f2647c97c0a6dd4`，B = `486241a87699d72e893fa3ecf56913124558c650`。

## 状态：救援工程全线完成，等 operator 执行 runbook §三 全序列

| 分支 | SHA | Verdict |
|---|---|---|
| `fix/mcp-strict-readonly-union`（A） | `a71b70c0e` | APPROVED（原 P1 关闭） |
| `fix/mcp-evidence-coverage-regex`（B） | `486241a8` | APPROVED（无 finding） |

operator 步骤（GitHub 凭证归 operator；顺序敏感，②→④ 传 issue/PR 号）：

1. `git push origin fix/mcp-strict-readonly-union fix/mcp-evidence-coverage-regex`（在 `/Users/yuhan/cat-cafe/clowder-ai`）
2. 开 issue（文案 runbook §四）→ 记 `#N`
3. 开 PR B：compare 链接见 B-approved note，body 用其 paste-ready 版（title `test(mcp): escape literal parens in evidence coverage regex`）
4. 开 PR A：compare 链接 runbook §三④，body 用 §五（把 `#N` / PR-B 号填入）
5. 关 #1454（评论文案 runbook §七，把 `#PR-A`/`#PR-B`/`#N` 填入）

B 先于 A 合并（A 的 CI 依赖 B 落地转绿）。本地 main ahead 若干 docs commits（behind 3，#39–41），可在整合后一并 push，不阻塞。
