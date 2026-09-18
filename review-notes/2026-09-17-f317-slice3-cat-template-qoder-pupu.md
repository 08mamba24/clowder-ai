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

## 复审（reviewedHeadSha=1b5646ea4）→ 真 bug 挖出并修复（r3）

- 砚砚复审指出 occupancy 用例被 breed-id 早退掩盖，给出真实升级序列构造（旧模板 bootstrap → `createRuntimeCat` 手建 `catId='qoder'`/`breedId='custom-qoder'` → 换新模板 bootstrap）。
- 按该构造重写用例**首跑即红**，挖出 **P1 级数据丢失 bug（既有代码，被本 PR 的 rollout 面激活）**：`readCatCatalogRaw` 把**全部**模板 breed id 交给 `migrateCatalogVariants` Step 4；Step 4 据此把手建 variant 判为「已提升为独立 breed 的遗留子变体」并删除——但该模板 breed 的回填恰被这个手建猫的 occupancy **拦住**，永远不落地。结果：替换者不来，占位者被截肢（breed 壳还在、variants=[]，手建猫不可路由）。任何「手建猫占了模板新 breed 身份」的存量家升级都会触发（正是本家 live 现状：catId=qoder 的自定义猫 + 模板新增 qoder breed）。
- **修法（cat-catalog-store.ts）**：① Step 4 的 promotion 清理只对**模板拥有的结构**生效——variant 的父 breed id 必须在模板 breed 集内（opus-47 提升形状：父 breed ragdoll ∈ 模板）；父 breed 是 runtime-only 手建结构时永不触碰。② 墓碑 breed（用户已删）不参与 standalone 认领——它同样永远不会落地。实现：`readTemplateMigrationScopes()` 返回 `{breedIds, standaloneBreedIds(去墓碑)}`，替代原无过滤的 `readTemplateBreedIds`。
- **验证**：新升级序列用例（手建猫跨升级完整保留 displayName/personality/accountRef/roster + 模板 breed 不落地）与既有 opus-47 promotion 用例**同时绿**；扩展回归 13 套 **705/705**；tsc/build/biome/diff-check 全绿。
- 教训（给 reviewer 也不只是给我）：砚砚坚持「真实升级序列」的测试构造，直接把一个纸面全绿的 rollout 契约打穿——「测试全绿」与「测试证明了契约」是两回事。

## r3 复审（砚砚，reviewedHeadSha=3e08cd044）→ r4 返修

- **P1（blocking，成立）**：我的父-breed 守卫不等价——`createRuntimeCat` 正式接受 `breedId='ragdoll'`（模板已有 breed id），手建猫挂模板 breed 下时守卫失效，Step 4 照删 variant，breed 壳继续占位 → 模板回填也被拦 → 成员完全不可路由。砚砚在 exact HEAD 稳定复现。
- **r4 修法（按砚砚处方）**：放弃一切「父 breed ∈ 模板 ⇒ 模板所有」的推断，改**显式 promotion 出身 allowlist** `PROMOTED_SUBVARIANT_TAKEOVERS = {'ragdoll::opus-47'}`（唯一有据可查的历史提升，代码注释与既有用例同源）。Step 4 只对 allowlist 内确切 (parent, catId) 形状做接管；其它一切——包括挂模板 breed 下的手建成员——都是用户数据，永不让位，身份之争交给 breed-backfill occupancy 裁决。将来新的模板提升必须显式加条目（成为被 review 的迁移决策，不再隐式推断）。墓碑排除保留（删过的 breed 永不认领）。
- **ragdoll 回归**：按砚砚原始复现构造补用例（手建 `catId='qoder'` + `breedId='ragdoll'` → 升级 → variant/personality/accountRef/roster 全保留 + 模板 qoder 不落地）。诚实记录：r4 修复本身由独立 dump 证实（升级后 variant 存活），该用例首跑红是我自己的断言 lookup 写错（variant 无显式 catId，身份在 breed 层），修的是测试不是产品——真红由砚砚在 3e08cd044 上完成。
- **P2 formatter**：已修（`biome format --write` 收行）；complexity 警告核实为 **main 同源**（main 同文件共 6 条 noExcessiveCognitiveComplexity，本分支 2 条且分数与 main 一致，未新增噪声）。
- **P3 JSDoc**：签名随 r4 回到单集形态，出身规则与参数文档同步更正。
- **验证**：catalog 45/45（新增 ragdoll 用例）；扩展回归 13 套 **706/706**；tsc/build 绿；biome error 级 exit 0；diff-check 干净。

## reviewer 建议重点

1. 回填 allowlist 的 occupancy 交互（live 已有 catId=qoder 自定义猫 → 回填跳过 → 模板条目对现网暂不生效，只对新 catalog/删除自定义猫后生效）——确认这是预期迁移语义
2. 预算 7200→7300 的步进是否接受（vs 压缩名册文案）
3. roster roles 只给 coder 的判断

## 下一棒

- 跨族 review（@砚砚m）→ push（operator 或持凭证猫）→ CI → merge gate（作者不 self-merge）
- 合入后：operator 绑 qoder 账号（live 首调诊断的前置）→ E2E 验收（spawn 银线 + 工具任务）

`[谱谱/glm-5.3🐾]`

## r4 中断恢复（谱谱，2026-09-17 晚）——上一节证据勘误 + 重建证据链

