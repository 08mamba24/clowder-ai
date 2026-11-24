#!/usr/bin/env bash
# cloud-mcp-tunnel-wrapper.sh — single foreground tunnel owner for the F247
# cloud MCP reverse tunnel, under LaunchAgent com.cat-cafe.cloud-mcp-tunnel.
#
# Runs `tunnel-client run` directly. It deliberately does NOT invoke
# connect-tunnel.py: that script layers `runtimes connect` + tmux AND embeds
# the profile token into a child-process URL argument. The token here comes
# only from the existing profile dir (0600 material), never argv/plist/logs.
set -euo pipefail

TUNNEL_BIN="__TUNNEL_CLIENT_BIN__"
PROFILE_DIR="/Users/yuhan/.cat-cafe/cloud-tunnel/profiles"
PROFILE="cat-cafe-gpt-pro"
# Isolated HOME carried over from the current tmux owner (host fact #128).
# HOME ≠ cwd: verified 2026-11-23 via `lsof -p <owner-pid> -a -d cwd`, the live
# owner's cwd is the repo root, so we keep that cwd and only pin HOME/XDG.
ISO_HOME="/Users/yuhan/.cat-cafe/zcode/app-server-home"
# XDG exact values VERIFIED 2026-11-23 from the live owner process env (#128
# host fact pack): they equal $ISO_HOME/.config and $ISO_HOME/.local/state.
XDG_CONFIG_HOME="$ISO_HOME/.config"
XDG_STATE_HOME="$ISO_HOME/.local/state"
TUNNEL_CWD="/Users/yuhan/cat-cafe/clowder-ai"
STATE_DIR="__STATE_DIR__"
PROXY_HOST=127.0.0.1
PROXY_PORT=7897
# LaunchAgent env does NOT inherit the interactive shell. #128 host fact pack
# VERIFIED 2026-11-23 from the live owner process env: HTTP/HTTPS/ALL_PROXY
# (upper+lower) = this loopback proxy; NO_PROXY/no_proxy = the list below.
# Export explicitly; these are non-sensitive local values.
# ENV-VALUE PARITY ONLY — it does not mean 7897 is reachable now or that a
# CONNECT would succeed; the TCP prescreen below still fail-closes.
PROXY_URL="http://127.0.0.1:7897"
NO_PROXY_LIST="localhost,127.0.0.1,::1"

gate_fail() {
  # Marker writes degrade silently: losing a marker may only increase log
  # noise, never block the fail-closed exit.
  local code="$1" marker="$2" msg="$3"
  mkdir -p "$STATE_DIR/gate" 2>/dev/null || true
  if [[ ! -f "$STATE_DIR/gate/tunnel.$marker" ]]; then
    printf '%s tunnel gate=%s code=%s msg=%s\n' "$(date -u +%FT%TZ)" "$marker" "$code" "$msg" >&2
    touch "$STATE_DIR/gate/tunnel.$marker" 2>/dev/null || true
  fi
  exit "$code"
}
clear_gate() { rm -f "$STATE_DIR/gate/tunnel.$1" 2>/dev/null || true; }

# Double-owner detection with bound identity, not a bare pgrep substring echo:
# - pgrep -U <our-uid> binds the user dimension.
# - the pgrep -l full argv line must contain the EXACT canonical invocation for
#   the SAME profile-dir + profile (re-verified literally, because pgrep's
#   pattern is a regex; dots are wildcards there, quoting is impossible).
# - self is excluded; an ancestor-chain exclusion is applied when `ps` is
#   available (host under launchd). Even without it, an ancestor can only
#   match if its own argv IS a full same-profile tunnel invocation — in which
#   case refusing is correct behavior, not a false positive.
# Refuse-only: we never kill; stopping the legacy tmux owner is an explicit
# operator step.
owner_probe() {
  local self="$1" dir="$2" prof="$3" line lines p args chain="" cur
  lines="$(pgrep -U "$(id -u)" -f -l "run --profile-dir $dir --profile $prof" 2>/dev/null || true)"
  if [[ -z "$lines" ]]; then
    return 1
  fi
  cur="$PPID"
  while [[ -n "$cur" && "$cur" -gt 1 ]]; do
    chain="$chain $cur"
    cur="$(ps -o ppid= -p "$cur" 2>/dev/null | tr -d ' ' || true)"
  done
  while IFS= read -r line; do
    p="${line%% *}"
    args="${line#* }"
    if [[ "$p" == "$self" ]]; then
      continue
    fi
    case " $chain " in
      *" $p "*) continue ;;
    esac
    case "$args" in
      *"tunnel-client run --profile-dir $dir --profile $prof"*)
        echo "$p"
        return 0
        ;;
    esac
  done <<< "$lines"
  return 1
}

