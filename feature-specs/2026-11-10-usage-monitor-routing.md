---
feature_ids: [F051, F293]
topics: [quota, routing, usage-monitor, freshness]
doc_kind: spec
created: 2026-11-10
tips_exempt: "Existing get_thread_cats role discovery and dispatch checks consume a new local source; no new Chat tool or UI action. Operator setup is documented here."
---

# usage-monitor quota at selection and execution

Accepted source: `thread_mw9in3e11gpamynj#0001794244814251-000449-332f055d`.
Original request: “当前猫咖会提前识别到猫猫的额度用量，来方便分发工作吗？”
Authorization: “直接实现！！然后让小星星review”. Author: cat-yanyan61. Reviewer: astra.

## Outcome and ownership

Reuse the running usage-monitor collector without invoking a model, network request or credential refresh on a dispatch path. Its account/window observations appear through the existing `get_thread_cats(forRole=review|architecture|implementation)` discovery and F293 actual-send preflight. F051/source collection keeps ownership of quota facts; F293 composes routing decisions. No new UI, separate routing ledger, scheduler or MCP server.

The producer change is in `08mamba24/usage-monitor`, branch `feat/routing-snapshot`. Both repository heads must be reviewed together. Existing used-percentage data and display strings remain compatible. The collector adds schema version 2, per-provider UTC epoch milliseconds, credential fingerprints, exact used percentages, absolute resets where available, separate Gemini model/token windows, and atomic cache replacement. POSIX files use mode 0600; Windows permissions follow its user-directory ACL and are not represented by Unix mode bits.

## Operator setup and real entry

Build the reviewed version of both repositories. Install usage-monitor through its existing `install.sh` so its normal minute refresh emits the new cache. From the Clowder checkout, inspect it without fetching or changing credentials:

```sh
node packages/api/dist/scripts/usage-monitor-routing.js
```

Explicitly identify which source account and windows apply to each cat. For example, after confirming `my-claude-cat` uses the same account as the monitored Claude row:

```sh
node packages/api/dist/scripts/usage-monitor-routing.js --cat my-claude-cat --provider claude --windows 5h,7d
node packages/api/dist/scripts/usage-monitor-routing.js --cat my-claude-cat --provider claude --windows 5h,7d --write
```

Without `--write` this prints the proposed configuration. `--write` replaces only that cat's entry in the canonical account-root `.cat-cafe/usage-monitor-routing.json`, preserving other bindings. `--cache /absolute/path/usage.json` selects a different local source. A cat's existing account/model is read through the same resolver as execution; the command never selects or changes an account. No credentials are printed.

The command is an operator attestation that the selected source account and every relevant window apply to that cat/model, including simultaneous session and weekly limits. It cannot infer this from a provider name. Select exact Gemini model/token window labels from the inspection output; a Flash bucket must not gate Pro. MCP/admin pools must not gate ordinary model calls. Balance-only providers currently remain unknown because money is not a percentage or proof of model eligibility.

Then ask a cat to select a reviewer or implementation partner. The existing MCP role query includes the monitored windows and low-quota warnings. On actual send, F293 reads the file again and compares the frozen provider, model and account revision, and requires independent evidence that the frozen launch pins and verifies its current principal. Currently only managed Codex OAuth with a matching pinned user/workspace supplies that evidence. Native/legacy Codex, Claude, Gemini and other CLI-owned logins remain advisory even after operator setup; their configuration revisions do not prove a login identity. The CLI reports `advisory` for those bindings. F293 returns alternatives through its existing contract; it does not silently replace an explicitly requested cat. Explicit owner-attempt behavior is preserved.

Bindings hot-reload on the next read. Removing an entry removes only its monitor observation; removing the configuration restores existing quota behavior. No runtime restart is required for binding changes once this code is deployed.

## Semantics and boundaries

