# F317 Qoder native GitHub read repair

Author: 小星星 / gpt-6-astra
Task: `0001789956139661-000388-6c663874` (doing)
Thread: `thread_msqw8n1bqpvmob6f`
Branch: `fix/qoder-github-live`, base `2ea10c22c93bcf71edc589e3b4b81461e4e59bd3` (merged PR #42)

## Problem and decision

The live qoder-flash invocation produced `capability_unavailable` before query
classification and zero broker audit events. Installed qoderclicn 1.1.51 wraps
Bash in `source ... && eval 'user command' ...`; the old parser required its
first token to be `gh`. The old HTTP test fed the wrapper a bare command and
therefore did not exercise the native carrier boundary.

Independent design review: zcode message
`0001790129344358-000040-4a915b41` recommends the existing native HTTP MCP endpoint
and removal of shell translation. This is design review, not implementation approval.

The repair writes the invocation bearer only into the private native MCP config.
Only a granted controlled invocation mounts the exact repository-read tool/server.
The 18-tool ungranted and empty read-only surfaces remain exact. Both workspace
and memory Seatbelt policies deny the config; the startup probe tests its real path.
Shell translation, its client/parser and their now-obsolete tests are removed.
The guarded CLI keeps a harmless version probe and directs reads to the MCP tool.
The provider still closes its stream, revokes the grant, then disposes the config.

## Architecture and risk

Architecture cell: github-signals / identity-session
Map delta: identity-session carrier description updated; no new owner or route
Why: native MCP reuses the existing invocation authority and read executor
Canonical source: `AgentGitHubReadBroker.open/query` and `QoderAgentService.invoke`
Consumer evidence: `rg -n 'openGitHubReadLease|AgentGitHubReadBroker' packages/api/src`
Claim guard: granted/missing/extra/disconnected init, deny canary, recorder failure,
spawn failure and iterator cancellation in `qoder-agent-service.test.js`;
HTTP protocol denial/audit/revocation in `agent-github-read-qoder-http.test.js`.
Migration/restart/rollback: no storage migration; activation is a separate operator
restart after merge. Revert this delta restores the prior (live-broken) Qoder path.

Risk: behavior, security and carrier contract; independent review and a new-delta
full gate are required. Prior PR #42 evidence is historical, not this delta's gate.
No production runtime config, process or persistent data was modified.

## Observed evidence

- RED: managed command preceding this wake built API then ran
  `node --test --test-name-pattern="GitHub read MCP:" test/qoder-agent-service.test.js`.
  Exactly two failures: missing allowed tool and missing HTTP server configuration.
- Native source: installed `@qodercn-ai/qoderclicn@1.1.51`, SHA256
  `30118c79297fce530c196adf1cf6b7bef09f71fdd5b42bcc6662baaca8e4e7a1`.
  `pot → Vyn → Uqi` supplies per-server headers to the HTTP transport;
  `Kyn.tool()` projects only name/description/parameter schema, and `Mu` model
  identity/classifier projections omit the private server config.
- Native diagnostic (auth-free temporary HOME/profile/workspace, synthetic local
  server): authenticated initialize, initialized notification and tools/list;
  real init declares exactly `mcp__clowder-repository-read__github_read` and a
  connected server. Output/stderr and all generated files contained zero bearer
  matches outside the input config. Terminal was expected account-auth failure.
- This native observation does **not** prove a model-driven tools/call, authenticated
  model request or live AC1. Source inspection supports the model-schema boundary;
  live query/audit/revoke acceptance remains required after activation.
- Reproducer is now tracked at `packages/api/test/fixtures/qoder/probe-http-mcp.mjs`;
  pass the absolute installed CLI JavaScript path. It creates only isolated local
  fixtures and retains them for inspection, never opens a real model account.
- First GREEN attempt: dependency/API builds and both shell tests passed;
  API regression run was 127/128 green. The one failure was a new test fixture
  missing required `pr_list.state` (scope-denial fixture also lacked list fields).
  MCP schema correctly rejected before execution. The fixture now uses the exact
  schema and checks `isError` before parsing content. Only this test needs a
  targeted rerun; the unchanged 127 green cases are not repeated for ceremony.
- The descriptor source is trusted `AgentGitHubReadBroker.open`: construction
  validates loopback, the path is fixed, and randomBytes(32).base64url fixes the
  bearer alphabet/length. No agent input can write descriptor fields. ZCode's
  adapter descriptor validator remains necessary for its separately serialized
  native-create boundary; Qoder consumes the host lease directly.
- No UI changes or matching design artifacts (`designs/` absent in this export).
  Pre-merge native evidence ends at account-auth failure; authenticated personal
  cat invocation remains assigned to the durable task after authorized activation.
- Follow-on RED at `94fc12282`: `/401/` incorrectly expected the SDK error message
  to contain the HTTP status. SDK 1.26.0 stores it in `StreamableHTTPError.code`,
  while the message carries the response body. The assertion now requires both
  `code: 401` and the exact `capability_unavailable` response code; no production
  behavior changed and the denial requirement was not relaxed.
- Targeted GREEN: from this worktree's `packages/api`, Node 24 plus
  `bash scripts/with-test-home.sh node --test test/agent-github-read-qoder-http.test.js`
  passed 1/1 (exit 0). The managed RED log remains at
  `/tmp/f317-qoder-native-94fc12282-gate.log`; that run stopped before native probe
  or full gate, so it is not evidence that either ran.
- Repeated tracked native probe passed (probe exit 0; isolated child exit 1 is the
  asserted account-auth failure), same CLI version/hash above. Authenticated
  initialize, initialized notification and tools/list were observed; bearer
  matches in generated files and output were zero. Retained fixture:
  `/var/folders/_v/yv2vvhm50n96kbkz0n_wyn3h0000gn/T/qoder-http-mcp-probe-slfvVJ`.

## Pending

Exact-HEAD independent review, new-delta full gate, authorized activation,
qoder-flash fresh-session AC1 and live revoke.
The task cannot close on a successful build, zcode's live result, or command ACK.
