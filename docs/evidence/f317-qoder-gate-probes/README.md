# F317 Qoder gate-probe raw captures (archived)

Immutable raw captures of a real `qodercn` init gate run, moved here from
`packages/api/test/fixtures/qoder/gate-probes/` during the
`origin-ef93d740` ← `upstream-51838b4b` integration (2026-10-30).

## Why these live here and not under a test root

These two files are **captured evidence, not fixtures with a live consumer**:
no test or runtime module reads them (the only consumers of
`fixtures/qoder/gate-probes/` are `cancel.jsonl` / `mcp-mount.jsonl`, which
stay where they are).

They are byte-frozen records of the tool surface a Qoder mount advertised on
2026-09-13. Since then the Host retired several identities that appear inside
them (`cat_cafe_community_guardian_signoff`,
`cat_cafe_community_request_guardian`, `cat_cafe_read_meeting_artifact`).
Those names are *historical facts about that capture*, not live consumers, and
rewriting them would falsify the record.

The MCP governance consumer scan (`packages/mcp-server/src/tool-cutover-consumer-scan.ts`)
treats every file under its fixed roots — including `packages/api/test` — as a
potential live consumer, and its only exclusion vocabulary is an inline
`// mcp-cutover-negative-reference: …` marker. A `.json` document cannot carry
that marker without ceasing to be the captured artifact.

So the distinction is made structurally instead: raw historical captures live
outside the scanned code/prompt/test roots, bytes unchanged. Nothing was
deleted and the scanner was not weakened — a new fixture added under a scanned
root is still flagged.

## Provenance

| File | sha256 | Original path |
|---|---|---|
| `mcp-readonly-tools.json` | `a893fe2a888a4436e82106313ec6ac158b258f9a07ed579a0bc57ba4f212aee6` | `packages/api/test/fixtures/qoder/gate-probes/mcp-readonly-tools.json` |
| `mcp-readonly-verify.json` | `76c207b1b296938b7ab217935b940b7ab5194ad0e65f7c98fca47d8e79b339ea` | `packages/api/test/fixtures/qoder/gate-probes/mcp-readonly-verify.json` |

Capture context — `qodercn` 1.1.51, protocol_version 1.4.0, macOS arm64,
2026-09-13, no personal credentials. See
`packages/api/test/fixtures/qoder/MANIFEST.md` and `PROVENANCE.md` for the
generation contract that governs `current/` (unchanged by this move; these
gate-probe files were never part of the `current/` generation and are not
checked by `verify.py`).