# Test seam: probe with an explicit (dir, profile) instead of the live ones.
if [[ "${1:-}" == "--owner-probe" ]]; then
  if [[ $# -ne 3 ]]; then
    echo "usage: $0 --owner-probe <profile-dir> <profile>" >&2
    exit 2
  fi
  found="$(owner_probe "$$" "$2" "$3" 2>/dev/null || true)"
  if [[ -n "$found" ]]; then
    echo "owner $found"
    exit 0
  fi
  echo "no-owner"
  exit 1
fi

if [[ "$TUNNEL_BIN" == "__TUNNEL_CLIENT_BIN__" || "$STATE_DIR" == "__STATE_DIR__" ]]; then
  echo "tunnel wrapper: unreplaced placeholder — refusing" >&2
  exit 78
fi
if [[ ! -x "$TUNNEL_BIN" ]]; then
  gate_fail 78 "bin-missing" "tunnel-client binary not executable"
fi
if [[ ! -d "$PROFILE_DIR" ]]; then
  gate_fail 78 "profile-dir-missing" "profile dir absent"
fi

other_pid="$(owner_probe "$$" "$PROFILE_DIR" "$PROFILE" || true)"
if [[ -n "${other_pid:-}" ]]; then
  gate_fail 75 "duplicate-owner" "another tunnel-client owner pid=$other_pid; follow INSTALL switchover steps"
fi
clear_gate duplicate-owner

# Proxy fast pre-screen (TCP only). Full CONNECT readiness is judged by the
# watchdog as an independent gate; here we only avoid hammering a dead local
# proxy. Bounded wait, then non-zero exit -> KeepAlive retries at throttle.
proxy_ready=0
for _ in 1 2 3 4 5; do
  if (exec 3<>"/dev/tcp/$PROXY_HOST/$PROXY_PORT") 2>/dev/null; then
    exec 3<&- 3>&- || true
    proxy_ready=1
    break
  fi
  sleep 2
done
if [[ "$proxy_ready" != "1" ]]; then
  gate_fail 75 "proxy-tcp-down" "local proxy $PROXY_HOST:$PROXY_PORT not listening (TCP prescreen)"
fi
clear_gate proxy-tcp-down
clear_gate bin-missing; clear_gate profile-dir-missing

if ! cd "$TUNNEL_CWD"; then
  gate_fail 78 "cwd-missing" "configured tunnel cwd absent"
fi
export HOME="$ISO_HOME"
export XDG_CONFIG_HOME XDG_STATE_HOME
export HTTP_PROXY="$PROXY_URL"
export HTTPS_PROXY="$PROXY_URL"
export ALL_PROXY="$PROXY_URL"
export http_proxy="$PROXY_URL"
export https_proxy="$PROXY_URL"
export all_proxy="$PROXY_URL"
export NO_PROXY="$NO_PROXY_LIST"
export no_proxy="$NO_PROXY_LIST"
# v2.1.11 P2-2 (host-verified by 砚砚61's bounded probe, tunnel-client
# 0.0.14+0f870e50a973fa820d4c409000059e181e8d242b, binary SHA256 309fd85d…):
# at the DEFAULT info level the client logs the MCP target URL — which embeds
# the current query token — into its native log (fields target/mcp_target_value,
# 2 startup occurrences per generation). LOG_LEVEL=warn suppresses exactly those
# startup records (probe: 0 token hits across native file/stdout/stderr under
# fault-free AND MCP-500 scenarios) while retaining WARN/ERROR diagnostics.
# The YAML profile is NOT touched: env precedence (flags > env > YAML) keeps
# the override effective against profile-level log.level. Hard-pin
# LOG_HTTP_RAW_UNSAFE=false so an ambient `true` can never re-enable raw HTTP
# body/header logging. This suppresses the VERIFIED startup records only — no
# universal-redaction claim; pre-existing info-level logs already on disk are
# left as-is under their existing 0600/0700 permissions.
export LOG_LEVEL=warn
export LOG_HTTP_RAW_UNSAFE=false
# exec = single supervised foreground owner; no token in argv (--profile name
# only; secret material is read from the profile dir by tunnel-client itself).
exec "$TUNNEL_BIN" run --profile-dir "$PROFILE_DIR" --profile "$PROFILE"
