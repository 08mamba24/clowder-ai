---
feature_ids: [F145, F159]
topics: [dsh, acp, mcp, startup-readiness]
doc_kind: pr-body
created: 2026-09-03
branch: fix/acp-cold-start-mcp-readiness
commit: d13f9b5
target: deepseek-ai/deepseek-harness (PR A)
---

# PR A body（待推送后使用，标题即 commit subject）

**Title**: `fix(acp): gate ACP initialize on the Loader tree settle`

## Problem

A cold-started ACP process mounts its stdio transport while root-sibling
`dsh-mcp-client` entries are still inside their connect→listTools window
(root entries mount in parallel; the transport's stdin handler is installed
during `acp-demo`'s own apply). A client that connects immediately can
complete `initialize → session/new → prompt` before MCP registration, so the
first model request ships a partial tool inventory. Observed on a real Cat
Cafe deployment: first `request/header` 19 tools / 0 MCP, next turn
139 tools / 120 MCP; the model then falls back to shell/CLI probing, which
amplifies user-visible latency (287s and 57s user-cancelled invocations).

## Fix

In `@deepseek-ai/dsh-acp`, the `initialize` handler now structurally reads
`ctx.get('loader')` and awaits `loader.await()` before advertising the agent.
That settles only when every configured entry has activated (MCP clients
complete connect + initial tool registration), so `session/new` and `prompt`
can no longer run ahead of required tool registration:

- fail-closed: a settled entry failure rejects `initialize` with an internal
  error whose message preserves the failing entry's server name and original
  cause via the existing `errorChain` (no credentials in messages).
- Loader-less deployments (`loader` service absent) pay no behavior change —
  the gate is a no-op there, and existing bridge tests run without it.
- No fixed sleeps: readiness is proven by the Loader tree itself.
- Alternative considered: app-owned MCP config under `acp-demo` (explicit
  child lifecycle) is compatible with this barrier and remains available as a
  stricter option if maintainers prefer it; this PR takes the generic
  application-ready barrier so sibling-mounted MCP configs (current Cat Cafe
  overlay shape) are covered without a config migration.

## Tests

New `packages/examples/acp-demo/tests/startup-readiness.e2e.ts` (real bin +
Loader + stdio, no artificial client sleeps):

1. delayed MCP fixture (4s listTools window): first persisted
   `request/header` already contains `mcp__fixture__ready_probe`
   (red pre-fix: only built-in tools).
2. two MCP servers completing in different order: first header contains both.
3. required MCP server that cannot start (`failOnStartupError: true`):
   `initialize` fails before any session/prompt; stderr carries the
   `mcp-client` diagnostic.
4. client disposes during readiness: pending `initialize` settles, no hang.

Shared fixture `packages/mcp/mcp-client/tests/fixture-server.ts` gains
`STARTUP_RACE_LIST_TOOLS_DELAY_MS` (default 0), a `ready_probe` tool, and
stdin-EOF exit (no leaked MCP children).

Bridge-level unit tests (`bridge.spec.ts` + `harness.ts` readyGate injection):
gate pends initialize until settle, maps settle failure to an internal error
that names the failing entry, and is re-checked on every initialize.
`packages/acp/acp` coverage stays at 100%.

## Regression matrix (local)

- dsh-acp unit: 85 passed
- acp-demo unit: 12 passed
- mcp-client unit + e2e: 199 / 22 passed (fixture extension is default-inert)
- load-path e2e (no-MCP config): unchanged, passed
- startup-readiness e2e: 4 passed (red pre-fix → green post-fix)
- oxlint: 0 errors; `tsc -b packages/acp/acp`: clean

## Notes / follow-ups

- No timeout on the gate: a plugin whose apply never settles would hold
  `initialize` indefinitely; a bounded client-side timeout belongs to the
  consuming side (Cat Cafe PR B), not a fixed sleep in this repo.
- PR B (08mamba24/clowder-ai) should additionally remove the ambient
  `CAT_CAFE_AGENT_KEY_FILE` inheritance and consume the readiness contract
  before pooling a client.
