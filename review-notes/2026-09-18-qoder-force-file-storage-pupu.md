# F317 钥匙串弹窗修复：QODERCN_FORCE_FILE_STORAGE 双路强制注入 — 谱谱/glm-5.3

- 分支：`fix/qoder-force-file-storage`（worktree `clowder-ai-wt-qfs`，base = `origin/main` `1b100c125`）
- 上游：铲屎官 2026-09-18 07:47Z 问「能避免弹钥匙串吗 + 排查同类」→ 指令「方案先和砚砚对，实现完让 review」→ 砚砚方案预审 CHANGES_REQUESTED（2×P1+1×P2）→ 本实现按其收紧后的口径
- 事故：qoder CLI（keytar/Keychain 适配）每次 spawn 以新未签名进程读写登录钥匙串 → 操作员每跑必见弹窗

## 按预审逐条落实

1. **变量名（P1-1）**：独立复核本地 1.1.51 bundle：`Rr(A)=\`${L9}${A}\``、`L9=Ro?"QODERCN_":"QODER_"` → **`QODERCN_FORCE_FILE_STORAGE`**，与砚砚在 live 1.1.55 的解码同构。裸 `FORCE_FILE_STORAGE` 两版都不读——已弃用。（版本注：本地仅装 1.1.51 且 live raw archive init 自报 `qodercli_version:"1.1.51"`；两版结论一致，变量名跨版本稳定。）
2. **双路覆盖（P1-2）**：`buildControlledQoderEnv()`（导出供 env 契约测试）与 `buildQoderEnvOverrides()` 都在**最终显式写入** `QODERCN_FORCE_FILE_STORAGE='true'`。disabled 路的 deny 规则会把继承的 `qoder*` 键清 null、callback/account 源里的 `qoder*` 键跳过——最终写入是唯一写，三路 `false` 压不过。
3. **根因表述（P2）**：采正——该开关控制 keychain-backed hybrid token/secret 存储（含 MCP secret 面），不主张等于主 OAuth 登录存储；**不预设"必须 OAuth 重登"**，真实风险 = 已有 keychain token 不自动迁移到文件后端；cat-cafe-memory 无 MCP OAuth 预期不受影响。
4. **实验（原四项，含物理上限的诚实结论）**：
   - ✅ 正确变量名 + 临时 profile（零 live 接触，`QODERCN_CONFIG_DIR` 指向 mktemp 目录）
   - ✅ FORCE 下连续两次最小启动正常（`--version` + `-p` 探针均 exit 如期），auth-storage 链路干净初始化（`credential.load outcome=missing` = 新 profile 预期）
   - ✅ 落点：全部新文件都在传入 config-dir 内；`.auth/machine_id` mode 600（`settings.json`/`installation_id` 644 为 CLI 既有行为，同 live profile，非本修面）
   - ⚠️ **物理上限**：临时 profile 无凭证时 keychain 路径根本不触发——对照组（无 FORCE）与处置组行为同形、零 keychain 痕迹，故 `token_storage_initialization: type=encrypted_file forced=true` 计数器（telemetry 面）与"零弹窗/登录可复用"**在无凭证环境不可观测**。伪造加密文件不可行（salt 加密）。残留验收（telemetry 直证、零弹窗、主 OAuth 可复用、`auditQoderProfile` 二启绿）**转 post-merge live 首跑验证**——live 有真凭证，第一次受控 spawn 即是实验；若登录缺失，按预审纪律"只报告并停"，回滚开关或走一次 OAuth 重登由 operator 定。

## 测试与证据

- 红测先行：两用例（disabled 三路 `false` 压制 + 最小输入仍强制；controlled 最终写 + 导出契约）。红侧直读 dist 行为证：base `1b100c125` 上 `QODERCN_FORCE_FILE_STORAGE=null`、controlled builder `undefined`；修复后 `'true'` / `function`。（过程留痕：红侧 test-runner 只识别到 1/2 用例的异常未解，故补 dist 直读作无歧义红证；绿侧 2/2 常规通过。）
- 全文件回归 `qoder-agent-service.test.js` **84/84**；biome error 级 0（13 infos 既有）；`git diff --check` 净；`pnpm install --frozen-lockfile` 零漂移
- 改动面：`QoderAgentService.ts`（两个 builder 各一段 + 一个 export）+ 测试两用例——与预审"实施面保持在 QoderAgentService.ts + 对应测试"一致；profile audit 未动（预审确认现状已允许）

## 下一棒

@砚砚m 正式跨个体 review（铲屎官指定流程）；approve 后走代推通道（我 shell 无凭据）。merge 后验收 = live 首个受控 spawn：零钥匙串弹窗 + 主 OAuth 可复用 + profile audit 绿；异常则只报告不动 live 登录态。

`[谱谱/glm-5.3🐾]`
