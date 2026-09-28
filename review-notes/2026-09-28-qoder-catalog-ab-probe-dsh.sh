#!/usr/bin/env bash
# ③ retargeted: one-variable A/B on the model-catalog cache freshness.
#
# Hypothesis (from the 111-run log scan): the pre-prompt window is the CLI's blocking
# catalog/endpoint network gate, armed only when the on-disk model catalog is stale
# (empirical TTL boundary: fresh <=92s, stale >=101s). Manipulate ONLY the catalog mtime
# in a throwaway copy of the profile and measure `SessionStart hook end -> input.prompt.received`.
#
# Touches nothing live: copies a profile to /tmp, runs the vendor CLI there, deletes the copy.
set -euo pipefail
SRC=/Users/yuhan/cat-cafe/clowder-ai/.cat-cafe/qoder-profiles/qoder-flash
CLI=/opt/homebrew/bin/qoderclicn
CWD=/Users/yuhan/cat-cafe/clowder-ai
PROMPT='回复两个字：收到'

run_case() {
  local name="$1" age_spec="$2"
  local dir="/tmp/qoder-catalog-probe-$name"
  rm -rf "$dir"; mkdir -p "$dir"
  cp -R "$SRC/." "$dir/"
  local cat
  cat=$(ls "$dir"/.models/*/catalog-v6 2>/dev/null | head -1) || true
  [ -n "$cat" ] && touch -t "$age_spec" "$cat"
  echo "== case=$name catalog_mtime=$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S' "$cat" 2>/dev/null)"
  printf '%s' "$PROMPT" | (cd "$CWD" && "$CLI" -p - -m Qwen3.8-Flash -o stream-json \
      --config-dir "$dir" --strict-mcp-config --allowed-mcp-server-names nothing \
      --tools '' --setting-sources user) >"$dir/stdout.json" 2>"$dir/stderr.txt" || echo "   (cli exit $?)"
  local rd
  rd=$(ls -dt "$dir"/logs/runs/*/ 2>/dev/null | head -1)
  echo "   run_dir=$rd"
  python3 - "$rd" "$name" <<'PY'
import re,sys,datetime as dt,os,json
rd,name=sys.argv[1],sys.argv[2]
log=os.path.join(rd,'qodercli.log')
TS=re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00)")
ms=lambda s:int(dt.datetime.fromisoformat(s).timestamp()*1000)
t0=ss=recv=ready=None;catline=None;trans=None
for line in open(log,errors='replace'):
    m=TS.match(line)
    if not m: continue
    t=ms(m.group(1))
    if 'process.started' in line: t0=t
    elif 'phase="qoder_runtime.ready"' in line and 'finished' in line: ready=t
    elif 'hook.finished' in line and 'SessionStart' in line and (recv is None or t<=recv): ss=t
    elif 'input.prompt.received' in line and recv is None: recv=t
    elif 'Inference transport ready' in line and trans is None: trans=t
    elif 'disk cache' in line and catline is None: catline=line.split('[catalog]')[-1].strip()[:90]
g=lambda v: '' if v is None else f'{(v-t0)/1000:.1f}s'
print(f"   RESULT[{name}] ready={g(ready)} ss_end={g(ss)} window={(recv-ss)/1000 if recv and ss else float('nan'):.1f}s "
      f"init={g(recv)} transport_ready={g(trans)}")
print(f"   catalog_line: {catline}")
print(f"   argv_r: {'-r' in json.load(open(os.path.join(rd,'manifest.json')))['argv']} | resume_line: " +
      next((l.split('parsed')[-1].strip()[:60] for l in open(log,errors='replace') if 'cli.arguments.parsed' in l),'?'))
PY
  rm -rf "$dir"
}

# fresh: mtime = now (within the <=92s fresh band)
run_case fresh "$(date +%Y%m%d%H%M.%S)"
# stale: mtime = 3 hours ago (well past the >=101s stale boundary)
run_case stale "$(date -v-3H +%Y%m%d%H%M.%S)"
