#!/usr/bin/env bash
# F317 qoder golden fixtures 确定性采集脚本（L1 gate probe；会消耗 qoder credits）
# 硬前置：离线构建的干净 auth-only profile（QODER_PROFILE_DIR，含登录凭证、无 user settings/hooks/plugins）。
#   不接受默认回退到个人 ~/.qoder-cn —— 未显式传入即拒绝执行。
# 所有场景统一 strict deny-all MCP；逐场景断言精确 init.tools / init.mcp_servers（多余工具/服务器 = 红）。
# 全部断言通过后：唯一 temp 构建 → 校验 → 单 rename 发布整代 generation（含 stdout/stderr/exit/
#   assertion/side-effect 全量 sha256），current 指针以 temp+rename 切换；读方用 verify.py fail-closed 验证。
# 用法: QODER_BIN=~/.local/bin/qodercn QODER_PROFILE_DIR=<clean-profile> DEST=<repo>/packages/api/test/fixtures/qoder ./collect.sh
set -euo pipefail

QODER_BIN="${QODER_BIN:?QODER_BIN required}"
PROFILE="${QODER_PROFILE_DIR:?QODER_PROFILE_DIR required (clean auth-only profile; no fallback to personal config)}"
DEST="${DEST:-$(cd "$(dirname "$0")" && pwd)}"
mkdir -p "$DEST"; [ -w "$DEST" ] || { echo "DEST not writable: $DEST" >&2; exit 2; }
[ -d "$PROFILE" ] || { echo "profile dir not found: $PROFILE" >&2; exit 2; }
for banned in settings.json settings.local.json hooks plugins; do
  [ ! -e "$PROFILE/$banned" ] || { echo "profile not clean: contains $banned" >&2; exit 2; }
done

RAW=$(mktemp -d /tmp/qoder-collect.XXXXXX)
STAGE=$(mktemp -d /tmp/qoder-stage.XXXXXX)
trap 'rm -rf "$RAW" "$STAGE"' EXIT

EXPECT="success tool-use permission-denial auth-error silent-model-fallback resume hook-red hook-green-project hook-green-local"
SANRAW="/tmp/qoder-collect.XXXXXX"   # sanitize() 对 RAW 的投影
DENY_MCP=(--strict-mcp-config --allowed-mcp-server-names nothing)

fail() { echo "ASSERTION FAIL: $*" >&2; exit 1; }

# 运行一个场景：stdout/stderr/exit 全部落 RAW；预期退出码显式断言（条件捕获，set -e 安全）
run() {
  local name=$1 expect_exit=$2; shift 2
  local rc=0
  ( cd "${SCENARIO_CWD:-$RAW}" && "$@" ) >"$RAW/$name.out" 2>"$RAW/$name.err" || rc=$?
  echo "$rc" >"$RAW/$name.exit"
  [ "$rc" = "$expect_exit" ] || fail "$name: exit $rc, expected $expect_exit"
  sanitize <"$RAW/$name.out" >"$STAGE/$name.jsonl"
  sanitize <"$RAW/$name.err" >"$STAGE/$name.stderr.txt"
  cp "$RAW/$name.exit" "$STAGE/$name.exit"
}

sanitize() {
  sed -e "s#$HOME#~#g" -e 's#/private/tmp#/tmp#g' -e "s#$RAW#$SANRAW#g" -e "s#$PROFILE#<profile>#g"
}

# fail-closed 敏感扫描：HOME/PROFILE 原文、常见凭证形态、私钥、IP
scan() {
  local f=$1
  ! grep -qE "$HOME|$PROFILE|sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9._-]{8,}|(api[_-]?key|secret|token|password|cookie)['\"]?\s*[:=]|[A-Za-z0-9+/]{40,}={0,2}|-----BEGIN [A-Z ]*PRIVATE KEY-----|([0-9]{1,3}\.){3}[0-9]{1,3}" "$f" \
    || fail "sensitive content in $(basename "$f")"
}

# JSONL 语义断言：只读 $STAGE/<name>.jsonl；每条断言 + 结果写入 $STAGE/<name>.assert（进 generation hash）
jassert() {
  local name=$1; shift
  STAGE_DIR="$STAGE" FIXTURE="$name" python3 - "$@" >"$STAGE/$name.assert" <<'PY' || { cat "$STAGE/$name.assert" >&2; exit 1; }
import json,sys,os
rows=[json.loads(l) for l in open(f"{os.environ['STAGE_DIR']}/{os.environ['FIXTURE']}.jsonl") if l.strip()]
name=os.environ['FIXTURE']
env={"rows":rows,
     "init":next((r for r in rows if r.get("subtype")=="init"),None),
     "result":[r for r in rows if r.get("type")=="result"][-1] if any(r.get("type")=="result" for r in rows) else None,
     "assistant":[r for r in rows if r.get("type")=="assistant"],
     "toolfile":os.environ.get("TOOLFILE",""), "pwned":os.environ.get("PWNEDPATH","")}
for c in sys.argv[1:]:
    ok=False
    try: ok=eval(c, {"__builtins__":{},"any":any,"all":all,"str":str,"int":int,"len":len,"sorted":sorted,"True":True,"False":False,"None":None, **env})
    except Exception as e: print(f"{name}: check error {c}: {e}"); sys.exit(1)
    if ok is not True: print(f"{name}: FAILED {c}"); sys.exit(1)
print(f"{name}: ok")
PY
  echo "expressions:" >> "$STAGE/$name.assert"
  printf '%s\n' "$@" >> "$STAGE/$name.assert"
}

