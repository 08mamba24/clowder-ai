#!/usr/bin/env bash
# collect.sh 无额度合成回归（stub provider，不调用真实 qodercn、不消耗 credits）
# 正向: 9 fixture 断言 + generation 发布 + verify.py 全量 hash 校验
# 负向: 断言失败 / 脏 profile / 缺 profile / 多余工具 / 错误路径 / 同代重跑不悬空 / 篡改检出
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d /tmp/qoder-selftest.XXXXXX); trap 'rm -rf "$WORK"' EXIT
STUB="$WORK/qodercn"; PROF="$WORK/profile"; DEST="$WORK/dest"
mkdir -p "$PROF/.auth" "$DEST"; touch "$PROF/.auth/user"

cat > "$STUB" <<STUBEOF
#!/usr/bin/env bash
args="\$*"
SID="11111111-2222-3333-4444-555555555555"
CFGDIR=\$(echo "\$args" | grep -oE 'config-dir [^ ]+' | awk '{print \$2}')
if [ ! -e "\$CFGDIR/.auth/user" ]; then
  echo '{"type":"system","subtype":"init","tools":[],"mcp_servers":[],"model":"auto","permissionMode":"default","session_id":"'\$SID'"}'
  echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in","session_id":"'\$SID'"}'
  exit 1
fi
# init.tools 忠实反映 --tools 参数（空串→[]，Read→["Read"]，Write→["Write"]）
TOOLS=\$(echo "\$args" | grep -oE -- '--tools [^ ]+' | awk '{print \$2}')
case "\$TOOLS" in
  ''|'""') TJ="[]" ;;
  Read)  TJ='["Read"]' ;;
  Write) TJ='["Write"]' ;;
  *)     TJ='["Bash","Write","WebFetch"]' ;;
esac
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
echo '{"type":"system","subtype":"init","tools":'\$TJ',"mcp_servers":[],"model":"Auto","permissionMode":"default","session_id":"'\$SID'"}'
if echo "\$args" | grep -qE '(^| )-r '; then
  echo '{"type":"result","subtype":"success","is_error":false,"result":"You asked me to reply with exactly ok.","session_id":"'\$SID'"}'
elif echo "\$args" | grep -q 'tool-input.txt'; then
  TF=\$(echo "\$args" | grep -oE '[^ ]*tool-input.txt' | head -1)
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c1","name":"Read","input":{"file_path":"'\$TF'"}}]},"session_id":"'\$SID'"}'
  echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c1","content":"F317-DETERMINISTIC-LINE-1"}]},"session_id":"'\$SID'"}'
  echo '{"type":"result","subtype":"success","is_error":false,"result":"F317-DETERMINISTIC-LINE-1","session_id":"'\$SID'"}'
elif echo "\$args" | grep -q pwned; then
  PF=\$(echo "\$args" | grep -oE '[^ ]*pwned[^ ]*' | sed "s/[.'\"]*$//" | head -1)
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c2","name":"Write","input":{"file_path":"'\$PF'"}}]},"session_id":"'\$SID'"}'
  echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c2","content":"Error: Allow writing?","is_error":true}]},"session_id":"'\$SID'"}'
  echo '{"type":"result","subtype":"success","is_error":false,"permission_denials":[],"result":"denied","session_id":"'\$SID'"}'
else
  echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"'\$SID'"}'
fi
STUBEOF
chmod +x "$STUB"

run_case() { QODER_BIN="$1" QODER_PROFILE_DIR="$PROF" DEST="$DEST" bash "$HERE/collect.sh"; }

echo "== positive: full pipeline + verifier"
run_case "$STUB" >/dev/null
python3 "$HERE/verify.py" "$DEST"
echo "positive ok"

echo "== positive: same-generation rerun keeps current readable"
CUR_BEFORE=$(readlink "$DEST/current")
run_case "$STUB" >/dev/null
CUR_AFTER=$(readlink "$DEST/current")
[ "$CUR_BEFORE" = "$CUR_AFTER" ] || { echo "FAIL: generation changed on identical rerun"; exit 1; }
python3 "$HERE/verify.py" "$DEST" >/dev/null
echo "rerun ok (same generation, verifier green)"

neg() { local label=$1 stub=$2; local rc=0
  local d="$WORK/dest-$label"; mkdir -p "$d"
  QODER_BIN="$stub" QODER_PROFILE_DIR="$PROF" DEST="$d" bash "$HERE/collect.sh" >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || { echo "FAIL: $label not rejected"; exit 1; }
  echo "$label ok (exit $rc)"; }

# 三个变异 stub：断言失败 / 多余工具面 / 错误路径（python 字面量替换，锚点必须唯一）
STUBF="$STUB" WORKD="$WORK" python3 <<'PY'
import os
s=open(os.environ['STUBF']).read()
muts={
 'bad1': ('"result":"ok"', '"result":"nope"'),
 'bad2': ('TJ=\'["Read"]\'', 'TJ=\'["Bash","Read"]\''),
 'bad3': ('"file_path":"\'$TF\'"', '"file_path":"/tmp/x/tool-input.txt"'),
}
for name,(old,new) in muts.items():
    assert s.count(old)==1, f"{name}: anchor x{s.count(old)}: {old!r}"
    p=os.path.join(os.environ['WORKD'], name)
    open(p,'w').write(s.replace(old,new))
    os.chmod(p, 0o755)
PY

echo "== negative: assertion failure (wrong success output)"
neg bad-output "$WORK/bad1"

echo "== negative: unexpected extra tool surface (tool-use exposes Bash)"
neg extra-tool "$WORK/bad2"

echo "== negative: wrong tool_use path (exact match enforced)"
neg wrong-path "$WORK/bad3"

echo "== negative: dirty profile rejected"
DIRTY="$WORK/dirty-profile"; mkdir -p "$DIRTY"; echo '{}' > "$DIRTY/settings.json"
rc=0; QODER_BIN="$STUB" QODER_PROFILE_DIR="$DIRTY" DEST="$DEST" bash "$HERE/collect.sh" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || { echo "FAIL: dirty profile accepted (exit $rc)"; exit 1; }
echo "dirty-profile ok (exit 2)"

echo "== negative: missing profile rejected"
rc=0; env -u QODER_PROFILE_DIR QODER_BIN="$STUB" DEST="$DEST" bash "$HERE/collect.sh" >/dev/null 2>&1 || rc=$?
[ "$rc" -ne 0 ] || { echo "FAIL: missing profile accepted"; exit 1; }
echo "missing-profile ok (exit $rc)"

echo "== negative: tampered artifact detected by verifier"
GEN=$(readlink "$DEST/current"); GENDIR="$DEST/$GEN"
printf 'tamper\n' >> "$GENDIR/success.jsonl"
rc=0; python3 "$HERE/verify.py" "$DEST" >/dev/null 2>&1 || rc=$?
[ "$rc" -ne 0 ] || { echo "FAIL: tamper not detected"; exit 1; }
git checkout -- /dev/null 2>/dev/null || true
echo "tamper-detect ok (exit $rc)"

echo "== negative: extra file in generation detected"
: > "$GENDIR/rogue.txt"
rc=0; python3 "$HERE/verify.py" "$DEST" >/dev/null 2>&1 || rc=$?
[ "$rc" -ne 0 ] || { echo "FAIL: extra file not detected"; exit 1; }
echo "extra-file ok (exit $rc)"

echo "selftest PASS"
