# F247 roleless DOM 修复 — Merge 记录（2026-10-28）

PR: 08mamba24/clowder-ai#59 · 分支 `fix/f247-roleless-dom-return`
最终 HEAD: `170a1b68933b399632c454010fd84747a0e8b14d`
Merge commit: `3f1380a22ddd02832d8e7ab238005f71e86b15dc`（squash）
Merged at: 2026-10-28T15:06:08Z

> 上游实施报告见同目录 `implementation-report-pupu.md`（记录的是 `b387f092a`
> 首版状态，其中 "push 状态：未推" 已被本记录取代）；本文件只追加最终状态，
> 不改写实施报告的历史事实。

## Reviewer

金渐层（`cat-cr4egn4o`，glm-5.3），**非作者**，独立复审 HEAD `170a1b689`：**approved**。
上一轮 `b387f092a` 的 verdict 不适用于新 SHA，本轮全部按新 SHA 重测。

复审证据（reviewer 亲跑，非转述）：

- P1 修复实测翻绿：`existingUserMessageIds` 同时快照 legacy + roleless bubble 的
  Host ID；独立复现脚本指向新 HEAD 得 `receipt = new-message-id`。
- P2 多段落投影：失败方向全部 fail-closed（块数不匹配 → `HOST_MESSAGE_ID_UNAVAILABLE`，
  无错绑路径）；新增测试断言 `userBubbleTextExactMatchCount===1`。
- bundle↔source 一致：`build-f247-personal-chrome-extension.mjs` 检查模式 exit 0
  且 worktree clean，提交的 `content-script.js` 与源码新构建逐字节一致。
- 测试：roleless-dom(10) / page-adapter(29) / multiline(10) / installation /
  extension-contract / live-gate×3 / normal-dispatch-live-gate = **89 pass / 0 fail**。

## Merge 执行者的独立验证

merge 前（不依赖 review 转述）：

- PR HEAD == reviewer 复审 SHA（`170a1b689`），`mergeable=MERGEABLE`。
- main **无 branch protection**（`gh api .../branches/main/protection` → 404），
  无 required status checks 硬阻断；因此两红检查是否放行属判断项，非平台强制。
- 两个红检查与 main 基线**同因**，逐行日志比对：
  `check-dir-size` 三条 exception 于 2026-10-27 到期
  （`concierge/live`、`concierge/live/host`、`growing`）。
  PR #59 diff 的 23 个文件**未触碰**这三个目录 → 非本 PR 回归。
  main 最新 run `40698844267` 同样只挂这两个 job。
- 其余检查全 SUCCESS：Build、Test (Public)、Test (Windows)、
  Test (Windows, installed layout)、Fork compatibility、Public test plan /
  contract surfaces / 6 个 distributable shards / evidence。

merge 后：

- `git diff 170a1b689 origin/main -- packages/api/src packages/api/scripts packages/api/package.json`
  → **空**。squash 未丢失任何源码改动，merge 后的 main 与送审 HEAD 逐字节一致。

## 残留（不阻塞，转后续）

- **P3 软换行**：同一 `<p>` 内的 `<br>` 软换行不产生独立 text node，两个投影都看不见，
  仍会落 `HOST_MESSAGE_NOT_OBSERVED`。失败方向安全（不错绑），ChatGPT 主流渲染是
  每行一个 block（已被新投影覆盖）。另立跟进。
- **P3 运维**：部署链 = runtime 升级到 merge commit `3f1380a22` + A 路径扩展 reload
  （同 ID）。reload 后 operator 下一条 `@gpt-pro` 自然成为验收 dispatch。
- **基线红**：`check-dir-size` 三个 exception 过期（2026-10-27）需另线续期或治理，
  与 #59 无关但会持续挂红所有 PR 与 main。

## 终验判据

扩展 reload 后的真实回程，ledger 错误码应从 `HOST_MESSAGE_NOT_OBSERVED`
迁移到 `HOST_MESSAGE_ID_UNAVAILABLE`（roleless 无真实 ID 的诚实失败）
或直接拿到真实回执。

`HOST_MESSAGE_ID_UNAVAILABLE` **不等于** Browser 回传成功——它只证明"正文观测到了、
但页面没暴露真实 Host ID"，是诚实诊断而非修复完成。

[点点/deepseek-flash🐾]
