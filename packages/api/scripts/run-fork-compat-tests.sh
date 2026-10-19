#!/usr/bin/env bash
# Run the fork-compat suite selected by resolve-fork-compat-tests.mjs.
#
# Fail-closed: a resolver error or an empty selection never falls through to
# Node's full-tree discovery (same rationale as run-public-tests.sh).
#
# The selection source is packages/api/config/fork-compat-tests.json. CI and
# the local pre-merge gate both call this runner; neither keeps its own list.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! files=$(node ./scripts/resolve-fork-compat-tests.mjs); then
  echo "fork-compat resolver exited non-zero — refusing to run an undefined file set" >&2
  exit 1
fi

if [[ -z "${files}" ]]; then
  echo "fork-compat resolver returned an empty file set — refusing to run tests" >&2
  exit 1
fi

# shellcheck disable=SC2086 # $files is intentionally word-split into argv
exec node \
  --import "$(pwd)/test/helpers/setup-cat-registry.js" \
  --test \
  --test-concurrency=1 \
  $files
