# ZCode CLI 0.16.5 compatibility

## Scope and source

Operator request (2026-09-14): “那你这里zcode能并行去别的worktree修改并验证吗”.
Implementation is isolated in `fix/zcode-cli-compat`, based on `6ca8b14c0`.
It retains the Hub native app-server adapter, native session IDs and persistent
session storage. It does not modify the user's ZCode configuration or runtime.

Architecture cell: existing ACP provider adapter.
Map delta: none. Why: repair the existing native transport and model binding.
tips_exempt: Corrects the existing ZCode integration; no new operator action or capability.

Protocol evidence comes from the installed official desktop bundle, not a
community wrapper: App 3.12.1, CLI 0.16.5,
`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`, SHA-256
`5a80496a781802aa4a2fcd7627fc65fc1d9eb6d1a016c80fb65da3d911bf241b`.
The version string alone is not a protocol guarantee. Older 0.16.3 fixtures
remain regression evidence for shared turn events, not a live compatibility claim.

## Reproduced causes and changes

1. CLI discovery did not find the desktop `Resources/config/provider` layout.
   Resolve the built-in provider file relative to the selected real CLI path;
   supply both explicit native provider paths. A missing explicit CLI cannot
   silently select a different installation.
2. ACP initialization advertised readiness before the native child was usable.
   It now waits for a bounded, read-only `session/list` response. Missing files,
   malformed results, timeout and native exit return a sanitized ACP error.
3. Current CLI no longer selects a clean-home model from `ZCODE_MODEL` alone.
   Real CLI prompt reproduced `CONFIGURATION_ERROR: Select a model before continuing`.
   Generate schemaVersion 1 personal provider rules from the invocation's Hub
   account and catalog model, using a private input file per native process.
4. Cold restore after a model change left the old model unavailable. Current
   `session/setModel` rejects the former `runtimeModel` overlay and requires
   `model.options.reasoningLevel`. Read the native snapshot's available model
   and default reasoning level, then select it without changing the workspace
   default (`persistAsWorkspaceLastUsed: false`). Retain cancellation generation
   checks around the single pre-admission `-32031` recovery attempt.

The installed built-in provider file is read-only input. Ambient provider-refresh
and data-path variables cannot redirect the native child outside the isolated
home. Generated provider files have mode 0600 inside mode-0700 random directories.
Explicit close removes them before waiting for child shutdown; process exit and
native close also clean them. A later adapter start reclaims only directories
whose encoded owner PID is confirmed absent (ESRCH). Live/PID-reused owners and
all native history remain untouched. Abrupt host failure may leave a private
credential input until that next start; no session TTL or history sweep is added.

## Acceptance evidence

Targeted tests: 36 passed, 0 failed under Node v24.18.0. Coverage includes both
provider layouts, symlinks, missing explicit CLI, ambient path contamination,
native exit/error/hang/malformed readiness, stderr redaction, cancellation races,
history restore, generated-file permissions, live-owner protection and orphan
input recovery. The stubborn-native shutdown cleanup test failed before the
cleanup change and passed afterward.

Real CLI lifecycle: passed under Node v24.18.0 using **local synthetic Anthropic
SSE servers and dummy keys**. Thirteen HTTP requests verified nonempty streaming,
the requested model, cancellation closing the actual upstream response, the next
turn succeeding, cold process restore retaining earlier content, parallel native
sessions, and two native processes with the same model and different keys/ports.
The two provider responses wait for both requests to be in flight; assertions
check each key/port and both histories after cold restart. Model change to
GLM-5.4 then restores and continues the original session.

The live run used macOS Seatbelt: only test-local IP traffic and Unix sockets,
scratch writes, and denied reads of user `~/.zcode` and `~/.cat-cafe`.
Evidence scratch: `/private/tmp/zcode-compat-pd8hpmvr/zcode-native-lifecycle-S4wzep`.
This proves native protocol and transport behavior, not a real provider response
or external account authentication. A dedicated test credential source was
requested from the operator; no production credentials were read.

Reproduction from `packages/api` (Node 24):

