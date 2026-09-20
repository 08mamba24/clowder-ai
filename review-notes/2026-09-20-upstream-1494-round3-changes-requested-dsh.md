# #1494 round-3 formal review — CHANGES REQUESTED, one self-introduced P1

- Repo/PR: `zts212653/clowder-ai#1494` (`fix/mcp-strict-readonly-union`, author/custody `08mamba24`)
- Reviewer: maintainer `zts212653`, review id `5260508977`, submitted `2026-09-20T11:55:45Z`
- Reviewed exact HEAD: `00b6f21b2f603ee2307e05f07abda951b08c84b0` on base `9bca5ae2f6e83391d5a560764e28372af4073b1b`
- Inline finding: `4056879336` @ `packages/shared/src/utils/agent-key-credentials.ts:90`
- PR state at receipt: `OPEN`, `MERGEABLE`, `mergeStateStatus=BLOCKED`, `reviewDecision=CHANGES_REQUESTED`,
  head unchanged at `00b6f21b2`; several `Public test (distributable-*)` shards still `in_progress`.

## Disposition of round-2 findings

| Round-2 finding | Verdict |
|---|---|
| P1 helper vs real resolver (bound identity + literal single-FILE path) | **FIXED** — all 38 prior reviewer checks pass |
| P1/P2 from round 1 (explicit `false`, unusable credentials, five-family env) | **FIXED** (carried over) |

The maintainer explicitly accepted the round-2 **structural** change (resolver core moved into
`@cat-cafe/shared/utils`, availability delegating to it) and asked to **keep** it.

## Remaining P1 — blank SECRET material counts as usable credentials (our regression)

The round-2 commit replaced the prior availability gate with a resolver that returns any truthy string.

Independent verification by 点点 (read the delta `4cb04f7e0..00b6f21b2` at source, not the reviewer's prose):

- `4cb04f7e0` gate: `if (env.CAT_CAFE_AGENT_KEY_SECRET?.trim()) return true;`
- `00b6f21b2` resolver branch (`packages/shared/src/utils/agent-key-credentials.ts:89-90`):
  `const agentKeySecret = env.CAT_CAFE_AGENT_KEY_SECRET; if (agentKeySecret) return agentKeySecret;`
  → `'   '` is truthy → usable.
- `hasUsableAgentKeyCredentials` delegates to that resolver, and **all four consumers route through this one
  gate**, so a single flipped truthiness decision opens both the producer and the stdio surface:

  | Consumer | Location |
  |---|---|
  | managed descriptor synthesizer | `packages/api/src/config/capabilities/mcp-config-adapters.ts:245` |
  | Antigravity executor synthesizer (`buildMcpEnvForTest`) | `.../antigravity/executors/McpToolExecutor.ts:149` |
  | stdio toolset gate (`parseToolsetEnv.hasAgentKey`) | `packages/mcp-server/src/server-toolsets.ts:62` |
  | post-message credential probe | `packages/mcp-server/src/tools/callback-tools.ts:1810` |

- Exposure: `readonly` + explicit opt-in + blank SECRET → real `packages/mcp-server/dist/index.js`
  `tools/list` returns **80** tools (including `cat_cafe_cross_post_message`), expected strict **34**;
  the executor also synthesizes opt-in from the blank value when the switch is absent.
- Maintainer's argument (endorsed): `new Headers(buildAuthHeaders({agentKeySecret:'   '})).get('x-agent-key-secret') === ''`
  — spaces/horizontal tabs normalize to an empty header value in the real fetch transport, so this is
  *absent material*, not an unverified-but-opaque key.

### The two negative expectations we inverted

| File:line | Before | After (round 2) |
|---|---|---|
| `packages/shared/src/__tests__/agent-key-credentials.test.ts:73` | `hasUsableAgentKeyCredentials({SECRET:'   '})` → `false` | → `true` |
| `packages/mcp-server/test/agent-key-credential-usability.test.ts:67` | `parseToolsetEnv({SECRET:'   '}).hasAgentKey` → `false` | → `true` |

Both edits were annotated as "parity with `resolveAgentKeySecret`" — i.e. we bent the tests to follow the new
semantics instead of holding the accepted boundary. This is exactly the maintainer's point that green tests did
not close the finding (shared 13/13 and MCP 836/837 were green *because* we changed the expectation).

## Maintainer validation at this HEAD

- 38 prior reviewer checks + the nonblank-secret control PASS; 5 new failures cover space/tab-only
  availability, executor synthesis, and the real stdio surface (80 tools / `cross_post` present, expected 34).
- API executor + adapter suites 73/73; shared credential suite 13/13; full MCP suite 836/837 (sole failure =
  unchanged `evidence-tools.test.js` regex, #1493/#1495 lane).
- No merge-readiness claim; custody stays with the author.

## Dispatched fix (口径 handed to @zcode)

1. Keep the shared-resolver structural design; **restore blank rejection in `resolveAgentKeySecretFromEnv`'s
   SECRET branch**.
2. Preferred shape (点点's stance): gate on `env.CAT_CAFE_AGENT_KEY_SECRET?.trim()` truthiness and **return the
   value as-is** — smallest delta, no change to transmitted bytes for non-blank keys. Returning a trimmed value
   changes byte-level behavior for padded keys and would need explicit justification in the commit body.
3. Update the resolver's own header doc (item 4 currently reads "truthy string, no trimming" — after the fix that
   comment becomes a lie; the drift between said口径 and implementation is this round's root cause).
4. Do not regress the three semantics already judged green: bound identity only accepts its own map entry;
   unbound shared map keeps per-call selectable-identity semantics; single-FILE path stays literal (no trim).
5. Coverage: restore both inverted assertions, plus the **producer** path
   (`buildMcpEnvForTest({SECRET:'   '})` must not synthesize `CAT_CAFE_READONLY_AGENT_KEY_UNION='true'`) and the
   **real stdio** path (readonly + explicit opt-in + blank SECRET → `tools/list` = 34, no `cross_post`).
6. Out of scope: `readAgentKeyFileSync` already returns `undefined` for whitespace-only sidecar *content*; the
   sidecar surface needs no change.

### Red evidence requirement

Unlike round 2, this round **has a genuine self-runnable red**: restore only the two assertions without touching
the implementation — at `00b6f21b2` they must fail (code returns `true`, assertion wants `false`). Red and green
output both to be attached to the receipt. The round-2 "red not self-runnable" excuse does not apply here.

## Next

@zcode adds a commit on branch A `fix/mcp-strict-readonly-union` (**new commit, no amend/force** — the maintainer
reviews exact HEAD + delta) → @砚砚 delta review → on APPROVED, 点点 pushes the new HEAD, watches CI, and posts the
re-review notice on the PR. Round-2 tracking task `0001789903731003-000226-c1743771` is confirmed FIXED by the
maintainer and can be closed; round-3 work is tracked as `0001789905524611-000243-90e1c964`.

PR tracking re-armed: `pr:zts212653/clowder-ai#1494`, generation 7, baseline `00b6f21b2` / CI `pending` /
`CHANGES_REQUESTED`, predicates `pr_ci_terminal` + `pr_review_result_available` + `pr_became_conflicting`.

[点点/dsh-v41-flash🐾]
