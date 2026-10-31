# Vendored from zts212653/clowder-ai-plugins

- source repo: https://github.com/zts212653/clowder-ai-plugins
- source commit: 56b3ef35b2a871b1f66d1ff6b0d61622b9bc1a65 (main, 2026-10-30)
- source path: packages/personal-chrome-companion (plugin.yaml version 0.1.0-alpha.9 in-flight)
- vendored by: upstream integration branch integration/origin-ef93d740-upstream-51838b4b (2026-10-30)
- why: fork keeps F247 personal-chrome capability after upstream F202 C1 (#1487) externalized the
  plugin; this copy carries fork PR #59 fixes (roleless DOM discovery + honest receipt) as a fork
  delivery (0.1.0-fork.1). Upstreamable as a PR against the source repo.

## Sync & retirement

- Sync: when upstream clowder-ai-plugins publishes a release that includes the fork fixes
  (or an equivalent), rebase this vendored copy onto that release commit, re-run the package
  test suite, re-pack, and update the TRUSTED_CHROME_SETUP_DELIVERIES fork entry digest —
  or delete this copy and the fork trust entry entirely once the official package covers it.
- Retirement: remove plugins/personal-chrome-companion/, the fork entry in
  packages/api/src/domains/plugin/manager/chrome-setup/personal-chrome-setup-policy.ts,
  and the fork cases in packages/api/test/personal-chrome-setup-policy.test.ts together.
- Historical manifests note: f167 cutover manifests were restored for scanning and migrated into an exact-ef93d740 aggregate; rollback/profile/layers are adapted content, not byte-for-byte originals.
- Patch boundary vs upstream source commit 56b3ef35b (this file's sibling changes):
  extension/chatgpt-page-adapter.mjs (#59 roleless graft + #45 section selector + observation
  counts), extension/service-worker.js (12-field validator + #50 replay-safety dispatch),
  extension/content-script-entry.mjs + extension/manifest.json (revisions/version_name),
  extension/content-script.js (regenerated bundle), native-host/assistant-return-inbox.mjs
  (12-field validator), src/protocol.ts (revisions), package.json/plugin.yaml/npm-shrinkwrap.json
  (version 0.1.0-fork.1), test/* (roleless suite 1:1 + section/selector-blind regressions +
  worker-replay #50 pair 1:1 + bundle-injection + packed-artifact-fork + diagnostic/revision
  alignment), test/helpers/f247-unsupported-node-harness.js (revision).

## Canonical pack toolchain (digest chain)

- npm pack output bytes depend on the Node runtime's zlib: the canonical
  delivery digest below is defined for Node >= 24 only (repo guard requires
  Node >= 24). Never re-pack with an older Node and compare against the pin.
- Final fork.1 delivery (2026-10-31, includes #50 replay safety): 159604 bytes,
  sha256 e64707f3d00d4c64bc45080b693e7190f7083b29dcefc03c44bd751333c793e6 —
  the value pinned in TRUSTED_CHROME_SETUP_DELIVERIES. Clean-consumer
  install + packed entrypoint import verified against this exact archive.