# ---- fixture: success（空工具 + deny-all MCP）----
SCENARIO_CWD=$RAW
TOOLFILE="" PWNEDPATH=""
run success 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$PROFILE" "${DENY_MCP[@]}" --tools "" --setting-sources user
jassert success \
  'init is not None' 'sorted(init.get("tools") or [])==[]' 'init.get("mcp_servers")==[]' \
  'init.get("permissionMode")=="default"' 'init.get("model")=="Auto"' \
  'result.get("result")=="ok"' 'result.get("is_error") is False' \
  'rows[0].get("subtype")=="hook_started"'

# ---- fixture: tool-use（确定性输入文件；仅 Read 工具；路径全等）----
TOOLFILE="$RAW/tool-input.txt"; printf 'F317-DETERMINISTIC-LINE-1\n' > "$TOOLFILE"
export TOOLFILE_SANITIZED="$(printf '%s' "$TOOLFILE" | sanitize)"
run tool-use 0 "$QODER_BIN" -p "Read the file $TOOLFILE and reply with its exact content." \
  -o stream-json --config-dir "$PROFILE" "${DENY_MCP[@]}" --tools "Read" --setting-sources user
export TOOLFILE="$TOOLFILE_SANITIZED"
jassert tool-use \
  'sorted(init.get("tools") or [])==["Read"]' 'init.get("mcp_servers")==[]' \
  'any(b.get("type")=="tool_use" and b.get("name")=="Read" and b.get("input",{}).get("file_path")==toolfile for r in assistant for b in r.get("message",{}).get("content",[]))' \
  'any(b.get("type")=="tool_result" and str(b.get("content")).strip()=="F317-DETERMINISTIC-LINE-1" for r in rows if r.get("type")=="user" for b in (r.get("message",{}).get("content") or []))' \
  'result.get("is_error") is False'
unset TOOLFILE

# ---- fixture: permission-denial（唯一临时目标；仅 Write 工具；路径全等）----
PWNED="$RAW/pwned.txt"; rm -f "$PWNED"
export PWNEDPATH_SANITIZED="$(printf '%s' "$PWNED" | sanitize)"
run permission-denial 0 "$QODER_BIN" -p "Use the Write tool to create $PWNED with content 'x'. Do it now, do not ask." \
  -o stream-json --config-dir "$PROFILE" "${DENY_MCP[@]}" --tools "Write" --setting-sources user
[ ! -e "$PWNED" ] || fail "permission-denial: target file was written"
echo "target_absent=true" > "$STAGE/permission-denial.side-effect"
export PWNEDPATH="$PWNEDPATH_SANITIZED"
jassert permission-denial \
  'sorted(init.get("tools") or [])==["Write"]' 'init.get("mcp_servers")==[]' \
  'any(b.get("type")=="tool_use" and b.get("name")=="Write" and b.get("input",{}).get("file_path")==pwned for r in assistant for b in r.get("message",{}).get("content",[]))' \
  'any(b.get("is_error") for r in rows if r.get("type")=="user" for b in (r.get("message",{}).get("content") or []))' \
  'result.get("is_error") is False'
unset PWNEDPATH

# ---- fixture: auth-error（空 config dir，预期 exit 1）----
EMPTY=$(mktemp -d "$RAW/empty.XXXXXX")
run auth-error 1 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$EMPTY" "${DENY_MCP[@]}" --tools ""
jassert auth-error 'result.get("is_error") is True' 'result.get("subtype")=="success"' 'init.get("mcp_servers")==[]'

# ---- fixture: silent-model-fallback（空工具）----
run silent-model-fallback 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$PROFILE" "${DENY_MCP[@]}" -m definitely-not-a-model-xyz --tools "" --setting-sources user
jassert silent-model-fallback 'sorted(init.get("tools") or [])==[]' 'init.get("mcp_servers")==[]' \
  'init.get("model")=="Auto"' 'result.get("is_error") is False'

# ---- fixture: resume（空工具；断言精确回忆）----
SID=$(python3 -c "import json;print(next(json.loads(l)['session_id'] for l in open('$STAGE/success.jsonl') if l.strip()))")
run resume 0 "$QODER_BIN" -r "$SID" -p "In one short sentence: what did I ask you in the previous turn?" \
  -o stream-json --config-dir "$PROFILE" "${DENY_MCP[@]}" --tools "" --setting-sources user
jassert resume 'sorted(init.get("tools") or [])==[]' 'init.get("mcp_servers")==[]' \
  'result.get("session_id")=="'"$SID"'"' 'result.get("is_error") is False' \
  'str(result.get("result","")).lower().find("reply with exactly")!=-1 and "ok" in str(result.get("result","")).lower()'

