# F247 cloud MCP LaunchAgent — operator install runbook (CANDIDATE v2.1.11, not installed — the LIVE set is the reviewed-and-installed v2.1.10)

Status vocabulary (do not conflate):
`candidate prepared` (this file) → `operator installed` → `local health verified` → `proxy+control-plane verified` → `real MCP end-to-end verified`.
Nothing below has been executed. This round authorizes ONLY reading this template set.

**⛔ INSTALL IS BLOCKED at this stage (v2.1.1 P2-D; remaining items updated 2026-11-23).** This document is a review candidate, NOT ready-to-install. Open blocking host facts before any bootstrap: tunnel runtime probe writer contract (none verified — see Credentials/probe sections), real launchd-spawned `/health`, real CONNECT probe, reboot-login persistence (mechanism landed v2.1.7: HOME LaunchAgents copies; still must be OBSERVED across a real login), kill-and-auto-recover drill. RESOLVED by the #128 live-owner fact pack (2026-11-23, process-env whitelist extraction; env-value parity, not connectivity): NO_PROXY exact live value, XDG_CONFIG_HOME/XDG_STATE_HOME exact values, origin data-root HOME. The full list is at the bottom; none of it is satisfied by the passing local tests. **v2.1.9 is a pending-review revision:** 砚砚61's install preflight (2026-11-23, authorized by 大当家 message 000314) proved the v2.1.6 render chain failed on the real runbook Install block (rendered plist refused; installed wrappers exited 78); v2.1.7 fixed the render chain, and gpt-pro's shard-1 初审 (not a verdict) raised three structural risks — login-copy publish MUST target the real console user's home, publishing must not half-submit, and the render-path input refuse class missed control characters. v2.1.8 addressed all three; gpt-pro's second round (still not a verdict) required: (a) the wrong-HOME refusal must precede ALL filesystem side effects (the v2.1.8 resolver ran after the DST mkdirs — a real ordering flaw, fixed: resolver is now the first statement and the login dir is created only at publish time), and (b) "re-run is idempotent" must not hand-wave a half-published or FOREIGN login dir (fixed: pre-publish byte-comparison — only missing-or-identical survives to proceed; foreign/stale/non-regular content refuses untouched; mid-chain publish failure recovery is proven by an injected failing `install`, not asserted). gpt-pro's second round (still not a verdict) kept three checkpoints, closed here in v2.1.10: (1) the override is DOUBLE-GATED — `LAUNCH_AGENTS_DIR_OVERRIDE` without `CONFIRM_LAUNCH_AGENTS_OVERRIDE=yes` refuses in ALL THREE blocks (install/publish, stop-before-launchctl, uninstall-files), so an incidental exported variable can never silently redirect or excuse a publish target; (2) mid-chain partial-`install` recovery is spelled out as an operator procedure (inspect the named path, remove the leftover explicitly, re-run heals) and auto-heal stays limited to missing-or-identical; (3) the stop/disable block validates the shell BEFORE the first `launchctl bootout` — a wrong-HOME uninstall can no longer stop services while leaving reload copies that reanimate them at next login. **v2.1.11 is a pending-review revision ON TOP of v2.1.10, which gpt-pro APPROVED as candidate prepared (message 0001795445745291-000342) and 砚砚61 then installed under task 0001795442776624-000318-4bcbef7f** — the live set is v2.1.10 and is healthy; host acceptance of that install surfaced two P2s, fixed here: P2-1 rotation call boundary — `runWatchdogOnce` passed `cfg` (fields `logMaxBytes`/`logKeep`) straight into `rotateLogs({maxBytes,keep})`, so `size <= undefined` was always false and EVERY file (even 10-byte ones) rotated each round while `keep` never reached `shiftRotated`; fixed by explicit option mapping, proven at the REAL call boundary (below-threshold survives, generations actually shift, active inode preserved, TSV rename-mode intact). P2-2 native-client log exposure — 砚砚61's bounded host probe (tunnel-client 0.0.14+0f870e50a973fa820d4c409000059e181e8d242b, binary SHA256 309fd85d…, private tmp, legal-shape fake 32-char tunnel id, fake credentials, loopback stubs, zero external traffic) reproduced the leak at the DEFAULT info level (fields `target` + `mcp_target_value`, 2 startup hits per generation) and proved `LOG_LEVEL=warn` yields ZERO hits across both fault-free and MCP-500 runs while retaining WARN/ERROR diagnostics. The tunnel wrapper now export-pins `LOG_LEVEL=warn` and `LOG_HTTP_RAW_UNSAFE=false` immediately before `exec` (precedence is flags > env > YAML: profile-level log.level cannot outvote the floor; ambient raw-HTTP logging cannot be re-enabled). A behavioral fixture injects hostile ambient `debug`/`true` and the fake delegate provably receives `warn`/`false` with argv unchanged. SCOPE honesty: this suppresses the VERIFIED startup records for THIS client build only — no universal-redaction claim; pre-existing info-level native log lines stay on disk under their existing 0600/0700 permissions (operator disposal decision, never this runbook's action). Nothing of v2.1.11 has been installed or executed; the delta awaits gpt-pro review, and no v2.1.11 host observation of the launchd-run tunnel process exists yet.

## Components & single-owner boundaries
| launchd label | supervised process | who restarts on exit | who detects stuck/unhealthy | who bounds logs |
|---|---|---|---|---|
| `com.cat-cafe.cloud-mcp-origin` | foreground `node .../dist/remote-spike.js` via wrapper | launchd KeepAlive (ThrottleInterval 60s) | watchdog: `state=running` + `GET 127.0.0.1:3098/health` 200 | watchdog copytruncate (launchd holds the fd; inode preserved) |
| `com.cat-cafe.cloud-mcp-tunnel` | foreground `tunnel-client run --profile-dir … --profile cat-cafe-gpt-pro` via wrapper | launchd KeepAlive | watchdog: `state=running`; runtime healthy/ready probe = **TODO host fact** → health caps at `unknown` | watchdog copytruncate |
| `com.cat-cafe.cloud-mcp-watchdog` | none (StartInterval 300 one-shot) | not KeepAlive on purpose — cannot double-pull | it IS the probe; remediation only via `/bin/launchctl kickstart -k` for a **loaded-but-running-unhealthy** job, ≥2 consecutive fail rounds, ≥15min cooldown per label. Unloaded ⇒ operator must bootstrap; watchdog never bootstraps. | rotates service logs + its own `watchdog-status.tsv` (rename) |

Machine-readable verdict per round: `watchdog-latest.json` (`cloud: ready|not-ready|unknown`) and one TSV line.
**`cloud=ready` is currently unreachable by design**: it requires origin health 200 AND tunnel job loaded AND tunnel runtime probe `healthy` (TODO below) AND CONNECT gate `pass`. A tunnel job that is not even loaded in launchd is a deterministic failure ⇒ `not-ready` (v2.1 P1-1), not `unknown`. A job that is **loaded but not `state=running`** is reported as `launchd-restarting`: that means *recovery in progress / status unknown*, NOT healthy — the watchdog deliberately never kickstarts into KeepAlive's face. Until the runtime probe lands, expect `unknown` (nothing failed deterministically) or `not-ready`. Do not quote `unknown` as healthy.

Functional boundary (v2.1 P2-3, do not oversell): the autostart set guarantees **process-exit auto-restart (launchd KeepAlive) + origin HTTP health + deterministic job-presence reporting**. It does NOT detect or repair a tunnel hang, a half-connected tunnel, or a dead third-party proxy: the runtime probe is unverified host territory, CONNECT failure only classifies/alerts (never restarts anything), and no tunnel job is ever kickstarted on `unknown`.

