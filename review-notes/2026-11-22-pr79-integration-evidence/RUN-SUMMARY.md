# PR #79 integration verification — sandbox run summary (qoder-flash / 银闪)

Date: 2026-11-22 (UTC). Verifier: 俄罗斯蓝猫/银闪 (@qoder-flash), split task 0001795359172058-000171-eab2a698.

## Tested object
- HEAD under test: `7c343436e157c03eeceda71b2ee6fa540faea37d` — git parents verified verbatim:
  `8ae076016772625a97c87762aaecad7787ea6fb6` (main, integration base) + `e276daef0ff147569ad26e61f56724f2e8b81ff1` (approved head).
- PR diff (`8ae076016..7c343436e`): 7 files, +750/−14 — invoke-single-cat.ts, routing/incremental-rebuild-replay.ts (new), route-parallel.ts, route-serial.ts, context/ContextAssembler.ts, test/helpers/cold-rebuild-bootstrap-degradation-fixture.js, test/native-acp-incremental-rebuild-route.test.js (new, 547 lines).
- Execution tree: `.pr79-int-verify/` = `git archive 7c343436e | tar -x` (byte-exact commit content). The assigned host worktree `/Users/yuhan/cat-cafe/worktrees/pr79-integration` and `/tmp` (incl. `/tmp/pr79-fork-compat.log`, `/tmp/20261122-pr78-fork-selected-check.mjs`) are unreachable from my L2 sandbox — raw error `Operation not permitted`. I did NOT touch the worktree; verification ran on the exact-content export.

## Environment
- Node v24.22.3, pnpm 9.15.4, macOS 27.2 (arm64).
- Isolation via canonical `packages/api/scripts/with-test-home.sh` (temp HOME, NODE_ENV=test, `REDIS_URL=redis://127.0.0.1:0` non-connectable) + `CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1`.
- Builds (all exit 0): shared `tsc` → mcp-server (prepare-secret-runtime staged 92 tracked package-local inputs, verified source-closure-bounded, no host secrets) → api. Logs: `build-shared.log`, `build-mcp-server.log`, `build-api.log`.

## Canonical resolver — original failure PRESERVED (not patched)
- `node scripts/resolve-fork-compat-tests.mjs` → exit 1, stderr:
  `public test exclusion "f306-native-home-provider-hooks" is expired (2026-11-13 < 2026-11-22)`
  Same class as the recorded `/tmp/pr79-fork-compat.log` exit-1 before selection. No date/exclusion was modified. Log: `resolver-original-failure.log`.
- Because the canonical runner cannot proceed, I derived the file set from the unique selection source `packages/api/config/fork-compat-tests.json` and proved zero intersection with all 16 `public-test-exclusions.json` entries using the resolver's own match semantics (`derive-fork-selected.mjs` → exit 0, `derive-fork-selected.log`): 9 selected files (8 api + 1 mcp-server), every entry `selectionOverlap=0`.

## Fork-compat selection run (derived 9 files)
Combined api run (`fork-selected-api-run.log`): tests 151, pass 142, fail 9, exit 1. Per-file (`fork-api-*.log`):
| file | tests | pass | fail | exit |
|---|---|---|---|---|
| qoder-l2-tool-surface | 2 | 2 | 0 | 0 |
| qoder-agent-service | 95 | 89 | 6 | 1 |
| qoder-memory-policy-sandbox | 4 | 2 | 2 | 1 |
| acp/zcode-acp-startup | 13 | 13 | 0 | 0 |
| acp/zcode-acp-adapter.contract | 16 | 16 | 0 | 0 |
| acp/dsh-acp-bootstrap | 16 | 16 | 0 | 0 |
| acp/dsh-family-mcp-callback | 3 | 3 | 0 | 0 |
| origin-upstream-boot-smoke | 2 | 1 | 1 | 1 |

mcp-server group (`fork-selected-mcp-run.log`): test/toolset-callback-capability.test.ts — tests 6, pass 6, fail 0, exit 0.

All 9 api failures are environment-forbidden operations inside my nested L2 sandbox, with zero assertions against #79 code logic:
- 8 × nested Seatbelt spawn denied: `sandbox-exec: sandbox_apply: Operation not permitted` / `qoder sandbox allow canary failed (exit=71)` (qoder-agent-service L2 sandbox tests ×6, qoder-memory-policy-sandbox Seatbelt closure tests ×2). A sandboxed process cannot install a child Seatbelt profile — structurally impossible from my sandbox.
- 1 × `EPERM mkdir '/tmp/cat-cafe-acp-bootstrap-uid-501'` (origin-upstream-boot-smoke:130) — my sandbox denies /tmp; POSIX bootstrap root is intentionally hardcoded to /tmp (acp-bootstrap-cwd.ts:44-55), no env override exists, so I did not fake the path.

## Replay suite (PR #79 change coverage)
`with-test-home.sh` + setup-cat-registry preload, `--test-concurrency=1` (`replay-run.log` combined; per-file `replay-*.log`):
| file | tests | pass | fail | exit |
|---|---|---|---|---|
| native-acp-incremental-rebuild-route (new in #79) | 13 | 13 | 0 | 0 |
| native-acp-rebuild-route | 6 | 6 | 0 | 0 |
| context-assembler | 58 | 58 | 0 | 0 |
Combined: 77/77 pass, exit 0.

## Risk conclusion
- No evidence of a #79 integration defect: every failure is attributable to my sandbox's denied primitives (nested Seatbelt, /tmp), each with a captured raw signature; the pure-logic surface (zcode/dsh ACP adapters, boot-composition lock, tool surface, mcp capability, full replay set) is green on the exact tested HEAD.
- Honest gap: the 9 sandbox-denied cases could not be exercised here; a host-level run of the same 9 files (outside any nested sandbox) closes that gap. The parent composition check passed (`locks production composition: accountStartupHook before first syncAgentRegistry` ✔).
- Canonical fork gate remains exit-1 until `f306-native-home-provider-hooks` (expires 2026-11-13) is re-audited/extended by its owner — pre-existing, unrelated to #79, deliberately preserved.

## Constraints compliance
Did not modify sources/exclusions/dates, did not touch the integration worktree, did not call real models, did not change config/production data, did not restart services, did not merge, did not borrow ports or relax the sandbox.

## Rediagnosis attempts (determinism check)
Reran `origin-upstream-boot-smoke` and `qoder-memory-policy-sandbox` twice each (`rediag-*.log`): byte-identical failure signatures (`EPERM mkdir '/tmp/cat-cafe-acp-bootstrap-uid-501'`; `sandbox-exec: sandbox_apply: Operation not permitted`). Not state-dependent; TMPDIR override is irrelevant because the POSIX bootstrap root is the hardcoded literal `/tmp` (acp-bootstrap-cwd.ts:54).