# ---- fixtures: S5 hook 红→绿（独立 project/marker；空工具 + deny-all MCP）----
mkproj() { local d; d=$(mktemp -d "$RAW/proj.XXXXXX"); mkdir -p "$d/.qoder"; echo "$d"; }

P1D=$(mkproj); echo '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch '"$P1D"'/marker"}]}]}}' > "$P1D/.qoder/settings.json"
SCENARIO_CWD=$P1D
run hook-red 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json --config-dir "$PROFILE" "${DENY_MCP[@]}" --tools ""
[ -e "$P1D/marker" ] || fail "hook-red: malicious hook did NOT run (expected red)"
echo "marker_present=true" > "$STAGE/hook-red.side-effect"
jassert hook-red 'sorted(init.get("tools") or [])==[]' 'init.get("mcp_servers")==[]' \
  'any(r.get("subtype")=="hook_started" and "marker" in str(r.get("hook_name","")) for r in rows)'

P2D=$(mkproj); echo '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch '"$P2D"'/marker"}]}]}}' > "$P2D/.qoder/settings.json"
SCENARIO_CWD=$P2D
run hook-green-project 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$PROFILE" "${DENY_MCP[@]}" --tools "" --setting-sources user
[ ! -e "$P2D/marker" ] || fail "hook-green-project: marker exists (block failed)"
echo "marker_absent=true" > "$STAGE/hook-green-project.side-effect"
jassert hook-green-project 'sorted(init.get("tools") or [])==[]' 'init.get("mcp_servers")==[]' \
  'not any("marker" in str(r.get("hook_name","")) for r in rows if r.get("subtype")=="hook_started")'

P3D=$(mkproj); echo '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch '"$P3D"'/marker"}]}]}}' > "$P3D/.qoder/settings.local.json"
SCENARIO_CWD=$P3D
run hook-green-local 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$PROFILE" "${DENY_MCP[@]}" --tools "" --setting-sources user
[ ! -e "$P3D/marker" ] || fail "hook-green-local: marker exists (block failed)"
echo "marker_absent=true" > "$STAGE/hook-green-local.side-effect"
jassert hook-green-local 'sorted(init.get("tools") or [])==[]' 'init.get("mcp_servers")==[]' \
  'not any("marker" in str(r.get("hook_name","")) for r in rows if r.get("subtype")=="hook_started")'

# ---- 发布前：敏感扫描 + 完整性 + generation manifest（stdout/stderr/exit/assert/side-effect 全量 sha256）----
for f in "$STAGE"/*; do scan "$f"; done
for name in $EXPECT; do
  for suf in jsonl stderr.txt exit assert; do [ -f "$STAGE/$name.$suf" ] || fail "missing artifact $name.$suf"; done
done
ACTUAL=$(cd "$STAGE" && ls *.jsonl | sed 's/\.jsonl//' | sort)
[ "$ACTUAL" = "$(echo $EXPECT | tr ' ' '\n' | sort)" ] || fail "stale/extra fixtures in staging: $ACTUAL"

python3 - "$STAGE" "$EXPECT" > "$STAGE/generation.json" <<'PY'
import json,sys,hashlib,glob,os
stage,expect=sys.argv[1],sys.argv[2].split()
def sha(p): return hashlib.sha256(open(p,'rb').read()).hexdigest()
artifacts={}
for n in expect:
    artifacts[n]={s:sha(f"{stage}/{n}.{s}") for s in ("jsonl","stderr.txt","exit","assert")}
side_effects={os.path.basename(p):sha(p) for p in sorted(glob.glob(f"{stage}/*.side-effect"))}
print(json.dumps({"schema":"qoder-f317-generation/2","collector":"collect.sh","expect":expect,
  "artifacts":artifacts,"side_effects":side_effects},indent=2))
PY

# ---- 原子发布：唯一 temp 构建 → 已有同代只校验复用 → 单 rename 提交 → temp symlink + mv 切 current ----
GENHASH=$(python3 -c "import hashlib;print(hashlib.sha256(open('$STAGE/generation.json','rb').read()).hexdigest()[:12])")
GENID=".gen-$GENHASH"
if [ -e "$DEST/$GENID" ]; then
  # 同代重跑：绝不删除已有 generation；校验内容一致后仅切指针
  diff -r "$STAGE" "$DEST/$GENID" >/dev/null || fail "same generation hash but content differs"
else
  TMPGEN="$DEST/.tmpgen.$$"
  rm -rf "$TMPGEN"; cp -R "$STAGE" "$TMPGEN"
  mv "$TMPGEN" "$DEST/$GENID"   # 单 rename 提交
fi
TMPLINK="$DEST/.current.$$"; rm -f "$TMPLINK"
ln -s "$GENID" "$TMPLINK" && python3 -c "import os; os.replace('$TMPLINK', '$DEST/current')"   # rename(2)，不跟随旧 symlink
echo "published generation $GENHASH: $EXPECT"