```sh
env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash scripts/with-test-home.sh node --test --test-concurrency=1 --test-timeout=15000 test/acp/zcode-acp-provider-config.test.js test/acp/zcode-acp-startup.test.js test/acp/zcode-acp-bootstrap.test.js test/acp/zcode-acp-adapter.contract.test.js
env CAT_CAFE_ZCODE_LIVE=1 CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash scripts/with-test-home.sh node --test --test-timeout=100000 test/acp/zcode-acp-native-lifecycle.test.js
```

## Gate status

Independent review found two P2 items: shutdown credential cleanup and missing
same-model cross-process account evidence. Both were addressed. Independent
re-review passed 30 relevant tests and repeated the 13-request native lifecycle
under Node 24.18.0. Both synthetic homes were scanned: no dummy key remained in
359 files per home. The real-CLI no-prompt startup/load test also passed (3 tests).

Full repository gate (managed job
`managed-gate-7b3de1f9-3105-4fa6-ade8-55ea86110b77`) exited 1 after 1355 seconds.
Build and TypeScript completed; the public API test stage reported 23,522 tests,
22,708 passed and 665 failed. The initial dependency install had skipped native
scripts, so better-sqlite3 was unavailable. This worktree's dependency was rebuilt
under Node 24 (`pnpm --filter @cat-cafe/api rebuild better-sqlite3`), and an
in-memory SQLite query passed. No application database was opened or changed.

Post-rebuild recheck of all 97 files that failed the original gate: 1,018 tests,
1,002 passed, 16 failed, no cancelled or skipped tests (75.5 seconds). The native
binding failures are gone. All remaining failures are outside this diff:

- Qoder: 15 failures; `test/fixtures/qoder/current` is absent in base `6ca8b14c0`.
  `verify.py` confirms no active generation; MANIFEST explicitly says genuine
  L1 capture is pending. Archived first-capture files must not be relabeled as
  verified active fixtures. The separate repair is
  [PR #21](https://github.com/08mamba24/clowder-ai/pull/21), head
  `a16f2049e8f597ba240985c2991d4f650131860f`; it is not part of this branch.
- Collective: one route test expects 200 but receives 422
  `ROUTE_THREAD_UNAVAILABLE`. Its thread fixture defaults to `owner_1`, while
  imported request headers default to `owner-user`. Both source files are
  unchanged from the base commit. The imported helper is
  `packages/api/test/plugin-official-routes.fixture.js`.
  This needs a baseline fixture correction.

These shared gate blockers were coordinated with the PR #20/#21 owner in
`thread_msqw8n1bqpvmob6f#0001789374705734-000093-f5a3790c`.
The failure-set log is
`/private/tmp/zcode-compat-pd8hpmvr/post-rebuild-failures.log`.
Web lint passed (existing warnings), and the remaining `pnpm check` stage passed
separately (exit 0). Its log is
`/private/tmp/zcode-compat-pd8hpmvr/post-gate-check.log`.
These checks do not convert the failed full gate into a pass.

`check-hotfix-pattern.mjs` correctly identifies a hotfix: independent review is
required and author self-merge is prohibited. `check-fallback-layers.mjs` reports
threshold hits; coordinate review found no retry/fallback stack:

- Provider input uses the two already-supported API-key environment aliases and
  the existing official Anthropic URL default. Two catches respectively clean
  a failed file write and distinguish ESRCH from a live/inaccessible PID. The
  other two matches are boolean validation guards, not fallback choices.
- Lifecycle tests select an explicitly supplied CLI or the installed desktop
  CLI; select the restore account key or the original test key; and check either
  child exit field. These express test cases and process state.
- Adapter catch handling and fake response defaults replace existing boundaries;
  they do not add recovery attempts. The only model recovery remains the
  existing single pre-admission retry, now using the current native schema.

Full gate is still **not passed**. Baseline test repairs, a passing integration
gate and real-provider acceptance are required before claiming complete
acceptance. Independent sub-agent review is supporting evidence; no merge-gate
approval has been issued. Production code remains identical to implementation
commit `c7e5a2374c5c3047acdc0ec15690cf40126be720`; only this evidence report was
updated afterward.
No UI or design artifact is involved (`designs/` is absent in this export).
The exported package has no `check:architecture-ownership` script; record as a
warning, not a passed check. Real-provider acceptance remains pending dedicated
test credentials. No merge or production rollout has occurred.
