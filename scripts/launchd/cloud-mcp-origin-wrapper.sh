#!/usr/bin/env bash
# cloud-mcp-origin-wrapper.sh — foreground owner for the F247 cloud MCP origin
# (remote-spike on 127.0.0.1:3098). Runs under LaunchAgent
# com.cat-cafe.cloud-mcp-origin. Does NOT use start-local-mcp.mjs (that
# detached-spawns and exits, which defeats KeepAlive supervision).
#
# Credential discipline: CAT_CAFE_REMOTE_TOKEN / CAT_CAFE_AGENT_KEY_FILES enter
# ONLY through the operator env file (mode 0600, owner uid), parsed by a strict
# allowlisted KEY=VALUE reader — the file is NEVER sourced, so a stray command
# line cannot execute under the service identity. Names+values never appear in
# argv, the plist, or any log line written here.
set -euo pipefail

ORIGIN_ENTRY="/Users/yuhan/cat-cafe/cat-cafe-runtime/packages/mcp-server/dist/remote-spike.js"
ORIGIN_CWD="/Users/yuhan/cat-cafe/cat-cafe-runtime"
NODE_BIN="__NODE_BIN__"
# Operator-managed 0600 env source (strict KEY=VALUE; see INSTALL-cloud-mcp.md).
# Path only; contents stay out of git and out of the plist.
ENV_FILE="__CLOUD_MCP_ENV_FILE__"
STATE_DIR="__STATE_DIR__"
# v2.1.6 host fact pack (live owner, 2026-11-23): origin PID 49473 runs with
# HOME=/Users/yuhan/.cat-cafe/zcode/app-server-home and CAT_CAFE_DATA_DIR=<unset>;
# the latest init log shows the data root
# /Users/yuhan/.cat-cafe/zcode/app-server-home/.cat-cafe (log line carries no
# PID/timestamp — corroborating evidence, not proof of who created it).
# With DATA_DIR unset the code fallback is path.join(os.homedir(), '.cat-cafe')
# (packages/mcp-server/src/utils/path-validator.ts:39; the callback-outbox dir
# has the same fallback, tools/callback-outbox.ts:49, and live
# CAT_CAFE_CALLBACK_OUTBOX_DIR=<unset>). os.homedir() RETURNS the process HOME —
# so pinning HOME to the live value is exactly what reproduces the live data
# root and outbox path. The earlier rationale ("toolsets need os.homedir(), so
# HOME must be /Users/yuhan") was WRONG: that pin would have silently relocated
# the data root at install. Keep CAT_CAFE_DATA_DIR unset (live fallback
# semantics); do not widen the env allowlist for the outbox path either.
ORIGIN_HOME="/Users/yuhan/.cat-cafe/zcode/app-server-home"

gate_fail() {
  # $1 = exit code, $2 = stable marker, $3 = message (message must not contain
  # any env value). Log once per state change; ThrottleInterval bounds retries,
  # the marker bounds the noise. Marker writes degrade silently: losing a marker
  # may only increase log noise, never block the fail-closed exit.
  local code="$1" marker="$2" msg="$3"
  mkdir -p "$STATE_DIR/gate" 2>/dev/null || true
  if [[ ! -f "$STATE_DIR/gate/origin.$marker" ]]; then
    printf '%s origin gate=%s code=%s msg=%s\n' "$(date -u +%FT%TZ)" "$marker" "$code" "$msg" >&2
    touch "$STATE_DIR/gate/origin.$marker" 2>/dev/null || true
  fi
  exit "$code"
}

clear_gate() { rm -f "$STATE_DIR/gate/origin.$1" 2>/dev/null || true; }

# Strict env-file import. Grammar: optional leading "export ", then
# KEY=VALUE, one assignment per line; blank/#-comment lines allowed.
# - CR anywhere in a line is rejected: a CRLF file would otherwise smuggle
#   \r into values (token/path/port silently corrupted). v2.1 P2-2.
# - KEY must match ^[A-Za-z_][A-Za-z0-9_]*$ AND be in the explicit allowlist.
# - Duplicate KEY lines are rejected (last-wins masking = audit ambiguity).
# - VALUE is rejected if it contains executable shell syntax characters
#   (` $ ; | & < > backslash). Quote-wrapped values are unwrapped literally.
# - export is done via `export "$KEY=$VAL"` (quoted assignment: no eval, no
#   word splitting, no re-expansion).
ENV_KEY_ALLOW='^(CAT_CAFE_REMOTE_TOKEN|CAT_CAFE_AGENT_KEY_FILES|CAT_CAFE_REMOTE_PORT|CAT_CAFE_DESKTOP_MODE|CAT_CAFE_READONLY|CAT_CAFE_CAT_ID|CAT_CAFE_AGENT_KEY_BOUND_CAT_ID|CAT_CAFE_USER_ID|CAT_CAFE_API_URL|CAT_CAFE_DATA_DIR)$'
PARSED_KEYS=()

