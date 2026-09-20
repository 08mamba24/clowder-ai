# #1494 round-2 formal review — CHANGES REQUESTED, one P1 remains

- Repo/PR: `zts212653/clowder-ai#1494` (`fix/mcp-strict-readonly-union`, author/custody `08mamba24`)
- Reviewer: maintainer `zts212653`, review id `5260442223`, submitted `2026-09-20T11:16:15Z`
- Reviewed exact HEAD: `4cb04f7e0ec23d260b900289e35b320ac6af6d32` on base `9bca5ae2f6e83391d5a560764e28372af4073b1b`

## Disposition of round-1 findings

| Round-1 finding | Verdict |
|---|---|
| P1 executor overwrites explicit `false` / invalid switch | **FIXED** |
| P2 five registration families drop injected `ToolsetEnv` | **FIXED** |
| P1 usable-credential parity | **PARTIALLY FIXED — still blocking** |

## Remaining P1 (inline, `packages/shared/src/utils/agent-key-credentials.ts:69`)

- Helper ignores `CAT_CAFE_AGENT_KEY_BOUND_CAT_ID` and accepts *any* readable map entry, so availability
  disagrees with the real resolver: with `CAT_CAFE_AGENT_KEY_BOUND_CAT_ID='gpt-pro'` and a readable
  `{antigravity: sidecar}`, `hasUsableAgentKeyCredentials(env)` is true but `getCallbackConfig({forceAgentKey:true})`
  returns null (no matching file for `gpt-pro`; bound-identity mismatch for `antigravity`).
- Bound identity with only `CAT_CAFE_AGENT_KEY_SECRET` reproduces the same mismatch.
- Normalization divergence: the helper trims `CAT_CAFE_AGENT_KEY_FILE`, `resolveAgentKeySecret` passes the
  literal value — `' ' + path + ' '` yields availability true but callback config null.

## Maintainer validation at this HEAD

- 31/31 original reviewer checks PASS (including the 10 assertions that failed round 1).
- New resolver-parity checks: 2 positive controls PASS / 5 assertions FAIL.
- Real `dist/index.js` stdio `tools/list` with an unusable bound identity still lists **80** tools
  (including `cat_cafe_cross_post_message`) instead of the strict **34**.
- Full MCP suite: 828/829 PASS; sole failure is the unchanged `evidence-tools.test.js:605` literal-parentheses
  assertion (#1493/#1495 separate lane, not a #1494 finding).
- Source risk: 21 PR files, `env-registry.ts` + `callback-tools.ts` high-risk, adapter manual-port.
- CI on `4cb04f7e0` independently confirmed all required checks green (Build / Lint / Test (Public) /
  Directory Size Guard / Public test shards).
- Direction under accepted bug #1492 unchanged; custody stays with the author.

## Next

Fix the bound-principal/identity precedence + path normalization in the shared helper, add bound-identity and
normalization regression cases, push a new commit (no amend/force — maintainer reviews the delta), then submit
the next HEAD for formal review.

## Fork main divergence resolved (housekeeping)

The local checkout of the fork (`08mamba24/clowder-ai`, this repo's `origin`) had diverged: local `main` carried
17 review-note commits on top of `98a1858a1` while `origin/main` had advanced to `a74503294` (upstream PRs
#39/#40/#41 merged in). A direct `git push` was rejected as non-fast-forward.

Resolution: rebased the review-note commits onto `origin/main` (the only divergence was `review-notes/*`; one
commit was already present upstream and was resolved by taking the upstream copy) and fast-forward pushed
`a74503294..c6715c390`. No force-push, no upstream commits dropped.

Note for next time: this fork `main` is the shared-state store for review notes, but it also tracks upstream
merges. It will re-diverge whenever upstream PRs land — check `git status -sb` (`ahead/behind`) before assuming
a push will fast-forward.
