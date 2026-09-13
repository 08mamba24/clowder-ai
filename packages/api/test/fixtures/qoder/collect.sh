#!/usr/bin/env bash
# F317 qoder golden fixtures 确定性采集脚本（gate probe；会消耗 qoder credits）
# 红绿断言失败即非零退出；全部通过后才把脱敏 fixture 原子发布到 DEST。
# 用法: QODER_BIN=~/.local/bin/qodercn QODER_CONFIG_DIR=~/.qoder-cn DEST=<repo>/packages/api/test/fixtures/qoder ./collect.sh
set -euo pipefail

QODER_BIN="${QODER_BIN:-$HOME/.local/bin/qodercn}"
CFG="${QODER_CONFIG_DIR:-$HOME/.qoder-cn}"
DEST="${DEST:-$(cd "$(dirname "$0")" && pwd)}"

RAW=$(mktemp -d /tmp/qoder-collect.XXXXXX)   # repo 外原始工件
STAGE=$(mktemp -d /tmp/qoder-stage.XXXXXX)   # 脱敏后、发布前
trap 'rm -rf "$RAW" "$STAGE"' EXIT

# 受支持 fixture 的显式登记表（缺一即失败，防止 stale/假完整）
EXPECT="success tool-use permission-denial auth-error silent-model-fallback resume hook-red hook-green-project hook-green-local"

fail() { echo "ASSERTION FAIL: $*" >&2; exit 1; }

# 运行一个场景：stdout/stderr/exit 全部落 RAW（repo 外），stdout 脱敏后进 STAGE
run() {
  local name=$1; shift
  ( cd "${SCENARIO_CWD:-$RAW}" && "$@" ) >"$RAW/$name.out" 2>"$RAW/$name.err"
  echo $? >"$RAW/$name.exit"
  sanitize <"$RAW/$name.out" >"$STAGE/$name.jsonl"
  sanitize <"$RAW/$name.err" >"$STAGE/$name.stderr.txt"
  cp "$RAW/$name.exit" "$STAGE/$name.exit"
}

sanitize() {
  sed -e "s#$HOME#~#g" -e 's#/private/tmp#/tmp#g' -e "s#$RAW#/tmp/qoder-collect.XXXXXX#g"
}

# fail-closed 敏感扫描：脱敏输出中出现疑似凭证/HOME 原文即中止
scan() {
  local f=$1
  grep -qE "$HOME|sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9._-]{8,}" "$f" && fail "sensitive content in $f"
  return 0
}

# JSONL 事件断言助手
jassert() { python3 - "$@" <<'PY'
import json,sys
fixture, checks = sys.argv[1], sys.argv[2:]
rows=[json.loads(l) for l in open(f"{fixture}.jsonl") if l.strip()]
env={"rows":rows,"init":next((r for r in rows if r.get("subtype")=="init"),None),
     "result":next((r for r in rows if r and r.get("type")=="result" and rows[-1] is r or r.get("type")=="result"),None)}
env["result"]=[r for r in rows if r.get("type")=="result"][-1]
for c in checks:
    try:
        ok=eval(c, {"__builtins__":{}}, env)
    except Exception as e:
        print(f"{fixture}: check error {c}: {e}"); sys.exit(1)
    if not ok: print(f"{fixture}: FAILED {c}"); sys.exit(1)
print(f"{fixture}: ok")
PY
}

# ---- fixture: success ----
SCENARIO_CWD=$RAW
run success "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$CFG" --strict-mcp-config --allowed-mcp-server-names nothing \
  --tools "" --setting-sources user
jassert success \
  'init is not None' 'init.get("tools")==[]' 'init.get("mcp_servers")==[]' \
  'result.get("is_error") is False' 'rows[0].get("subtype")=="hook_started"' \
  'any(r.get("subtype")=="init" for r in rows)'

# ---- fixture: tool-use ----
run tool-use "$QODER_BIN" -p "Read the file /etc/hosts and reply with its first line only." \
  -o stream-json --config-dir "$CFG" --tools "Read" --setting-sources user
jassert tool-use \
  'any(b.get("type")=="tool_use" for r in rows if r.get("type")=="assistant" for b in r.get("message",{}).get("content",[]))' \
  'any(r.get("type")=="user" for r in rows)' 'result.get("is_error") is False'

