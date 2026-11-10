# Managed commands remain pending under Chinese process dates

Source: `thread_mw9in3e11gpamynj#0001794312365501-000746-3b31d346`.
Owner: cat-yanyan61. Independent diagnosis: astra, messages `0001794312593709-000750-2b475996` and `0001794313147341-000761-29b08b27`.

## Failure and root cause

Two review commands had exited, with original exit codes 1 and 0. Their jobs stayed running with `pendingResult`, no durable cleanup proof and no terminal status. Cancelling the holds was accepted but remained pending. This is process-observation failure, not unfinished review or exhausted model quota.

On macOS with `LANG=zh_CN.UTF-8`, `ps lstart` emits four fields such as `二 11月/10 16:05:03 2026`. The environment-stream worker expected the five C-locale date fields and rejected its entire observation. The plain reader's five-field slice also persisted the first command token as part of the process birth identity: `二 11月/10 16:05:03 2026 /opt/homebrew/Cellar/node@24/24.18.0/bin/node`. As a result, token-scoped cleanup could not prove absence and the existing recovery path kept the job pending.

## Correction and boundaries

Both sync/async process readers and the environment worker pin only their child process language to `LANG=C, LC_ALL=C`. They retain the inherited timezone and do not alter the API environment. New observations consistently use the existing five-field parser.

The process-identity comparator also recognizes the known four-field Chinese format, with or without its accidentally captured single command token, and compares the same weekday/month/day/time/year in C format. It does not rewrite persisted records, convert timezones, remove arbitrary command suffixes, or accept a changed birth time. Existing PID-reuse, exact token and process-group ownership fences remain in place.

Independent review also reproduced a second gap: the original failure wake had already been consumed before the operator cancelled. The indexed recovery selector excluded that disabled carrier, and job reconciliation alone could not finish its cancellation lifecycle.

The selector now includes only `consumed + cancel_requested` history in addition to its existing candidates. V75 transactionally rebuilds the deployed partial index without changing task bytes. Recovery requires the exact task/job/user/thread/cat binding and a durable terminal record with cleanup proof, then persists a separate idempotent cancellation receipt before a lifecycle CAS to `cancelled_by_user`. The old command projection, consumed wake and dispatch identity stay intact. Receipt failure or CAS contention leaves the request recoverable; socket delivery cannot block durable settlement.

No original command is replayed. Successful, failed and cancelled job outcomes keep their existing semantics; historical `pendingResult` evidence stays intact. This patch does not force production jobs terminal, delete task records or restart the API.

## Verification

The seven focused regressions first produced six failures and one pass, then all passed after the correction. They exercise real macOS sync/async process reads under Chinese locale, equivalent legacy identities including the captured path, rejection of changed/unsupported identities, and temporary-database recovery of exit codes 0/1 with and without a cancellation request. A living process observed across the locale change retains its identity. Recovery tests assert that the original command is never executed.

The reviewer's unchanged four-cell counterexample (exit 0/1 × running/consumed carrier) first failed both consumed cells and now passes all four. Permanent tests run the real indexed DynamicTaskStore, ManagedJobService and complete recovery sweep, then read the real status route. They also cover receipt failure before/after commit, lifecycle CAS contention, socket failure, repeated sweeps and mismatched principal/task bindings. An existing V74 index is upgraded with rollback injection and EXPLAIN coverage. The 21 focused recovery/index tests pass; none wake a model or execute the historical command.

The expanded CLI/process, managed-job, wake recovery, cancellation/status route and index suite passes 287 tests with one platform skip (288 total, zero failures) under Node 24. API build, explicit Node 24 TypeScript compilation, changed-file Biome error checks and diff whitespace checks pass. Biome still reports complexity warnings in the existing sweep and migration functions; this is not a full-suite claim.

Reproduce with Node 24 after building the API:

```sh
cd packages/api
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test --test-concurrency=1 test/cli-process-locale.test.js test/managed-job-locale-recovery.test.js
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test --test-concurrency=1 test/managed-command-consumed-cancellation.test.js test/projection-history-read-budget.test.js test/scheduler/managed-candidate-migration.test.js
```

Tests use temporary HOME/data, fake job principals and a reaped test PID. The production jobs and their stored state are untouched. Actual stale-hold clearance still requires the corrected code to be loaded by the authorized runtime, followed by its canonical recovery and owner-visible terminal check. Merge alone is not clearance.