- The router reads only a bounded regular JSON file. Missing, malformed, stale, future-dated or failed observations warn as unknown and permit an attempt. File reads cannot spawn the collector or block on a FIFO/device.
- Freshness is 120 seconds and ends sooner at a selected window's reset. Expiry becomes unknown, never assumed recovery. One failed provider does not erase another provider's data.
- Display `pct` is used percentage; remaining is `100 - usedPercent`. Exact raw values prevent a rounded `100%` from blocking a still usable window. Legacy caches use file mtime and remain advisory.
- At or below 10% remaining gives a scarcity warning. Zero rejects only with schema v2, a matching source credential fingerprint, the operator's exact model/window mapping, the frozen execution's account revision and model, verified pinned principal evidence, and unrounded window data. Enabled Claude paid overage remains advisory.
- Fingerprints contain SHA-256 of scoped credential material and actual account selectors, never reusable credentials. Codex includes `ChatGPT-Account-Id`; custom sources include URL path/query and the selected JSON field. Credential rotation or account/model switches invalidate the pin and require rerunning the explicit binding command. A configuration/path revision alone cannot extend an operator attestation across a CLI login change.
- Cats sharing a source account/window share an opaque pool identity. Percentages are neither summed nor independently replenished per cat. Main, Spark, review, weekly and model buckets stay separate.
- Monitor observations cannot clear manual or provider-health restrictions. A successful quota query is not a successful inference and cannot certify model availability.
- The MCP/read model contains only bounded window data, opaque provenance and routing reasons. Private account refs, source paths, source fingerprint and credential contents stay local.

## Acceptance

- [x] Producer regressions and existing Python/Swift consumers pass (77 Python tests and Swift regression runner).
- [x] Existing role discovery exposes the source and actual preflight rechecks it; the same journey observes a changed cache and expiry.
- [x] Exact exhausted execution is rejected; scarce, failed, stale, legacy and changed bindings warn.
- [x] Shared pools, Gemini model isolation, rounding and paid overage are covered. Persistent collectors fetch a new Codex sample each batch.
- [x] Existing account/privacy/health/manual restriction tests pass.
- [x] Review P1 regressions: same-home native login changes cannot hard-block; config-only Claude/Gemini launches remain advisory; same-token Codex workspace switches change the source fingerprint while Codex/Spark continue sharing it.
- [ ] Small Star (`astra`) reviews exact heads of both repositories.

Production activation and real account binding are separate from isolated development verification. No deployment or runtime restart is performed as part of preparing review.

Reproduction: install this checkout's locked dependencies with Node 24 and build `@cat-cafe/api` (its build also builds shared and MCP). In `packages/api`, run `node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=4 test/routing-*.test.js test/usage-monitor-routing.test.js test/quota-routing-signal-wiring.test.js test/callback-thread-cats.test.js`. In the producer checkout run `bash tests/run.sh`. Development `.env` uses Redis 6398; tests isolate their config/data and fake providers. No production Redis or provider inference calls are used.

## Fallback coordinate audit

The repository detector flags this new parser/CLI above its heuristic threshold. This is a format/authority normalization boundary, not a chain of alternate providers or credentials. The chosen decomposition is one file reader, one projection into existing capacity facts and the existing F293 decision path; a second MCP server/router was rejected because it would duplicate that authority.

- Config/cache read catches are independent I/O boundaries: absent config means opt-out; invalid configured data yields unknown. Neither retries nor substitutes another account or data source. CLI read errors other than first-time ENOENT are rethrown.
- Default cache path versus an explicit absolute path is the one documented operator source selection; the CLI uses the same rule. Empty initial bindings represent first-time setup, not recovered state.
- `quotaWindows` versus `wins`, legacy schema version/time versus mtime, and exact `usedPercent` versus rounded `pct` are the two supported source contracts. Legacy/missing precision cannot hard-block. Removing these branches would break the existing installed cache or merge Gemini's model scopes.
- Missing reset maps to the observation-age boundary, not an invented reset. Missing account fingerprint gets an unverified opaque pool identity and cannot grant applicability. Optional provider identity follows the existing runtime provider/client resolution rule.
- Policy defaults for absent evidence/reason are diagnostic references; missing percentage is excluded from the low-percentage condition. They cannot create available quota or erase a health/manual restriction. Boolean ORs in regular-file/size and binding checks are rejection predicates, not failover layers.

The alternatives considered were dropping legacy support, treating rounded/provider-wide values as execution proof, or duplicating the routing service. Each would weaken compatibility or correctness; no additional fallback source is introduced.