### Tunnel runtime probe contract — FORBIDDEN to configure until a reviewed writer contract exists
`--tunnel-runtime-probe <path>` makes `probeTunnelRuntime` treat a file whose content is exactly `ready` as healthy **only if its mtime is in the past AND younger than 120s** (`tunnelRuntimeProbeMaxAgeMs`; older ⇒ `unknown`/`probe-stale`, future ⇒ `unknown`/`probe-invalid-time`, v2.1.1 P2). That is the entire implemented contract, and **freshness only bounds staleness — it proves nothing about provenance**: the code does not verify regular-file type, owner/mode, or profile/PID binding. There is currently **no verified writer**: nobody has demonstrated that tunnel-client (or anything else) atomically writes such a file with truthful freshness, owner-uid, and profile/PID binding. Therefore: **configuring `--tunnel-runtime-probe` is forbidden until a trusted writer contract passes separate review**; keep the path unconfigured (default `null` ⇒ `unknown`) and never present `cloud=ready` as achievable. Adopting the file contract later requires ALL of: writer identity, atomic update method, freshness/TTL, provenance checks (regular file + owner + mode), profile+PID binding, and tests.

Detection/remediation latency (explicit): failure is noticed after ≥1 round (≤5 min, StartInterval=300), acted on after ≥2 consecutive rounds (≈10 min worst case), then per-label cooldown 15 min. Proxy `127.0.0.1:7897` is a third-party tool: not managed, not kickstarted here — CONNECT gate only classifies and alerts.
CONNECT probe targets must be **DNS hostname + explicit port** (`host:443`): `validateConnectTarget` rejects IPv6 literals (`[::1]:443` ⇒ invalid-target-format), userinfo, paths, and control characters; IPv4 dotted quads pass the grammar but are untested — prefer hostnames (v2.1 P2-5).

## Credentials
- No credential values in any plist. origin/tunnel plists carry NO `EnvironmentVariables`; the watchdog plist carries only the non-sensitive allowlist (`PATH`, `HOME`, `LANG`) — enforced by test.
- Origin env enters only via `__CLOUD_MCP_ENV_FILE__` (mode 0600, owner uid; wrapper fail-closed otherwise). The wrapper **never sources it**: a strict parser accepts only `KEY=VALUE` lines (optional `export ` prefix, comments allowed) with keys from a fixed allowlist (`CAT_CAFE_REMOTE_TOKEN`, `CAT_CAFE_AGENT_KEY_FILES`, `CAT_CAFE_REMOTE_PORT`, `CAT_CAFE_DESKTOP_MODE`, `CAT_CAFE_READONLY`, `CAT_CAFE_CAT_ID`, `CAT_CAFE_AGENT_KEY_BOUND_CAT_ID`, `CAT_CAFE_USER_ID`, `CAT_CAFE_API_URL`, `CAT_CAFE_DATA_DIR`); values containing `` ` `` `$` `;` `|` `&` `<` `>` `\` are rejected, so a stray command line fails closed instead of executing under the service identity. v2.1 format additions: files must be **LF-only** (any CR ⇒ refuse `env-file-crlf`, do not auto-strip), **keys must not repeat** (last-wins masking ⇒ refuse `env-file-duplicate`), and lines with leading whitespace before `export`/`KEY` are refused (fail-closed strictness — write one assignment per line starting at column 0).
- v2.1.4 P1-1: required-key completeness has exactly ONE definition — `REQUIRED_ENV_KEYS` plus `verify_env_ready()` inside the origin wrapper. The production startup path and the operator-facing `--verify-env` gate call that same function, so a file the runbook accepts is verified at exactly the strength startup demands; both paths print key NAMES only, never values. The older `--parse-env` seam (syntax-only, no completeness) is removed.
- Tunnel token material stays inside the existing profile dir `/Users/yuhan/.cat-cafe/cloud-tunnel/profiles` (read by tunnel-client itself). `connect-tunnel.py` is not invoked anywhere in this design; its token-in-argv path is avoided, **not fixed** — keep it that way: do not mix old scripts with the launchd owner.
- Namespaces (verified where noted):
  - tunnel: isolated `HOME=/Users/yuhan/.cat-cafe/zcode/app-server-home`; `XDG_CONFIG_HOME=$HOME/.config`, `XDG_STATE_HOME=$HOME/.local/state` — **verified 2026-11-23 from the live owner process env** (#128 fact pack; exact strings match the wrapper). cwd stays `/Users/yuhan/cat-cafe/clowder-ai` — verified 2026-11-23 via `lsof -d cwd` on the live owner (HOME ≠ cwd).
  - tunnel proxy env: `HTTP(S|ALL)_PROXY` upper+lower = `http://127.0.0.1:7897` and `NO_PROXY/no_proxy=localhost,127.0.0.1,::1` — all **verified 2026-11-23 from the live owner process env**; wrapper exports them explicitly (launchd does not inherit shell env). This is ENV-VALUE PARITY ONLY: it does not mean 7897 is reachable now or that CONNECT succeeds — the wrapper's TCP prescreen and the watchdog CONNECT gate still fail closed on their own measurements.
  - origin (v2.1.6 corrected): `HOME=/Users/yuhan/.cat-cafe/zcode/app-server-home` pinned in the wrapper — the SAME isolated home the live origin (PID 49473) runs with. Evidence tiers, kept distinct: (i) live process env: `CAT_CAFE_DATA_DIR=<unset>`, `CAT_CAFE_CALLBACK_OUTBOX_DIR=<unset>`; (ii) latest init log line `Initialized directory: …app-server-home/.cat-cafe` (no PID/timestamp — corroborating, not proof of who created it); (iii) code fallback read from a workspace source copy whose two relevant files are SHA256-identical to the runtime dist: with DATA_DIR unset, `path-validator.ts:39` resolves `path.join(os.homedir(), '.cat-cafe')`, and `os.homedir()` RETURNS the process HOME — so pinning HOME to the live value reproduces the live data root and the `callback-outbox` fallback path exactly. `CAT_CAFE_DATA_DIR` stays deliberately UNSET (live fallback semantics); the env allowlist is NOT widened for outbox paths. Earlier candidates pinned `HOME=/Users/yuhan` on an inverted `os.homedir()` rationale — that was a data-root drift bug, fixed here. Agent keys themselves come only from the absolute paths in `CAT_CAFE_AGENT_KEY_FILES`. origin XDG/proxy vars are NOT set by the candidate: source-copy grep shows zero `XDG_*`/proxy-env/ProxyAgent consumers in mcp-server origin code, so they are inert on the live process (documented choice, not an omission; says nothing about tunnel-side proxying).

## Placeholders (install refuses while any `__X__` remains)
`__NODE_BIN__` (absolute node ≥ current runtime version — resolved fail-fast at install, see below), `__TUNNEL_CLIENT_BIN__` (host-verified absolute path `/Users/yuhan/.cat-cafe/cloud-tunnel/bin/tunnel-client`, 0.0.14, the binary currently running in tmux; NOT guaranteed to be on PATH), `__WRAPPER_DIR__` (final install dir for the scripts), `__STATE_DIR__`, `__LOG_DIR__`, `__CLOUD_MCP_ENV_FILE__`.
Token-bearing artifacts (v2.1.7 P1-2): the three plist templates carry `__WRAPPER_DIR__/__LOG_DIR__/__NODE_BIN__/__STATE_DIR__` inside values; the two WRAPPERS carry column-0 assignments `__NODE_BIN__`/`__TUNNEL_CLIENT_BIN__`/`__STATE_DIR__`/`__CLOUD_MCP_ENV_FILE__` and are rendered by the anchored `render_wrapper` in the Install block — never raw-copied. Both render paths have fail-closed residue scans (plists: full-file `__` grep; wrappers: anchored column-0 assignment grep, because the indented guard-comparison literals must survive). Template PROSE must never spell the token form (P1-1: a doc comment saying the generic word forced every first-plist refusal).