parse_env_file() {
  local f="$1" lineno=0 line key val seen_keys=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    if [[ "$line" == *$'\r'* ]]; then
      gate_fail 78 "env-file-crlf" "env file line $lineno contains CR (CRLF file? convert to LF)"
    fi
    if [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]]; then
      continue
    fi
    # strip a single leading "export " if present
    line="${line#export }"
    line="${line#"${line%%[![:space:]]*}"}"
    if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      gate_fail 78 "env-file-syntax" "env file line $lineno is not KEY=VALUE"
    fi
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    if [[ ! "$key" =~ $ENV_KEY_ALLOW ]]; then
      gate_fail 78 "env-file-key" "env file line $lineno key not allowlisted: $key"
    fi
    case ":$seen_keys:" in
      *":$key:"*)
        gate_fail 78 "env-file-duplicate" "env file line $lineno repeats key $key"
        ;;
    esac
    seen_keys="$seen_keys:$key"
    case "$val" in
      *'`'*|*'$'*|*';'*|*'|'*|*'&'*|*'<'*|*'>'*|*\\*)
        gate_fail 78 "env-file-value" "env file line $lineno value contains forbidden syntax"
        ;;
    esac
    # unwrap a matched pair of quotes (literal, no evaluation)
    if [[ "${#val}" -ge 2 && "$val" == \"*\" ]]; then
      val="${val:1:${#val}-2}"
    elif [[ "${#val}" -ge 2 && "$val" == \'*\' ]]; then
      val="${val:1:${#val}-2}"
    fi
    export "${key?}=${val}"
    PARSED_KEYS+=("$key")
  done < "$f"
}

# Credential completeness rules live HERE and only here (v2.1.4 P1-1): the
# production startup path and the audited --verify-env seam both call
# verify_env_ready, so a file that passes the create/rotate gate satisfies
# exactly what startup will demand. Only key NAMES appear in messages.
REQUIRED_ENV_KEYS=(CAT_CAFE_REMOTE_TOKEN CAT_CAFE_AGENT_KEY_FILES)

verify_env_ready() {
  local f="$1" required
  # v2.1.5 P2: the name list is per-verification, not per-process. Without this
  # reset, two calls in one shell would print the first file's names too
  # (names only either way — never values — but the list must be truthful).
  PARSED_KEYS=()
  parse_env_file "$f"
  # Fail-closed completeness: the credential-bearing names must be present and
  # non-empty (checked, never printed). remote-spike re-validates the rest.
  for required in "${REQUIRED_ENV_KEYS[@]}"; do
    if [[ -z "${!required:-}" ]]; then
      gate_fail 78 "env-file-incomplete" "env file did not set $required"
    fi
  done
}

# Audited verification seam (v2.1.4): strict parse + required-key completeness
# via the same function startup uses, printing only the KEY names (never
# values). The v2.1.3 --parse-env seam is REMOVED — it validated syntax only,
# so a syntactically valid file missing credentials could pass a runbook gate
# and then be mv'd over a live env.origin.
if [[ "${1:-}" == "--verify-env" ]]; then
  if [[ $# -ne 2 || ! -f "$2" ]]; then
    echo "usage: $0 --verify-env <file>" >&2
    exit 2
  fi
  # Scratch marker dir for test mode; gate_fail degrades gracefully if the
  # sandbox denies it — exit codes and stderr are what the test asserts.
  STATE_DIR="$(dirname "$2")/gate-scratch.$$"
  verify_env_ready "$2"
  printf '%s\n' "${PARSED_KEYS[@]:-}"
  exit 0
fi

if [[ "$NODE_BIN" == "__NODE_BIN__" || "$ENV_FILE" == "__CLOUD_MCP_ENV_FILE__" || "$STATE_DIR" == "__STATE_DIR__" ]]; then
  echo "origin wrapper: unreplaced placeholder — refusing" >&2
  exit 78
fi

if [[ ! -x "$NODE_BIN" ]]; then
  gate_fail 78 "node-missing" "node binary not executable"
fi
if [[ ! -f "$ORIGIN_ENTRY" ]]; then
  gate_fail 78 "entry-missing" "remote-spike entry file absent"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  gate_fail 78 "env-file-missing" "operator env file absent"
fi
env_owner="$(stat -f '%u' "$ENV_FILE")"
env_mode="$(stat -f '%Lp' "$ENV_FILE")"
if [[ "$env_owner" != "$(id -u)" || "$env_mode" != "600" ]]; then
  gate_fail 78 "env-file-insecure" "env file must be owner-uid and mode 600"
fi
clear_gate env-file-missing; clear_gate env-file-insecure

verify_env_ready "$ENV_FILE"
clear_gate env-file-syntax; clear_gate env-file-key; clear_gate env-file-value; clear_gate env-file-incomplete

export HOME="$ORIGIN_HOME"
cd "$ORIGIN_CWD"
clear_gate node-missing; clear_gate entry-missing
# exec keeps this process as the single supervised foreground owner; secrets
# stay in the environment, never in argv.
exec "$NODE_BIN" "$ORIGIN_ENTRY"
