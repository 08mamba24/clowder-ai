#!/usr/bin/env bash
# collect.sh 无额度合成回归（stub provider，不调用真实 qodercn、不消耗 credits）
# 覆盖: 正向全链路（9 fixture 断言 + generation 发布）/ 负向（断言失败、脏 profile、缺 profile）
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d /tmp/qoder-selftest.XXXXXX); trap 'rm -rf "$WORK"' EXIT
STUB="$WORK/qodercn"; PROF="$WORK/profile"; DEST="$WORK/dest"
mkdir -p "$PROF/.auth" "$DEST"; touch "$PROF/.auth/user"

emit() { echo "$1"; }
SID="11111111-2222-3333-4444-555555555555"
cat > "$STUB" <<STUBEOF
#!/usr/bin/env bash
args="\$*"
SID="$SID"
CFGDIR=\$(echo "\$args" | grep -oE 'config-dir [^ ]+' | awk '{print \$2}')
if [ ! -e "\$CFGDIR/.auth/user" ]; then
  echo '{"type":"system","subtype":"init","tools":[],"mcp_servers":[],"model":"auto","permissionMode":"default","session_id":"'\$SID'"}'
  echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in","session_id":"'\$SID'"}'
  exit 1
fi
if ! echo "\$args" | grep -q 'setting-sources user'; then
  for f in .qoder/settings.json .qoder/settings.local.json; do
    if [ -f "\$f" ] && grep -q touch "\$f"; then
      MARK=\$(grep -oE 'touch [^"]+' "\$f" | awk '{print \$2}')
      echo '{"type":"system","subtype":"hook_started","hook_name":"touch marker-file","session_id":"'\$SID'"}'
      touch "\$MARK"
    fi
  done
fi
echo '{"type":"system","subtype":"hook_started","hook_name":"builtin","session_id":"'\$SID'"}'
echo '{"type":"system","subtype":"init","tools":[],"mcp_servers":[],"model":"Auto","permissionMode":"default","session_id":"'\$SID'"}'
if echo "\$args" | grep -q ' -r '; then
  echo '{"type":"result","subtype":"success","is_error":false,"result":"You asked me to reply with exactly ok.","session_id":"'\$SID'"}'
elif echo "\$args" | grep -q 'tool-input.txt'; then
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c1","name":"Read","input":{"file_path":"/tmp/x/tool-input.txt"}}]},"session_id":"'\$SID'"}'
  echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c1","content":"F317-DETERMINISTIC-LINE-1"}]},"session_id":"'\$SID'"}'
  echo '{"type":"result","subtype":"success","is_error":false,"result":"F317-DETERMINISTIC-LINE-1","session_id":"'\$SID'"}'
elif echo "\$args" | grep -q 'pwned-'; then
  echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c2","content":"Error: Allow writing?","is_error":true}]},"session_id":"'\$SID'"}'
  echo '{"type":"result","subtype":"success","is_error":false,"permission_denials":[],"result":"denied","session_id":"'\$SID'"}'
else
  echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"'\$SID'"}'
fi
STUBEOF
chmod +x "$STUB"

echo "== positive: full pipeline"
QODER_BIN="$STUB" QODER_PROFILE_DIR="$PROF" DEST="$DEST" bash "$HERE/collect.sh" >/dev/null
python3 -c "import json;g=json.load(open('$DEST/current/generation.json'));assert len(g['artifacts'])==9, 'not 9 artifacts';assert g['side_effects']"
echo "positive ok (9 artifacts + side-effect receipts + generation pointer)"

echo "== negative: assertion failure aborts"
BAD="$WORK/qodercn-bad"; sed 's/"result":"ok"/"result":"nope"/' "$STUB" > "$BAD"; chmod +x "$BAD"
set +e
QODER_BIN="$BAD" QODER_PROFILE_DIR="$PROF" DEST="$DEST" bash "$HERE/collect.sh" >/dev/null 2>&1; rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: bad output not rejected"; exit 1; }
echo "negative-assert ok (exit $rc)"

echo "== negative: dirty profile rejected"
DIRTY="$WORK/dirty-profile"; mkdir -p "$DIRTY"; echo '{}' > "$DIRTY/settings.json"
set +e
QODER_BIN="$STUB" QODER_PROFILE_DIR="$DIRTY" DEST="$DEST" bash "$HERE/collect.sh" >/dev/null 2>&1; rc=$?
set -e
[ "$rc" -eq 2 ] || { echo "FAIL: dirty profile accepted"; exit 1; }
echo "negative-dirty-profile ok (exit $rc)"

echo "== negative: missing profile rejected"
set +e
env -u QODER_PROFILE_DIR QODER_BIN="$STUB" DEST="$DEST" bash "$HERE/collect.sh" >/dev/null 2>&1; rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: missing profile accepted"; exit 1; }
echo "negative-missing-profile ok (exit $rc)"

echo "selftest PASS"
