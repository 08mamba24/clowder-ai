# F317 controlled Qoder：memory policy 放行 mcp-server workspace 依赖闭包 — 谱谱/glm-5.3

- 分支：`fix/qoder-memory-policy-dep-closure`（worktree `clowder-ai-wt-qoder-mempolicy`，base = `origin/main` `832be132c`）
- 毛线球：`0001789699806232-000144-220b0990`（点点只读诊断 + 交接，诊断档 `2026-09-18-f317-qoder-controlled-mcp-sandbox-diagnosis-dsh.md`）
- 根因（点点定位，我复核采信）：pnpm workspace symlink 在 node ESM 解析时落到 `<RT>/packages/<dep>` **realpath**，不在 memory policy 的 allow 列表；`deniedReadRoots` 含 operatorHome → runtime 树整体 deny → `ERR_MODULE_NOT_FOUND` → memory MCP 退出 → init gate fail closed → controlled 面 live 0% 可用

## 方向决策：A（动态依赖闭包），否决 B（整树 `<RT>/packages`）

- **A**：`resolveWorkspaceDependencyRoots(runtimeRoot, entryPackageRoot)`——BFS 走 entry 的 runtime `dependencies`，经 `<RT>/node_modules/<name>` symlink realpath，只收 `<RT>/packages` 内的兄弟包（registry 依赖本就在已 allow 的 `node_modules` 下；packages 外不收）。**新 workspace 依赖自动跟进**，无需维护清单。
- **B 否决理由**：把 api/collective-service 等服务端源码纳入受控猫可读面，违背 policy 既有注释「Never grant the whole runtime root」的最小权限立场；A 的成本已被动态推导压到一次 BFS，B 的"简单"不再有对价。
- 防复发三层锁（回应点点"钉住依赖清单，否则静默复发"）：
  1. 动态闭包——新依赖自动进 allow 面；
  2. `pins the real repo closure` 测试——从 mcp-server package.json 动态取 `@cat-cafe/*` 依赖逐一断言在闭包内 + 闭包内所有根必须在 `<RT>/packages` 内（防面意外变宽）；
  3. **真 Seatbelt initialize 回归**（结构性补丁，本次漏网原因）——真 wrapper + 真 `sandbox-exec` + 真 `dist/memory.js`，断言 MCP 完成 initialize。

## 实现（3 文件）

1. **新 `packages/api/src/.../providers/qoderSandboxPolicy.ts`**：从 QoderAgentService 整体迁出 `canonicalPath`/`seatbeltLiteral`/`shellLiteral`/`isPathWithin`/`buildSeatbeltPolicy`（单一真相源，service 反向 import），新增 `resolveWorkspaceDependencyRoots`、`buildQoderMemoryShimScript`、`buildQoderMemorySeatbeltPolicy`（含测试缝 `workspaceDependencyRoots?: readonly string[]`，默认动态闭包，传 `[]` 复现 legacy 面）。memory policy 的 allow 面变为 `[workspace, scratch, memoryDistRoot, <RT>/node_modules, ...闭包根]`；闭包根内 `.env/.env.local/.npmrc` 仍 deny（防将来依赖包里出现秘密）；protected roots/literals 保持 final-deny。
2. **`QoderAgentService.ts`**：lease 改用上述构造器；删迁移走的私有实现与失活的 `memoryDistRoot`。
3. **新 `packages/api/test/qoder-memory-policy-sandbox.test.js`**：4 用例（fixture 树 BFS 单测 / repo 闭包钉住 / darwin 真 Seatbelt closure 绿 / legacy 负对照红）。

## 顺手闭合：诊断档 §六 canonical 口径边界（真红捕获）

写测试时 closure 用例先红：`sh: memory-shim: Operation not permitted`。根因正是点点 §六预警——policy 先于 shim 落盘时，`canonicalPath` 对不存在路径静默 `resolve()` 回落，shim literal 拿到 `/var/...` 非 canonical 形态，压不过 canonical `/private/var/.../T` 的 deny。修法：`canonicalPath` 回落改为**沿最深存在祖先 realpath 再拼回尾部**（`/var/folders/x/T/newdir` → `/private/.../T/newdir`）。这一类修复对所有 policy 调用方生效；修后同序测试转绿（红→绿证据即此用例）。

## 验证（macOS 本地，base 832be132c，正规 build 后对 dist 实跑）

- 新测试 **4/4**：BFS 单测（symlink 传递/环/非 workspace/未安装跳过）、repo 闭包钉住、closure 面 initialize 完整返回 `serverInfo`、legacy 负对照（MCP 起不来，事故精确复现）
- 红→绿：closure 用例在 canonicalPath 硬化前红（exec 被拒）、硬化后绿；legacy 负对照始终红（面确实锁死）
- Qoder 回归 **135/135**（qoder-agent-service / qoder-l2-tool-surface / qoder-slice2-registration / f317-qoder-fixture-readside-gate / qoder-ndjson-parser）；`tsc` 0 error；`pnpm install --frozen-lockfile` 零漂移；biome error 级 0（complexity 警告为 buildSeatbeltPolicy 随迁移移位，两文件合计数不变）；`git diff --check` 干净

## 范围边界

- **live 生效需 operator 授权重启**（PR #33 同款流程），本修不合入不生效
- hold_ball 503（`HOLD_OWNER_FENCE_UNAVAILABLE`）是独立毛线球，不在本修内
- 诊断档 §六的 symlink lease 场景：canonicalPath 硬化覆盖了"literal 未 canonical"这一成因；`(subpath "/private/tmp")` 对 lease 落在符号链接目录的另一成因（lease 路径 canonical 化后同样收敛）——live 用 `/var/folders` 无此形态，未另加用例

## 下一棒

@砚砚m 跨族 review（修复面 = 受控沙箱安全策略，正是你的域）；approve 后走 PR #36 同款代推通道（我 shell 无凭据）。verdict 请绑 `reviewedHeadSha`。

`[谱谱/glm-5.3🐾]`
