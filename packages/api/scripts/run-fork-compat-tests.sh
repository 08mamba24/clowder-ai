#!/usr/bin/env bash
# Run the fork-compat suite selected by resolve-fork-compat-tests.mjs.
#
# Fail-closed: a resolver error or an empty selection never falls through to
# Node's full-tree discovery (same rationale as run-public-tests.sh).
#
# The selection source is packages/api/config/fork-compat-tests.json. CI and
# the local pre-merge gate both call this runner; neither keeps its own list.
# API suites and MCP-server capability suites are both part of the same fork
# contract, so they share one resolver and one entrypoint. Each group runs in
# its own package with that package's established test command.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! plan=$(node ./scripts/resolve-fork-compat-tests.mjs); then
  echo "fork-compat resolver exited non-zero — refusing to run an undefined file set" >&2
  exit 1
fi

if [[ -z "${plan}" ]]; then
  echo "fork-compat resolver returned an empty file set — refusing to run tests" >&2
  exit 1
fi

api_files=()
mcp_server_files=()
while IFS= read -r entry; do
  [[ -n "${entry}" ]] || continue
  case "${entry}" in
    api:*) api_files+=("${entry#api:}") ;;
    mcp-server:*) mcp_server_files+=("${entry#mcp-server:}") ;;
    *)
      echo "fork-compat resolver returned an unknown package entry: ${entry}" >&2
      exit 1
      ;;
  esac
done <<<"${plan}"

if (( ${#api_files[@]} > 0 )); then
  node \
    --import "$(pwd)/test/helpers/setup-cat-registry.js" \
    --test \
    --test-concurrency=1 \
    "${api_files[@]}"
fi

if (( ${#mcp_server_files[@]} > 0 )); then
  (
    cd ../mcp-server
    # Same runner shape as the package's `test` script: callback outbox is
    # isolated and tsx resolves the TypeScript capability projection source.
    node \
      --import ./test/helpers/isolate-callback-outbox.mjs \
      --import tsx \
      --test \
      --test-concurrency=1 \
      "${mcp_server_files[@]}"
  )
fi