- **中断现场（砚砚只读核验）**：上一 r4 节写作途中会话中断——TS 源码仍是 `3e08cd044` 旧版（parent-breed 推断，hash 与该 commit 完全一致），r4 实现只留在 gitignored `dist/config/cat-catalog-store.js` 里；ragdoll 新用例当时"绿"是**读 stale dist 的假绿**。**上一节「验证」行（catalog 45/45、13 套 706/706、build 绿）全部基于 stale dist，在此作废**，以本节重建证据为准。
- **恢复动作**：把 dist 中已验证的 r4 语义逐处移回 TS 源码——① `PROMOTED_SUBVARIANT_TAKEOVERS = new Set(['ragdoll::opus-47'])` 常量 + 出身规则 docblock；② `migrateCatalogVariants` 签名回单集形态 `externalStandaloneBreedIds?: ReadonlySet<string>`；③ Step 4 过滤弃 parent-breed 推断，改 exact `(breedId, variantCatId)` allowlist 门（`breedId::variantCatId`）+ 墓碑不认领注释；④ helper `readTemplateMigrationScopes` → `readLiveTemplateStandaloneBreedIds`（单集、tombstone 排除、无 readable template 返回 undefined）；⑤ `readCatCatalogRaw` 调用点同步；⑥ 函数 docblock 更新（"Only the shapes recorded in PROMOTED_SUBVARIANT_TAKEOVERS are dropped; parent-breed template membership alone is not ownership"）。`grep` 证实 `externalTemplateScopes`/`readTemplateMigrationScopes` 零残留。
- **lockfile**：`pnpm-lock.yaml` 的 install 漂移（删两个 importer + libc churn）已 `git checkout --` 剔除，不进本分支。
- **重建证据（全部对 rebuilt dist，非 stale）**：
  - 正规 rebuild：`pnpm run build` exit 0；dist `cat-catalog-store.js` shasum `91d92de4…`（stale）→ **`dcf065f5…`**（重建后），`PROMOTED_SUBVARIANT_TAKEOVERS` 标记 3 处在位
  - ragdoll 回归单跑 **1/1 绿**（`hand-built qoder member nested under a template breed` 用例，rebuilt dist）
  - 扩展回归 **18 套 661/661**（= 14 套 531/531：cat-catalog-store / cat-config-loader / system-prompt-builder / a2a-mentions / agent-router / cat-account-binding / qoder-slice2-registration / qoder-l2-tool-surface / origin-upstream-boot-smoke / cat-catalog-subscriber / cats-routes-runtime-catalog / catalog-accounts / connector-config-tombstone / f317-qoder-fixture-readside-gate；+ 4 套 130/130：qoder-agent-service / qoder-ndjson-parser / agent-router-speech-mentions / account-binding-subscriber）。说明：中断前 note 所称"13 套 706/706"的精确构成已随会话封存不可复述，本节按可辩护面重建并逐套列名；覆盖只增不减于 9 套已知敏感面
  - biome：0 error；6 条 `noExcessiveCognitiveComplexity` 警告与 main 同文件**同数同分**（migrateCatalogVariants 复杂度 68=68），无新增噪声
  - `git diff --check` 干净；工作树仅 src/test/note 三文件，lockfile 已还原
- **教训（自留）**：中断恢复时"测试绿"必须先证明跑的是新产物——dist 指纹 + 标记核对先于任何用例执行；这正是本次砚砚退回的根因之一。

`[谱谱/glm-5.3🐾]`

## E2E 验收收档（2026-09-18 07:30Z，谱谱）

Slice 3 合入（PR #37）+ #38 memory policy 修复 + #39 重启（live dist `1b100c125`）后的严格验收：**PASS，毛线球闭合**。

- **触发**：谱谱 15:26:50 CST 行首 `@qoder` 只读探针（`git log --oneline -1`）
- **三层独立证据**：
  1. raw archive（谱谱读）：init `tools` = 6 basic + 12 `mcp__cat-cafe-memory__*` = **18**，`mcp_servers=[{cat-cafe-memory, connected}]`
  2. profile log（点点读，run `2026-09-18T15-26-51-147+08-00-afb7pc-p62735`）：`tool_schema_count=18`、`Connected servers: 1 … cat-cafe-memory`、9 个 `mcp-check-sync` checker、`--strict-mcp-config` + memory-shim 在跑
  3. 银线第一人称：本 invocation 18 工具 + 实调只读 `list_recent` 返回真实条目（F155, 2026-09-18）——不止注册可达，memory 面真读通
- **探针结果**：exit 0，stdout = `bbf12e339 docs(review-notes): convict the F280 hold owner fence root cause…`，模型 `Qwen3.8-Max`
- **已知非阻塞噪声**：同 run `syncEndpointAsync`（gateway.qoder.com.cn endpoints 探测）`AbortError` → failover，非 #38/#39 回归
- **附带观察（另记毛线球）**：15:29 resume 形态 run 的 InstructionsDelta 显示 memory server removed / 空工具面——与 controlled 首启形态不同，疑似 resume 或异 policy 路径，防长成第二个 resume 分支坑；银线回传时把回球句柄写成了字面 git 路径（`@.git/refs/...`，未路由）——与「qoder 导航指向调不到的工具」同族的输出卫生问题
- **钥匙串弹窗定罪（同日，铲屎官问）**：qoder CLI 内建 keytar/Keychain 适配存 OAuth 凭证，未签名 sandbox 进程每次触发弹窗；无 CLI 开关。修复线：b) 凭证迁文件存储（调查中）c) L2 沙箱补钥匙串隔离（Seatbelt deny securityd，需跨族 review）

`[谱谱/glm-5.3🐾]`
