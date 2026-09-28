# net-mode v10 复核改派请求（砚砚6 → 银线）

日期：2026-09-28
改派依据：co-creator 消息 `0001790604655340-000047-cdc07018`（"换个猫猫复核？银线呢？"）。原改派消息 `0001790176176613-000288-df206241` 指定砚砚6，因其 provider_unreachable 由本条 supersede。
请求人：谱谱（v8–v10 作者，zcode/glm-5.3）　复核人：银线（@qoder / Qwen3.8-Max，俄罗斯蓝猫）
复核对象：`net-mode-dev/` v10（国产 API 分流候选安装包；未安装、未实机验收）

## 治理核对

- v8–v10 作者 = 谱谱（Ragdoll 家族）；复核人 = 银线（俄罗斯蓝猫家族）→ **跨族复核，符合铁律**。
- **软冲突披露**：v1–v7 基础代码作者 = 银闪（qoder-flash，与银线共用 qoder 账号、同族不同个体）。规则允许其复核，但请银线对 v1–v7 遗留部分**额外从严**——同账号来源，不给自家旧代码放水。
- 原复核人砚砚6（gpt-6-sol）自 2026-09-27 起路由信号 provider_unreachable，v10 于 09-24 交回后未复核。

## 复核范围（v10 增量，按优先级）

1. **新攻击面优先**：guard 机制是 v10 新代码（不变量⑧：一切资产写入/移除统一走 锁内核租约 → temp → 内建原子发布；guard 被杀无孙进程、被接管无提交窗口）——请构造**新的**交错窗口攻击它，不限于复现已修的问题。
2. v9 P1 终验：死亡 holder 的存活子进程在成功卸载后写回孤立 hook——在 v10 上用**自己的复现脚本**证伪（不可构造才算过；不要只跑作者的 `test/pupu-v10-crash-fence.zsh` 50/0）。
3. 常驻套件复跑（冻结字节、当场跑）：`zsh test/run-tests.zsh`（431 项）、`pupu-v10-crash-fence.zsh`（50）、`pupu-v9-lifecycle-fence.zsh`（50）、`yanyan-v7-uninstall-lifecycle.zsh`（53）。作者 2026-09-28 当场复跑 431/0 与 50/0，复核方需独立再现。
4. 六条裁定 + 全流程不变量（README 头部）与实现的一致性抽查。

## 材料指针

- `net-mode-dev/README.md` —— 审查链（v1–v10）、六条裁定、全流程不变量、先红后绿证据全记录
- `net-mode-dev/lib/nm-split.zsh` v10 头注 —— v9 P1 的修法说明
- 前轮审查证据（**只读**，不得就地运行，只能复制出沙箱）：`tmp/net-mode-review-v9-20260924-yanyan/`（含 `review-crashed-holder-child.zsh`）；v5–v8 各轮目录同前缀
- 交接背景：`review-notes/2026-09-23-net-mode-v8-handoff-state-yinshan.md`

## 边界（与历轮一致）

只读写 `net-mode-dev/` 与自建 `tmp/net-mode-review-v10-20260928-yinxian/`；不碰 `~/.config/net-mode.zsh`、`~/.zshrc`、Clash 运行时配置、`/etc/resolver`、系统 DNS/route/launchd；不切 VPN；不执行真实 sudo（`test/shims/sudo` 是 PATH 桩）；其他审查方目录只读；不回显密钥值；`net-mode-dev/` 整体不提交、不推送。复核结论以 REVIEW.md + 复现脚本落盘为准（消息不是真相源）。

复核通过后的实机安装/验收仍由 co-creator 手动执行（AGENTS.md 铁律 3），猫猫不得代做。

[谱谱/glm-5.3🐾]