## Install (operator, host shell)
Template filenames are identical to launchd labels (`<label>.plist.template`), so the loop derives both from `$L`.
```bash
LABELS=(com.cat-cafe.cloud-mcp-origin com.cat-cafe.cloud-mcp-tunnel com.cat-cafe.cloud-mcp-watchdog)
SRC=/path/to/this/scripts/launchd
DST=/Users/yuhan/.cat-cafe/cloud-mcp
# v2.1.8 P1-4b / v2.1.9 ordering (gpt-pro review risk #1): the login reload scans
# the REAL console user's home. The wrappers' isolated HOME is a SERVICE-RUNTIME
# fact and must never decide where plists are published — publishing into an
# isolated-HOME shell's $HOME would silently defeat autostart. The resolver runs
# FIRST: a wrong-HOME shell aborts before mkdir, marker, render or install touch
# the filesystem. sudo/root: `id -un` says root while HOME is /var/root (or a
# preserved user HOME) — neither matches /Users/<user> ⇒ refused (launchd would
# never reload that dir anyway). A launchd-spawned shell is service runtime and
# is never an install path. v2.1.10 (gpt-pro checkpoint #1): the override is
# DOUBLE-GATED — set alone it REFUSES; it only works together with an explicit
# CONFIRM_LAUNCH_AGENTS_OVERRIDE=yes, so an incidental exported variable in some
# shell can never silently redirect the publish target. A REAL operator install
# never sets either variable; they exist for sandbox/fixture and explicitly
# authorized special installs only.
if [ -n "${LAUNCH_AGENTS_DIR_OVERRIDE:-}" ]; then
  [ "${CONFIRM_LAUNCH_AGENTS_OVERRIDE:-}" = "yes" ] \
    || { echo "refusing: LAUNCH_AGENTS_DIR_OVERRIDE is set without CONFIRM_LAUNCH_AGENTS_OVERRIDE=yes — the override is a test/explicit-authorization escape, never an incidental environment variable"; exit 1; }
  LAUNCH_AGENTS_DIR="$LAUNCH_AGENTS_DIR_OVERRIDE"
  echo "WARNING: LAUNCH_AGENTS_DIR_OVERRIDE in effect (CONFIRMed; test / explicitly-authorized use only) — publish target: $LAUNCH_AGENTS_DIR"
else
  case "$HOME" in
    "/Users/$(id -un)") LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents" ;;
    *) echo "HOME ($HOME) is not the real user home — launchd login reload only scans the console user's ~/Library/LaunchAgents; run the install from that shell (isolated-HOME shells are service runtime, not install time)"; exit 1 ;;
  esac
fi
# Pre-existing DST policy (v2.1.1 P2-A): canonicalize; an existing UNMARKED
# non-empty dir is refused outright (never blended/overwritten); a marked dir
# re-installs only the managed whitelist, marker must be owner-uid.
if [ -e "$DST" ]; then
  DST="$(cd "$DST" && pwd -P)"
  if [ ! -f "$DST/.cloud-mcp-root" ]; then
    [ -z "$(ls -A "$DST" 2>/dev/null)" ] || { echo "refusing: $DST non-empty WITHOUT install marker"; exit 1; }
  else
    [ "$(stat -f '%u' "$DST/.cloud-mcp-root")" = "$(id -u)" ] || { echo "refusing: marker not owner-uid"; exit 1; }
    echo "re-install: only whitelisted managed files will be overwritten"
  fi
fi
# Binary resolution is fail-fast (v2.1 P1-2): an empty `command -v` would
# otherwise sed a blank <string> into the plist, survive grep '__', lint via
# plutil, and leave launchd in a permanent spawn-fail loop.
NODE_BIN="$(command -v node || true)"
{ [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] && [ "${NODE_BIN#/}" != "$NODE_BIN" ]; } \
  || { echo "node: absolute executable not found in PATH — set NODE_BIN explicitly"; exit 1; }
"$NODE_BIN" --version   # operator: confirm >= the runtime version remote-spike was built for
TUNNEL_BIN="${TUNNEL_BIN_OVERRIDE:-/Users/yuhan/.cat-cafe/cloud-tunnel/bin/tunnel-client}"  # host-verified absolute path; override if it moves
{ [ -n "$TUNNEL_BIN" ] && [ -x "$TUNNEL_BIN" ] && [ "${TUNNEL_BIN#/}" != "$TUNNEL_BIN" ]; } \
  || { echo "tunnel-client: not found/not executable at $TUNNEL_BIN"; exit 1; }
mkdir -p "$DST/logs" "$DST/state" "$DST/LaunchAgents"
printf 'cloud-mcp launchd set root — see INSTALL-cloud-mcp.md\n' > "$DST/.cloud-mcp-root"  # teardown guard marker
# v2.1.7 P1-2/P1-3 (install-preflight finding by 砚砚61): the wrappers THEMSELVES
# carry placeholder assignments and must be RENDERED, never raw-copied — the old
# `install -m 700 ...-wrapper.sh` produced installed wrappers whose production
# entry exited 78 on their own unreplaced-placeholder guard. Rendering is
# anchored to COLUMN-0 assignment lines ONLY: a global s/__X__/value/g would
# also rewrite the guard-comparison literals inside each wrapper's if-line,
# turning the fail-closed check into an always-true refusal. Guard literals are
# indented, so the anchored form provably cannot touch them.
# v2.1.8 (gpt-pro review risk #3): reject control characters too (newline/CR in
# a resolved path would break the anchored substitution AND the residue scan
# class); none of the existing -n/-x/absolute gates catches them.
nl=$'\n'; cr=$'\r'
case "$NODE_BIN" in *["$nl$cr|&\"\\"]*) echo "node path contains sed metacharacters or control chars — refusing render"; exit 1;; esac
case "$TUNNEL_BIN" in *["$nl$cr|&\"\\"]*) echo "tunnel-client path contains sed metacharacters or control chars — refusing render"; exit 1;; esac
case "$DST" in *["$nl$cr|&\"\\"]*) echo "DST contains sed metacharacters or control chars — refusing render"; exit 1;; esac
render_wrapper() { # $1 = source wrapper, $2 = installed path
  sed -e "s|^NODE_BIN=\"__NODE_BIN__\"$|NODE_BIN=\"$NODE_BIN\"|" \
      -e "s|^TUNNEL_BIN=\"__TUNNEL_CLIENT_BIN__\"$|TUNNEL_BIN=\"$TUNNEL_BIN\"|" \
      -e "s|^STATE_DIR=\"__STATE_DIR__\"$|STATE_DIR=\"$DST/state\"|" \
      -e "s|^ENV_FILE=\"__CLOUD_MCP_ENV_FILE__\"$|ENV_FILE=\"$DST/env.origin\"|" \
      "$1" > "$2"
}
render_wrapper "$SRC/cloud-mcp-origin-wrapper.sh" "$DST/cloud-mcp-origin-wrapper.sh"
render_wrapper "$SRC/cloud-mcp-tunnel-wrapper.sh" "$DST/cloud-mcp-tunnel-wrapper.sh"
chmod 700 "$DST/cloud-mcp-origin-wrapper.sh" "$DST/cloud-mcp-tunnel-wrapper.sh"
# fail-closed post-render scan: a SURVIVING column-0 placeholder assignment means
# an anchor silently missed (new/unrendered var) — refuse. Deliberately anchored
# like the render: indented guard literals are EXPECTED to remain and are not
# residue. (watchdog.mjs carries no placeholders; it is copied unchanged.)
if grep -nE '^[A-Z_]+="__' "$DST/cloud-mcp-origin-wrapper.sh" "$DST/cloud-mcp-tunnel-wrapper.sh"; then
  echo "placeholder assignment left in installed wrapper"; exit 1
fi
install -m 700 "$SRC/cloud-mcp-watchdog.mjs" "$DST/"
for L in "${LABELS[@]}"; do
  test -f "$SRC/$L.plist.template" || { echo "missing template for $L"; exit 1; }
  sed -e "s|__WRAPPER_DIR__|$DST|g" -e "s|__STATE_DIR__|$DST/state|g" \
      -e "s|__LOG_DIR__|$DST/logs|g" -e "s|__NODE_BIN__|$NODE_BIN|g" \
      -e "s|__TUNNEL_CLIENT_BIN__|$TUNNEL_BIN|g" \
      -e "s|__CLOUD_MCP_ENV_FILE__|$DST/env.origin|g" \
      "$SRC/$L.plist.template" > "$DST/LaunchAgents/$L.plist"
  # guards are explicit if/fi (v2.1.1 P1): hit => refuse, miss => continue.
  # No `grep && { }` AND-list shorthand to argue about under `set -e`.
  if grep -q '__' "$DST/LaunchAgents/$L.plist"; then
    echo "placeholder left in $L"; exit 1
  fi
  if grep -qE '<string></string>' "$DST/LaunchAgents/$L.plist"; then
    echo "empty argument string in $L"; exit 1
  fi
  if ! plutil -lint "$DST/LaunchAgents/$L.plist"; then
    echo "plist lint failed for $L"; exit 1
  fi
done
# v2.1.8 P1-4c (gpt-pro review risk #2): PUBLISH ONLY AFTER all three templates
# rendered, scanned and linted above — a mid-loop failure never reaches this
# point. Names in the chain are exact (no globs).
# v2.1.9 (gpt-pro review risk #2): the login dir is CREATED ONLY HERE, at publish
# time, after every render/scan/lint passed. Before the &&-chain, every surviving
# login copy is byte-compared against this run's validated render: missing or
# identical ⇒ proceed (that is exactly a re-run completing a previously
# interrupted publish — recovery is idempotent by construction); anything else
# (foreign content, stale render from an older config, directory, dangling
# symlink) ⇒ refuse WITHOUT touching it. The runbook never overwrites a login
# copy it cannot prove is its own.
mkdir -p "$LAUNCH_AGENTS_DIR"
for L in "${LABELS[@]}"; do
  t="$LAUNCH_AGENTS_DIR/$L.plist"
  if [ -L "$t" ]; then
    echo "refusing: login copy $t is a symlink — inspect and remove it explicitly, then re-run"; exit 1
  fi
  if [ -e "$t" ] && { [ ! -f "$t" ] || ! cmp -s "$DST/LaunchAgents/$L.plist" "$t"; }; then
    echo "refusing: login copy $t exists and is not this run's validated render (foreign/stale/non-regular) — inspect and remove it explicitly, then re-run"; exit 1
  fi
done
if ! { install -m 644 "$DST/LaunchAgents/com.cat-cafe.cloud-mcp-origin.plist" "$LAUNCH_AGENTS_DIR/com.cat-cafe.cloud-mcp-origin.plist" \
  && install -m 644 "$DST/LaunchAgents/com.cat-cafe.cloud-mcp-tunnel.plist" "$LAUNCH_AGENTS_DIR/com.cat-cafe.cloud-mcp-tunnel.plist" \
  && install -m 644 "$DST/LaunchAgents/com.cat-cafe.cloud-mcp-watchdog.plist" "$LAUNCH_AGENTS_DIR/com.cat-cafe.cloud-mcp-watchdog.plist"; }; then
  echo "publish failed — see message above; re-run install after fixing the cause"; exit 1
fi
echo "login reload dir: $LAUNCH_AGENTS_DIR"
```
**Mid-chain publish failure recovery (v2.1.10, gpt-pro checkpoint #2).** If the chain exits with `publish failed`, the earlier published copies are byte-identical to this run's validated renders; the FAILED name is either absent (plain re-run completes it after the byte-comparison passes "missing") — or, if `install` was killed mid-write, PARTIAL. A partial leftover is by design refused as "not this run's validated render" and NEVER auto-overwritten. The operator recovery path is explicit: inspect the printed path (`plutil -lint` it, compare against the staged build record `$DST/LaunchAgents/<label>.plist`), then `rm` the named leftover yourself, then re-run the Install block — the completion pass publishes it fresh. The runbook never guesses its way past a byte mismatch; a refusal that names the exact path is the handoff point to the human.
### env.origin secure creation (v2.1.1 P2-C / v2.1.2 P1 / v2.1.3 P1 / v2.1.4 P1 / v2.1.5 P2: create-or-verify; `$EDITOR` is a checked, required step; one shared validator; symlink-safe exclusive create)
Create `$DST/env.origin` (mode 600, owner uid) in the strict parser format BEFORE bootstrapping the origin label. Rules: never `echo`/`cat <<EOF` a value (stays in shell history), values come only from the existing secure source (keychain / current 0600 env file). **v2.1.3 P1: an EXISTING env.origin is verified read-only and `$EDITOR` is never launched against it; a MISSING one is created (create-only) and only that fresh empty file is edited. owner/mode mismatch and verification failure abort with `exit 1`, not prose.**
**v2.1.4 P1-1: the gate command is `--verify-env`, not `--parse-env`.** `--verify-env` runs the wrapper's own `verify_env_ready` — strict parse **plus** required-key completeness over the single `REQUIRED_ENV_KEYS` list that the production startup path also uses — and prints key NAMES only. The v2.1.3 seam accepted a syntactically valid file with no credentials at all, so a `.new` missing `CAT_CAFE_REMOTE_TOKEN` or `CAT_CAFE_AGENT_KEY_FILES` could have been `mv`'d over a working env.origin; a stale `--parse-env` invocation now falls through to the startup path and refuses (exit 78) rather than silently doing a weaker check.
**v2.1.4 P1-2: `$EDITOR` must be set and resolvable, and its exit status is checked.** The blocks below refuse before creating anything if `EDITOR` is empty or is not a single executable (no argument words), and abort immediately if the editor exits nonzero — a failed edit never proceeds to verification, installation or rotation, and the live env.origin keeps its bytes.
**v2.1.5 P2: `[ ! -e ]` cannot see a dangling symlink, and a plain `: > path` follows it** — that would create or truncate the link TARGET (outside `$DST`) while the operator believed a fresh credential file was being made. Both blocks now (a) refuse a credential path that is a symlink or a non-regular file (`assert_plain_file`, re-checked AFTER the editor because rename-on-save editors swap the inode), and (b) create with **noclobber exclusive create** `( set -C; : > path )`, verified on macOS Bash 3.2.57 to return nonzero and create NOTHING when the name already exists as a symlink whose target is missing. Remaining boundary: the gate and the `mv` are not one atomic step — a symlink swapped into the path by another process between them is caught by the uninstall scan and the wrapper's own `-f`/owner/mode gates, not by this snippet (see NOT-verified).
```bash
DST=/Users/yuhan/.cat-cafe/cloud-mcp
umask 077
# v2.1.5 P2: a credential path must be a REGULAR file at this exact name. `-e`
# alone reports false for a dangling symlink, and `: >` would then write through
# it. Refuse instead of following, and re-check after the editor runs.
assert_plain_file() {
  if [ -L "$1" ]; then
    echo "refusing: $1 is a symlink (dangling or not) — inspect and remove it yourself; nothing was read, written or followed" >&2; exit 1
  fi
  if [ -e "$1" ] && [ ! -f "$1" ]; then
    echo "refusing: $1 exists but is not a regular file (dir/fifo/socket/device?) — nothing was read, written or followed" >&2; exit 1
  fi
}
assert_plain_file "$DST/env.origin"
if [ ! -e "$DST/env.origin" ]; then
  [ -n "${EDITOR:-}" ] || { echo "refusing: EDITOR is unset/empty — export EDITOR=<one executable> (no arguments) and re-run" >&2; exit 1; }
  command -v "$EDITOR" >/dev/null 2>&1 || { echo "refusing: EDITOR ($EDITOR) is not a resolvable single executable — arguments in EDITOR are not supported by this runbook" >&2; exit 1; }
  # exclusive create (noclobber): fails if ANY name appears at that path,
  # including a symlink to a missing target — so no create-then-follow window
  if ! ( set -C; : > "$DST/env.origin" ) 2>/dev/null; then
    echo "refusing: exclusive create of $DST/env.origin failed — the path appeared mid-run; nothing was written" >&2; exit 1
  fi
  chmod 600 "$DST/env.origin"
  # editor only ever sees a freshly created, empty, 0600 file; a nonzero editor
  # exit aborts here — no verification, no bootstrap, nothing installed
  if ! "$EDITOR" "$DST/env.origin"; then
    echo "refusing: editor exited nonzero — env.origin left unverified; fix or remove the fresh file and re-run (use the .new rotation path to edit it later)" >&2; exit 1
  fi
  assert_plain_file "$DST/env.origin"
else
  echo "existing $DST/env.origin — read-only verification only, no editor" >&2
fi
env_owner="$(stat -f '%u' "$DST/env.origin")"; env_mode="$(stat -f '%Lp' "$DST/env.origin")"
{ [ "$env_owner" = "$(id -u)" ] && [ "$env_mode" = 600 ]; } \
  || { echo "refusing: env.origin owner/mode ${env_owner}/${env_mode}, want $(id -u)/600 — fix ownership/mode; this gate runs before any use" >&2; exit 1; }
if ! bash "$DST/cloud-mcp-origin-wrapper.sh" --verify-env "$DST/env.origin"; then
  echo "refusing: env.origin failed parse + required-key verification (key NAMES only are printed; values never are)" >&2; exit 1
fi
```
To ROTATE contents: never touch the live file — everything happens in an inert side file that is atomically renamed only after every check passes:
```bash
DST=/Users/yuhan/.cat-cafe/cloud-mcp
umask 077
assert_plain_file() {
  if [ -L "$1" ]; then
    echo "refusing: $1 is a symlink (dangling or not) — inspect and remove it yourself; nothing was read, written or followed" >&2; exit 1
  fi
  if [ -e "$1" ] && [ ! -f "$1" ]; then
    echo "refusing: $1 exists but is not a regular file (dir/fifo/socket/device?) — nothing was read, written or followed" >&2; exit 1
  fi
}
# the live path must be a regular file before anything is written next to it
assert_plain_file "$DST/env.origin"
# .new must not exist AT ALL — including as a dangling symlink, which `-e`
# cannot see (v2.1.5 P2); the symlink case gets its own message
if [ -L "$DST/env.origin.new" ]; then
  echo "refusing: $DST/env.origin.new is a symlink — do not write through it; inspect and remove it yourself (create-only guarantee)" >&2; exit 1
fi
if [ -e "$DST/env.origin.new" ]; then
  echo "refusing: $DST/env.origin.new already exists — inspect/remove it first (create-only guarantee)" >&2; exit 1
fi
[ -n "${EDITOR:-}" ] || { echo "refusing: EDITOR is unset/empty — export EDITOR=<one executable> (no arguments) before rotating" >&2; exit 1; }
command -v "$EDITOR" >/dev/null 2>&1 || { echo "refusing: EDITOR ($EDITOR) is not a resolvable single executable — arguments in EDITOR are not supported by this runbook" >&2; exit 1; }
if ! ( set -C; : > "$DST/env.origin.new" ) 2>/dev/null; then
  echo "refusing: exclusive create of $DST/env.origin.new failed — the path appeared mid-run; live env.origin untouched" >&2; exit 1
fi
# editor only ever sees the inert .new, never the live file
if ! "$EDITOR" "$DST/env.origin.new"; then
  echo "refusing: editor exited nonzero — live env.origin untouched; quarantine/remove env.origin.new yourself" >&2; exit 1
fi
assert_plain_file "$DST/env.origin.new"
n_owner="$(stat -f '%u' "$DST/env.origin.new")"; n_mode="$(stat -f '%Lp' "$DST/env.origin.new")"
{ [ "$n_owner" = "$(id -u)" ] && [ "$n_mode" = 600 ]; } \
  || { echo "refusing: .new owner/mode ${n_owner}/${n_mode} — live env.origin untouched" >&2; exit 1; }
if ! bash "$DST/cloud-mcp-origin-wrapper.sh" --verify-env "$DST/env.origin.new"; then
  echo "refusing: .new failed parse + required-key verification — live env.origin untouched; quarantine/remove .new yourself" >&2; exit 1
fi
mv -f "$DST/env.origin.new" "$DST/env.origin"   # atomic rename; displaced inode is unlinked, not zeroed — dispose per destruction note
```
Backups/copies of this file follow the operator's approved secret-storage policy only (none is created by this runbook). Destruction at uninstall: the `CONFIRM_REMOVE_ENV=yes` branch below runs `rm -P` (overwrite+unlink) **fail-closed — if rm -P fails, the uninstall aborts instead of falling back to a plain unlink**. Best-effort only: on SSD/APFS wear-leveling this is NOT a forensic guarantee; an approved backup/crypto-erase policy still governs.

Idempotent load — watchdog only at this point; origin loads AFTER its legacy-listener switchover (next section), tunnel LAST and only after the tunnel switchover steps. All bootstrap paths point at the login copies in `$LAUNCH_AGENTS_DIR` (v2.1.8 P1-4b; printed by the Install block) — that is what makes the NEXT login reload the set automatically. Running these snippets from a fresh shell: first `export LAUNCH_AGENTS_DIR=/Users/$(id -un)/Library/LaunchAgents` (the real console user home — never the isolated service HOME); a wrong value here loads the plist but breaks reload, so the uninstall scan will still find and remove it by the same variable:
```bash
L=com.cat-cafe.cloud-mcp-watchdog
launchctl bootout "gui/$(id -u)/$L" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$L.plist"
launchctl enable "gui/$(id -u)/$L" || true
```

## Origin leg switchover from the legacy remote-spike (one-time, ordered; v2.1.7 P1-5)
The origin label binds 127.0.0.1:3098; if a legacy `remote-spike.js` (the operator's manual launch, or an earlier bootstrapped copy) still holds the port, the supervised origin enters a KeepAlive bind-fail loop. The old runbook only spelled out the tunnel leg — this closes the gap.
1. Identify the listener: `lsof -nP -iTCP:3098 -sTCP:LISTEN`. Nothing listening ⇒ skip to step 4.
2. Verify identity per pid BEFORE touching anything: `ps -o pid,user,command -p <pid>` must show exactly one `node …/cat-cafe-runtime/packages/mcp-server/dist/remote-spike.js` owned by you. Any other occupant = STOP and investigate; never kill blindly, never bootstrap against an unidentified listener.
3. `kill <verified-pid>` (graceful TERM), then re-run step 1's lsof and confirm the port is free.
4. Bootstrap the origin label from the HOME copy:
```bash
L=com.cat-cafe.cloud-mcp-origin
launchctl bootout "gui/$(id -u)/$L" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$L.plist"
launchctl enable "gui/$(id -u)/$L" || true
```
Verify: `launchctl print "gui/$(id -u)/$L"` shows state running and the wrapper's exec'd node holds 3098.

## Switchover from the current tmux owner (tunnel leg; one-time, ordered)
1. Verify current owner: `tmux ls`; `pgrep -fl "tunnel-client run --profile-dir /Users/yuhan/.cat-cafe/cloud-tunnel/profiles --profile cat-cafe-gpt-pro"`; record PID; `lsof -p <pid> -a -d cwd` must show the repo root.
2. Re-confirm (read-only) that the live owner env still matches the 2026-11-23 fact pack values (NO_PROXY/no_proxy, six proxy vars, XDG pair, origin HOME/DATA_DIR-unset) before bootstrap; the wrapper TODOs were resolved from those facts — if the live env has drifted since, re-extract and reconcile BEFORE touching the labels.
3. Stop the old owner gracefully (Ctrl-C in its tmux window or `kill <verified-pid>` after re-checking `ps -o pid,user,command -p <pid>` matches exactly one tunnel-client). Keep the tmux session itself for audit. Verify the PID is gone before proceeding.
4. Bootstrap the tunnel label (from the HOME copy) and only then:
```bash
L=com.cat-cafe.cloud-mcp-tunnel
launchctl bootout "gui/$(id -u)/$L" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$L.plist"
launchctl enable "gui/$(id -u)/$L" || true
```
The wrapper's bound-identity owner probe refuses (exit 75, throttled retry) while another same-profile owner exists, so a missed step 3 cannot produce double instances — it produces a visible gate marker instead. It never kills anything. Known conservative false-refusal (v2.1 P2-4): any operational command whose own argv contains the full canonical invocation (a `grep`/`tmux send-keys` line carrying the complete `tunnel-client run --profile-dir … --profile …` string) can be counted as an owner. Check the gate marker's logged pid against `ps` before believing a double-instance report — a false refusal stalls the tunnel leg, it never corrupts state.
5. Confirm `tunnel.out.log` shows connection and `watchdog-latest.json` shows `tunnel.launchd ... running` (runtime still `unknown` until the probe TODO lands — that is expected, not health).

## Native tunnel-client log (v2.1.11 P2-2 env floor)
The tunnel wrapper export-pins `LOG_LEVEL=warn` and `LOG_HTTP_RAW_UNSAFE=false` immediately before `exec`. Verified scope (砚砚61 host probe, client 0.0.14+0f870e50a973fa820d4c409000059e181e8d242b): at default info the client writes the query-token-bearing MCP target URL into its own native log (fields `target`/`mcp_target_value`, 2 startup records per generation); under `warn` those records are absent in fault-free and MCP-500 runs while WARN/ERROR diagnostics remain. The native log LOCATION and rotation are unchanged (client-managed, currently 0600 file under a 0700 parent); this floor does not erase history — **pre-existing info-level lines remain on disk until the operator decides disposal**; reviewing them is itself a token-exposure act, so treat their content as credential-bearing. This is version-pinned evidence, not a forward guarantee: a client upgrade may log differently and MUST be re-probed before trusting it (see NOT-verified). Never "fix" this by pointing `LOG_FILE` at `/dev/null` — that discards diagnostics and is out of scope here.

## Stop / disable / uninstall (per label, all idempotent)
```bash
# v2.1.10 (gpt-pro checkpoint #3): validate the shell BEFORE the first launchctl
# side effect. Stopping from a wrong-HOME shell would boot the services out while
# the later file-removal step refuses to see the login copies — the next login
# would then silently RELOAD them (half-uninstall that reanimates). Same
# double-gate as install; a real uninstall runs from the console user's shell
# with neither variable set.
if [ -n "${LAUNCH_AGENTS_DIR_OVERRIDE:-}" ]; then
  [ "${CONFIRM_LAUNCH_AGENTS_OVERRIDE:-}" = "yes" ] \
    || { echo "refusing: LAUNCH_AGENTS_DIR_OVERRIDE is set without CONFIRM_LAUNCH_AGENTS_OVERRIDE=yes — stop/uninstall escape must be deliberate, not incidental"; exit 1; }
else
  case "$HOME" in
    "/Users/$(id -un)") ;;
    *) echo "stop/uninstall: HOME ($HOME) is not the real user home — refusing before ANY launchctl side effect"; exit 1 ;;
  esac
fi
UID_N=$(id -u)
for L in com.cat-cafe.cloud-mcp-origin com.cat-cafe.cloud-mcp-tunnel com.cat-cafe.cloud-mcp-watchdog; do
  launchctl bootout "gui/$UID_N/$L" 2>/dev/null || true    # stop now
  launchctl disable "gui/$UID_N/$L" 2>/dev/null || true    # stay stopped across login
done
```
Uninstall files (no bare `rm -rf`; requires the install marker and an exact canonical path; v2.1.1 P1-B + v2.1.2 P1/P2 + v2.1.3 P1/P2: EVERY entry under `$DST` is class-checked — regular files against the explicit managed manifest, symlinks refused outright, directories against an exact directory whitelist, fifo/socket/device entries refused by type; all scans run through captured `find` exit codes and ANY scan failure or unexpected entry aborts with zero deletions; the credential file `env.origin` is never silently deleted):
```bash
DST=/Users/yuhan/.cat-cafe/cloud-mcp
# v2.1.8 P1-4b / v2.1.10 double-gate: same resolution as install — the login
# copies live in the REAL user home; refusing on a wrong HOME (or on an
# UNCONFIRMed override) prevents a partial uninstall that leaves the reload set
# active while $DST is gone.
if [ -n "${LAUNCH_AGENTS_DIR_OVERRIDE:-}" ]; then
  [ "${CONFIRM_LAUNCH_AGENTS_OVERRIDE:-}" = "yes" ] \
    || { echo "refusing: LAUNCH_AGENTS_DIR_OVERRIDE is set without CONFIRM_LAUNCH_AGENTS_OVERRIDE=yes — uninstall escape must be deliberate, not incidental"; exit 1; }
  LAUNCH_AGENTS_DIR="$LAUNCH_AGENTS_DIR_OVERRIDE"
else
  case "$HOME" in
    "/Users/$(id -un)") LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents" ;;
    *) echo "uninstall: HOME ($HOME) is not the real user home — run from the console user's shell (refusing to miss the login copies)"; exit 1 ;;
  esac
fi
if [ -f "$DST/.cloud-mcp-root" ] && [ "$(cd "$DST" && pwd -P)" = "$DST" ]; then
  MANAGED_RE='^(/LaunchAgents/com\.cat-cafe\.cloud-mcp-(origin|tunnel|watchdog)\.plist|/cloud-mcp-(origin|tunnel)-wrapper\.sh|/cloud-mcp-watchdog\.mjs|/\.cloud-mcp-root|/env\.origin|/state/watchdog\.(com\.cat-cafe\.cloud-mcp-(origin|tunnel)|latest)\.json|/logs/(origin|tunnel|watchdog)\.(out|err)\.log(\.[123])?|/logs/watchdog-status\.tsv(\.[123])?)$'
  DIR_RE='^/(LaunchAgents|state|logs)$'
  # v2.1.3 P1: scan results go to a private mktemp dir (0700, outside DST) and
  # every find exit code is consumed — a partial scan aborts BEFORE any rm.
  # v2.1.3 P2: a fourth predicate-class refuses fifo/socket/device entries.
  # Known limit: newline-delimited scan; file names containing newlines are
  # treated as separate (foreign) entries => refusal, never deletion (deletion
  # list below is hardcoded literals, scan output can never feed it).
  scan="$(mktemp -d "${TMPDIR:-/tmp}/cloud-mcp-scan.XXXXXX")" \
    || { echo "uninstall: cannot create private scan dir — aborting with zero deletions" >&2; exit 1; }
  find_rc=0
  find "$DST" -mindepth 1 -type l 2>>"$scan/err" >"$scan/links" || find_rc=1
  find "$DST" -mindepth 1 -type f 2>>"$scan/err" >"$scan/files" || find_rc=1
  find "$DST" -mindepth 1 -type d 2>>"$scan/err" >"$scan/dirs" || find_rc=1
  find "$DST" -mindepth 1 ! -type f ! -type d ! -type l 2>>"$scan/err" >"$scan/special" || find_rc=1
  if [ "$find_rc" != 0 ]; then
    echo "uninstall: find scan FAILED — aborting with zero deletions" >&2
    cat "$scan/err" >&2
    rm -f "$scan/links" "$scan/files" "$scan/dirs" "$scan/special" "$scan/err"
    rmdir "$scan"
    exit 1
  fi
  foreign=0
  while IFS= read -r f; do
    echo "uninstall: foreign symlink, refusing: $f" >&2; foreign=1
  done < "$scan/links"
  while IFS= read -r f; do
    if ! printf '%s\n' "/${f#"$DST"/}" | grep -qE "$MANAGED_RE"; then
      echo "uninstall: foreign file, refusing: $f" >&2; foreign=1
    fi
  done < "$scan/files"
  while IFS= read -r d; do
    if ! printf '%s\n' "/${d#"$DST"/}" | grep -qE "$DIR_RE"; then
      echo "uninstall: foreign dir, refusing: $d" >&2; foreign=1
    fi
  done < "$scan/dirs"
  while IFS= read -r s; do
    echo "uninstall: special file (fifo/socket/device), refusing: $s" >&2; foreign=1
  done < "$scan/special"
  rm -f "$scan/links" "$scan/files" "$scan/dirs" "$scan/special" "$scan/err"
  rmdir "$scan"
  [ "$foreign" = 0 ] || exit 1
  # credentials need an explicit operator decision, never a side effect
  if [ -f "$DST/env.origin" ] && [ "${CONFIRM_REMOVE_ENV:-}" != "yes" ]; then
    echo "keeping $DST/env.origin (holds credential values) — back up per approved policy; rerun with CONFIRM_REMOVE_ENV=yes to rm -P overwrite+unlink it" >&2
  elif [ -f "$DST/env.origin" ]; then
    if ! rm -P "$DST/env.origin"; then
      echo "uninstall: rm -P failed on env.origin — aborting instead of falling back to a plain unlink (v2.1.2 P2)" >&2; exit 1
    fi
    echo "env.origin overwritten+unlinked via rm -P (best-effort; NOT forensic on SSD/APFS wear-leveling)" >&2
  fi
  # v2.1.7 P1-4 / v2.1.8 P1-4b: the login copies are the reload source — remove
  # them by exact name too (only reached under the install-marker + canonical-
  # path gate; LAUNCH_AGENTS_DIR above is fail-closed on a wrong HOME)
  rm -f "$LAUNCH_AGENTS_DIR/com.cat-cafe.cloud-mcp-origin.plist" \
        "$LAUNCH_AGENTS_DIR/com.cat-cafe.cloud-mcp-tunnel.plist" \
        "$LAUNCH_AGENTS_DIR/com.cat-cafe.cloud-mcp-watchdog.plist"
  # deletion list == MANAGED_RE exactly: every allowed name enumerated, no `*` suffix globs
  rm -f "$DST/LaunchAgents/com.cat-cafe.cloud-mcp-origin.plist" \
        "$DST/LaunchAgents/com.cat-cafe.cloud-mcp-tunnel.plist" \
        "$DST/LaunchAgents/com.cat-cafe.cloud-mcp-watchdog.plist" \
        "$DST/cloud-mcp-origin-wrapper.sh" "$DST/cloud-mcp-tunnel-wrapper.sh" \
        "$DST/cloud-mcp-watchdog.mjs"
  rm -f "$DST/state/watchdog.com.cat-cafe.cloud-mcp-origin.json" \
        "$DST/state/watchdog.com.cat-cafe.cloud-mcp-tunnel.json" \
        "$DST/state/watchdog.latest.json"
  for b in origin.out origin.err tunnel.out tunnel.err watchdog.out watchdog.err; do
    rm -f "$DST/logs/$b.log" "$DST/logs/$b.log.1" "$DST/logs/$b.log.2" "$DST/logs/$b.log.3"
  done
  rm -f "$DST/logs/watchdog-status.tsv" "$DST/logs/watchdog-status.tsv.1" \
        "$DST/logs/watchdog-status.tsv.2" "$DST/logs/watchdog-status.tsv.3"
  # marker stays until the credential file is also gone, so a half-finished
  # uninstall can still be re-run with this same script
  if [ ! -f "$DST/env.origin" ]; then
    rm -f "$DST/.cloud-mcp-root"
  else
    echo "marker kept alongside env.origin — re-run with CONFIRM_REMOVE_ENV=yes to finish" >&2
  fi
  rmdir "$DST/LaunchAgents" "$DST/state" "$DST/logs" "$DST" 2>/dev/null || \
    echo "$DST not empty (env.origin kept by design?) — inspect before removing by hand"
else
  echo "refusing: $DST is not the marked install root" >&2
fi
```
No plist is bootstrapped from `$DST` alone (v2.1.7 P1-4): the rendered plists are published to `~/Library/LaunchAgents/` — the documented launchd login reload location for the gui domain — and every bootstrap command loads exactly that HOME copy; `$DST/LaunchAgents/` is kept as the build record, and uninstall removes both copies by exact name. Bootstrap-by-path WITHOUT placing the file in `~/Library/LaunchAgents` would only live until logout/reboot, which silently defeats the whole autostart托付 — the earlier revision banned the HOME copy on "override DB cleanliness" grounds and was wrong about persistence. Nothing else in `~/Library` is touched.

Rollback of a bad install: bootout all three labels → old chain can always be restored manually via the previous tmux workflow (`connect-tunnel.py`) as emergency fallback — prefer fixing the launchd set. The watchdog does not touch the legacy chain in any way.

## Local candidate tests (no side effects, safe for review)
```bash
node --test scripts/launchd/cloud-mcp-candidate.test.mjs
```
## Explicitly NOT verified this round (candidate stage)
- Any launchctl bootstrap/load, any service start/stop, any real CONNECT probe against the live proxy or network, tmux owner env inspection (NO_PROXY/XDG exact values — RESOLVED 2026-11-23 by the live-owner process-env fact pack, see Namespaces), reboot-login persistence, kill-and-auto-recover drill, tunnel runtime status probe existence (design assumes none until a host fact lands), behavior under a launchd-injected locale/TZ difference.
- v2.1 additions: the install snippet's binary-resolution fail-fast has never been executed on the host (review-sandbox only); probe mtime freshness semantics on the eventual probe file's filesystem; `command -v node` version adequacy (operator must confirm `--version` output against the runtime remote-spike was built for); the resolved tunnel-client path beyond the one host observation recorded above.
- v2.1.1 additions: the DST pre-existing check, the if/fi guards, and the uninstall manifest/`CONFIRM_REMOVE_ENV` gate have only local fixture evidence (tests simulate guard behavior and refuse/continue paths); they have never been run against a real `$DST`. `rm -P` overwrite semantics are as documented by BSD rm, not independently verified.
- v2.1.2 additions: the symlink/dir-entry refusal scan, the exact-enumeration deletion list, the create-only `env.origin` bootstrap and the fail-closed `rm -P` branch all have fixture evidence only (tmpdir on the sandbox volume; APFS `rm -P` success observed once in-review, failure-path behavior on other filesystems unverified). The whole-tree check assumes no hardlinked duplicates of foreign data under `$DST` (hardlinks pass as managed regular files by name); name-based manifest matching cannot detect content substitution.
- v2.1.3 additions: the find-rc-consuming scan (mktemp-backed, PATH-shim fault-injection tested in-review only) and the special-file class refusal (FIFO tested; socket/block/char device classes share the same predicate but are untested) have never run against a real `$DST`. The env.origin create-or-verify gates and the `.new` rotation flow are fixture-proven with a scripted EDITOR only; a real interactive editor's file-rewrite semantics (temp-file-and-rename editors may change owner/mode) still rely on the post-edit gate to catch it, which fixtures simulate but real use has not exercised.
- v2.1.4 additions: `--verify-env` equivalence with startup is proven by one shared function plus fixtures that call the seam and the runbook blocks — the **real launchd-started origin process** has never been observed enforcing it (no bootstrap performed). The EDITOR guards are tested with a scripted editor that writes and exits 0/1; an editor that exits 0 while leaving the file empty is still caught only by the required-key gate behind it. `EDITOR` values containing arguments are refused by design (single executable only) — no shell-quoting mode is offered, and operators needing `code --wait`-style launchers must wrap them in their own executable. Nothing in this version has been run against the live `env.origin`.
- v2.1.5 additions: the dangling-symlink refusal and `set -C` exclusive create are proven by the host `/bin/bash` 3.2.57 (`cannot overwrite existing file`, target not created) and by fixtures over a tmpdir `$DST` — they have never run against the real `$DST`. The `assert_plain_file` checks are per-path (name → class at check time), not an inode-identity proof: a TOCTOU window remains between any check and the later `mv -f` (the gate→rename sequence is deliberately NOT atomic, and no O_EXCL-rename primitive exists in POSIX shell here). Symlink swaps performed by a real editor between the post-editor assert and the verify gate are caught by that gate only because it re-opens by name; an editor that renames a *complete valid credential file plus an injected symlink* in the same instant window is untested. `PARSED_KEYS` reset is fixture-proven (same-shell double call); the wrapper under launchd (single call per process) is unaffected by construction.
- v2.1.6 additions: the origin `ORIGIN_HOME` correction rests on three evidence tiers kept separate above — live process-env extraction (whitelist-only, by another cat, not by this review sandbox), an init log line without PID/timestamp (corroboration only), and a workspace source copy for the two cited files (per 2026-11-23 cross-check SHA256-identical to the runtime dist; the `XDG/proxy zero-consumer` grep and `resolveSharedInvocationContext()` null-at-startup reasoning were read from the workspace copy, NOT from host files this sandbox can open). No launchd-started process has ever observed the new HOME pin; whether any per-request shared-invocation path later overrides dataDir at runtime was not exercised. The TODO→verified rewrites changed comments and doc prose only; the exported VALUES were already equal to the live facts (that equality is the finding), so behavior deltas here are limited to the origin HOME value itself.
- v2.1.7 additions: the render-chain fixes respond to 砚砚61's HOST-EXECUTED install preflight (the first time any runbook Install block ever ran against real artifacts — in a private tmpdir, never against the real `$DST`, existing services untouched): rendered plist refused (P1-1), installed wrappers exited 78 (P1-2/P1-3). Evidence for those findings is 砚砚61's scratch dir plus the shared sanitized evidence file; my local tests re-execute the same runbook block against a tmpdir `$HOME`/`$DST`, so real-host coverage remains 砚砚61's. The login-reload design (HOME `Library/LaunchAgents` copies, P1-4) has NEVER been observed across an actual logout/login or reboot — the reload behavior is documented from launchd's stated contract, not from an experiment on this host. The origin-leg switchover (P1-5) has never run against the live 3098 listener; step-2 identity verification is prose-enforced, not machine-enforced, and a mis-identified listener would be an operator error the snippets cannot prevent. `render_wrapper` anchors assume the wrappers keep placeholders at column 0 — a future refactor that indents an assignment would make the render silently no-op; the anchored post-render scan is the tripwire for exactly that.
- v2.1.8 additions: the three gpt-pro shard-1 初审 risks are closed by mechanism, each with a behavioral fixture over the REAL runbook blocks — (P1-4b) login-dir resolution refuses any shell whose HOME is not the console user's real home (install AND uninstall sides; override is the documented sandbox/test escape), (P1-4c) the three plists publish in ONE gated &&-chain only after every render/scan/lint passed, so a mid-loop failure leaves the login dir empty, and (risk #3) resolved paths carrying newline/CR are refused alongside the sed metacharacters (the pre-existing -n/-x/absolute checks did NOT cover control chars — confirmed gap, not overlap). Honest limits: the real-user-home guard was exercised only as a refuse in a sandbox (the pass side is the override; an actual install from a genuine console-user shell has not been run by anyone), the &&-chain semantics are POSIX-shell-documented, not launchd-observed, and if install itself dies between the first and third publish the earlier exact-name copies remain — a re-run overwrites them idempotently (acceptable by design, listed so nobody calls the chain transactional).
- v2.1.9 additions: (1) resolver ordering — the wrong-HOME refusal now precedes every filesystem write in the Install block (verified by a fixture asserting DST and the login dir are NOT CREATED after refusal); the sudo/root and launchd-spawned-shell cases refuse by pattern-construction but have never been EXECUTED under real sudo (the match logic is "HOME equals /Users/<id -un output>", tested only in-sandbox via the override/refuse paths). (2) the pre-publish byte-comparison converts the old 're-run overwrites idempotently' claim into a machine-checked gate: only missing-or-identical login copies may be joined by the &&-chain; foreign/stale/symlink/non-regular targets refuse untouched. Recovery after an injected mid-chain install failure is fixture-proven (first copy survives byte-identical, re-run completes the set) — but the injected failure is a PATH shim, not a real EIO/EPERM; a genuine disk-level mid-chain failure remains untested territory. The byte-comparison proves CONTENT identity, not inode provenance — an attacker-planted file crafted to equal our render would pass (accepted: at that point it is functionally our own plist).
- v2.1.10 additions: the double-gate, the pre-launchctl stop guard, and the partial-leftover recovery flow are fixture-proven in a sandbox only — `CONFIRM_LAUNCH_AGENTS_OVERRIDE` is a documented escape the operator must never need; its existence means a WRONG shell CAN still publish to an override dir if it sets both variables deliberately (that is now an explicit, logged, two-name act rather than an accident — accepted by design, not eliminated). The stop-guard test runs against a PATH shim `launchctl`, never the real launchd; recovery-from-partial is simulated by a shim that truncates mid-write, not by killing a real install. The runbook's inspect-then-remove instruction for a named leftover is prose-enforced at that step; the machine guarantee is only "never auto-overwrite".
- v2.1.11 additions: the P2-1 rotation mapping is proven at the real `runWatchdogOnce` boundary in fixtures; the P2-2 env floor is proven against a FAKE delegate (hostile ambient `debug`/`true` → delegate sees `warn`/`false`) and, for the REAL binary, ONLY by 砚砚61's bounded host probe on client 0.0.14+0f870e50a973fa820d4c409000059e181e8d242b (SHA256 309fd85d…) — the launchd-run tunnel process under the floor has not been observed yet (live set is v2.1.10 without it); after any v2.1.11 install, the FIRST acceptance must re-check the native log for new token-bearing target records. The suppression claim is version-pinned: future client builds may log differently and require re-probing. Historical info-level lines (2 generations observed post-switch) are untouched by design; disposal is an operator decision under the credential-handling policy.
