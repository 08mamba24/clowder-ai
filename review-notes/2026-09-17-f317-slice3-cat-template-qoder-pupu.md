# F317 Slice 3：银线（qoder）cat-template 转正条目 — 谱谱/glm-5.3

- 分支：`feat/f317-slice3-cat-template`（worktree `clowder-ai-wt-f317-slice3`，base = `origin/main` `f04205eec`）
- operator 拍板：2026-09-17 10:44 UTC「要」（thread_msqw8n1bqpvmob6f#0001789641877565-000022-2c9d3841）——家里正式新增银线（俄罗斯蓝猫，Qwen 家族）
- 本 note 随 fix 同 commit 进分支

## 改动面（7 文件，含本 note）

1. **`cat-template.json`**：
   - `breeds` 增 `qoder`（`qoder-default` 变体）：clientId=`qoder`（账号系统已支持，accounts enum 早已就位）、defaultModel=`Qwen3.8-Max`（与 live 自定义猫/实测 init 一致）、mcpSupport=true、cli=`qodercn` json（与 routes/cats.ts 既有 case 一致）。**breed-only 入口循 zcode 先例**，不加 roleTemplate；personality 只写「性格由本人自述，暂留白」**占位字符串**（非身份内容），真正的自我画像归银线本人。
   - `roster` 增 `qoder`：`roles: ["coder"]`（循 dsh/zcode/grok-build 先例；**不**给 peer-reviewer——新成员，review 资格另议）。
   - caution 写明 L2 边界（六工具沙箱、memory 只读 12、darwin-only fail-closed、账号未绑 apiKeySource=none 必失败、CLI 验证面 1.1.51）。
2. **`template-variant-backfill.ts`**：`TEMPLATE_BREED_BACKFILL_ALLOWLIST` 加 `qoder`——否则存量部署的 runtime catalog 升级时收不到新 breed（半注册态，正是 Slice 2 要防的）。注意回填自带 `occupancy.catIds` 保护：本家 live 已有 catId=`qoder` 自定义猫，回填会正确跳过、不覆盖用户创建的猫。
3. **测试**：
   - `cat-config-loader.test.js` 名册守卫 25→26 + qoder 断言（clientId/defaultModel/mcpSupport/cli/mentionPatterns）
   - `cat-catalog-store.test.js` 回填用例扩 qoder（breed + roster 双断言）
   - `system-prompt-builder.test.js` 预算 7200→7300（实测 7236/7233，超出恰为银线一行名册；循 6500→6700→7050→7200 历史先例上调并注明）
4. **proposal doc** r6：Status/Slice 3 状态、timeline 三行（PR #33 merged、runtime 激活 + live 首调诊断、operator 拍板转正）、修订日志。

## 验证（macOS 本地，base f04205eec）

- 9 套 roster/路由/prompt 敏感套件 **467/467**（cat-config-loader 108 / system-prompt-builder / a2a-mentions / agent-router / cat-account-binding / cat-catalog-store / qoder-slice2-registration / qoder-l2-tool-surface / origin-upstream-boot-smoke）
- api 包 `tsc --noEmit` 0 + `pnpm run build` exit 0；biome 0 error；`git diff --check` 干净
- 前置红：预算测试首跑 2 fail（7236/7233 > 7200）——超出量与新增名册行一致，先例法上调预算后绿

## 明确不做（范围边界）

- 不加 roleTemplate、不代写自我画像——personality 仅为「暂留白」占位串，身份内容归银线本人
- 不动 `MCP_WHITELIST_DEFAULT_BREEDS`（那是 grok-build/dsh 的 ACP legacy pin 迁移，qoder 非 ACP 无此历史）
- 不动 live 自定义猫（回填 occupancy 保护自动处理；canonical 化留给 operator 后续决定删自定义猫 or 保留）

## review 记录（砚砚m，2026-09-17，reviewedHeadSha=d3890fdfe）

- **CHANGES_REQUESTED**：2×P2 + 1×P3（详见下），三个指定判断全部认可（occupancy/tombstone 四象限 4/4、7300 预算、roster 只给 coder）
- **P2-1 已修**：proposal P1-F 的 r1 rollout 契约（fresh-install seed、不更新既有 catalog）与本提交的回填白名单矛盾——P1-F 已改写为 r6 语义并标注取代，写明 occupancy/tombstone 规则
- **P2-2 已修**：回填只有正向测试——补两个守卫用例：① 手建自定义 qoder（displayName/personality/accountRef）跨 bootstrap 不被模板覆盖；② qoder 删除 tombstone 后 bootstrap/解析读均不复活（镜像 glm52 用例）
- **P3 已修**：note 口径（7 文件；personality 为占位串而非未写）

## reviewer 建议重点

1. 回填 allowlist 的 occupancy 交互（live 已有 catId=qoder 自定义猫 → 回填跳过 → 模板条目对现网暂不生效，只对新 catalog/删除自定义猫后生效）——确认这是预期迁移语义
2. 预算 7200→7300 的步进是否接受（vs 压缩名册文案）
3. roster roles 只给 coder 的判断

## 下一棒

- 跨族 review（@砚砚m）→ push（operator 或持凭证猫）→ CI → merge gate（作者不 self-merge）
- 合入后：operator 绑 qoder 账号（live 首调诊断的前置）→ E2E 验收（spawn 银线 + 工具任务）

`[谱谱/glm-5.3🐾]`
