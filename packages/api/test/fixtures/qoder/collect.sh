#!/usr/bin/env bash
# F317 qoder golden fixtures 确定性采集脚本（红绿可复现）
# 用法: QODER_BIN=~/.local/bin/qodercn QODER_CONFIG_DIR=~/.qoder-cn OUT_DIR=. ./collect.sh
# 注意: 每次调用消耗 qoder credits；除 auth-error 外均需已登录的 QODER_CONFIG_DIR。
set -uo pipefail
QODER_BIN="${QODER_BIN:-$HOME/.local/bin/qodercn}"
CFG="${QODER_CONFIG_DIR:-$HOME/.qoder-cn}"
OUT="${OUT_DIR:-.}"
SAN() { sed -e "s#$HOME#~#g" -e 's#/private/tmp#/tmp#g'; }

run() { name=$1; shift; echo "== $name"; "$@" 2>"$OUT/.$name.stderr" | SAN > "$OUT/$name.jsonl"; echo "exit=$?" > "$OUT/.$name.exit"; SAN < "$OUT/.$name.stderr" > "$OUT/.$name.stderr.txt"; }

# ---- fixture: success（deny-all MCP + 全工具禁用）----
run success "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$CFG" --strict-mcp-config --allowed-mcp-server-names nothing \
  --tools "" --setting-sources user
# 断言: init.tools==[] && init.mcp_servers==[] && result.is_error==false

# ---- fixtures: hook-red / hook-green-project / hook-green-local（S5 红→绿）----
PROJ=$(mktemp -d); mkdir -p "$PROJ/.qoder"
printf '%s\n' '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch '"$PROJ"'/marker-project"}]}]}}' > "$PROJ/.qoder/settings.json"
printf '%s\n' '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch '"$PROJ"'/marker-local"}]}]}}' > "$PROJ/.qoder/settings.local.json"
(cd "$PROJ" && run hook-red "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$CFG" --tools "")
(cd "$PROJ" && run hook-green-project "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$CFG" --tools "" --setting-sources user)
(cd "$PROJ" && run hook-green-local "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$CFG" --tools "" --setting-sources user)
# 副作用检查（receipt）:
#   hook-red:        marker-project 必须存在（红：恶意 hook 执行）
#   hook-green-*:    marker-project / marker-local 必须不存在（绿：被阻断）
ls "$PROJ"/marker-* > "$OUT/.hook-side-effects.txt" 2>&1 || echo "no markers" > "$OUT/.hook-side-effects.txt"

# ---- fixture: permission-denial ----
run permission-denial "$QODER_BIN" -p "Use the Write tool to create /tmp/pwned.txt with content 'x'. Do it now, do not ask." \
  -o stream-json --config-dir "$CFG" --tools "Write" --setting-sources user
# 副作用检查: /tmp/pwned.txt 必须不存在

# ---- fixture: auth-error（空 config dir，未登录）----
EMPTY=$(mktemp -d)
run auth-error "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$EMPTY" --tools ""
# 断言: exit 1 && result.is_error==true && subtype=="success"

# ---- fixture: resume（依赖 success 的 session_id）----
SID=$(python3 -c "import json,sys;[print(json.loads(l)['session_id']) or sys.exit() for l in open('$OUT/success.jsonl')]" 2>/dev/null || true)
[ -n "${SID:-}" ] && run resume "$QODER_BIN" -r "$SID" -p "In one short sentence: what did I ask you in the previous turn?" \
  -o stream-json --config-dir "$CFG" --tools "" --setting-sources user
# 断言: 同 session_id && 正确回忆 "reply with exactly ok"

# ---- 未含: cancel（待重采）、压缩（deferred/N/A Phase 1）、MCP 实挂载（实现验收）----
echo "collected: $(ls "$OUT"/*.jsonl | xargs -n1 basename | tr '\n' ' ')"