# ---- fixture: permission-denial（目标文件在独立临时路径，避免与预存/并发冲突）----
PWNED="$RAW/pwned-$$.txt"; rm -f "$PWNED"
run permission-denial "$QODER_BIN" -p "Use the Write tool to create $PWNED with content 'x'. Do it now, do not ask." \
  -o stream-json --config-dir "$CFG" --tools "Write" --setting-sources user
[ ! -e "$PWNED" ] || fail "permission-denial: target file was written"
jassert permission-denial \
  'any(b.get("is_error") for r in rows if r.get("type")=="user" for b in (r.get("message",{}).get("content") or []))' \
  'result.get("is_error") is False'

# ---- fixture: auth-error（空 config dir，未登录）----
EMPTY=$(mktemp -d "$RAW/empty.XXXXXX")
run auth-error "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$EMPTY" --tools ""
[ "$(cat "$STAGE/auth-error.exit")" = "1" ] || fail "auth-error: expected exit 1"
jassert auth-error 'result.get("is_error") is True' 'result.get("subtype")=="success"'

# ---- fixture: silent-model-fallback ----
run silent-model-fallback "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$CFG" -m definitely-not-a-model-xyz --tools "" --setting-sources user
jassert silent-model-fallback 'init.get("model")=="Auto"' 'result.get("is_error") is False'

# ---- fixture: resume（依赖 success 的 session_id）----
SID=$(python3 -c "import json;print(next(json.loads(l)['session_id'] for l in open('$STAGE/success.jsonl') if l.strip()))")
run resume "$QODER_BIN" -r "$SID" -p "In one short sentence: what did I ask you in the previous turn?" \
  -o stream-json --config-dir "$CFG" --tools "" --setting-sources user
jassert resume 'result.get("session_id")=="'"$SID"'"' 'result.get("is_error") is False'

# ---- fixtures: S5 hook 红→绿（每场景独立 project，marker 各自独立）----
mkproj() { local d; d=$(mktemp -d "$RAW/proj.XXXXXX"); mkdir -p "$d/.qoder"; echo "$d"; }

P1=$(mkproj); echo '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch '"$P1"'/marker"}]}]}}' > "$P1/.qoder/settings.json"
SCENARIO_CWD=$P1
run hook-red "$QODER_BIN" -p "reply with exactly: ok" -o stream-json --config-dir "$CFG" --tools ""
[ -e "$P1/marker" ] || fail "hook-red: malicious hook did NOT run (expected red)"
jassert hook-red 'any("hook_started"==r.get("subtype") and "marker" in str(r.get("hook_name","")) for r in rows)'

P2=$(mkproj); echo '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch '"$P2"'/marker"}]}]}}' > "$P2/.qoder/settings.json"
SCENARIO_CWD=$P2
run hook-green-project "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$CFG" --tools "" --setting-sources user
[ ! -e "$P2/marker" ] || fail "hook-green-project: marker exists (block failed)"
jassert hook-green-project 'not any("marker" in str(r.get("hook_name","")) for r in rows if r.get("subtype")=="hook_started")'

P3=$(mkproj); echo '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch '"$P3"'/marker"}]}]}}' > "$P3/.qoder/settings.local.json"
SCENARIO_CWD=$P3
run hook-green-local "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$CFG" --tools "" --setting-sources user
[ ! -e "$P3/marker" ] || fail "hook-green-local: marker exists (block failed)"
jassert hook-green-local 'not any("marker" in str(r.get("hook_name","")) for r in rows if r.get("subtype")=="hook_started")'

# ---- 发布前：敏感扫描 + 显式完整性 ----
for f in "$STAGE"/*; do scan "$f"; done
for name in $EXPECT; do [ -f "$STAGE/$name.jsonl" ] || fail "missing fixture $name"; done
ACTUAL=$(ls "$STAGE"/*.jsonl | xargs -n1 basename | sed 's/\.jsonl//' | sort)
[ "$(echo "$ACTUAL")" = "$(echo $EXPECT | tr ' ' '\n' | sort)" ] || fail "stale/extra fixtures in staging: $ACTUAL"

# ---- 原子发布 + 结构化 receipt ----
for name in $EXPECT; do
  for suf in jsonl stderr.txt exit; do cp "$STAGE/$name.$suf" "$DEST/$name.$suf"; done
done
python3 - "$STAGE" "$EXPECT" > "$DEST/receipts.json" <<'PY'
import json,sys
stage,expect=sys.argv[1],sys.argv[2].split()
print(json.dumps({n:{"exit":open(f"{stage}/{n}.exit").read().strip()} for n in expect},indent=2))
PY
echo "published: $EXPECT"
