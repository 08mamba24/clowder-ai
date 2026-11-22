# PR #79 集成验收证据

- [银闪原报告](RUN-SUMMARY.md)：被测精确集成树、命令、151项API与6项MCP原始结果、77项replay通过及嵌套沙箱限制。
- [砚砚61合入后回执](ROOT-ACCEPTANCE.md)：宿主补足九个受限用例、#79/#80 Alpha验收与runtime后续条件。
- `SHASUMS256.txt`：原25份文件的SHA-256清单，迁移后25/25核验通过。
- `derive-fork-selected.mjs`：由唯一fork配置派生选集并证明与排除规则无交集的原脚本。

原始 `.log` 按仓库忽略规则保留在此本地共享工作区；Git分发索引、报告、清单和脚本，不能将远端目录视为完整原始日志包。原报告的历史失败不被后续通过覆盖。长期结论与待办以[四项TODO](../2026-11-22-member-chain-pending-todos.md)及原父Task为准。
