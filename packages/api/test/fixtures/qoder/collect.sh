#!/usr/bin/env bash
# F317 qoder golden fixtures 确定性采集脚本（L1 gate probe；会消耗 qoder credits）
# 硬前置：离线构建的干净 auth-only profile（QODER_PROFILE_DIR，含登录凭证、无 user settings/hooks/plugins）。
#   不接受默认回退到个人 ~/.qoder-cn —— 未显式传入即拒绝执行。
# 断言失败即非零退出；全部通过后以单一 rename 原子发布整代 fixture + generation manifest（sha256 全量）。
# 用法: QODER_BIN=~/.local/bin/qodercn QODER_PROFILE_DIR=<clean-profile> DEST=<repo>/packages/api/test/fixtures/qoder ./collect.sh
set -euo pipefail

QODER_BIN="${QODER_BIN:?QODER_BIN required}"
PROFILE="${QODER_PROFILE_DIR:?QODER_PROFILE_DIR required (clean auth-only profile; no fallback to personal config)}"
DEST="${DEST:-$(cd "$(dirname "$0")" && pwd)}"
[ -d "$PROFILE" ] || { echo "profile dir not found: $PROFILE" >&2; exit 2; }
# 干净 profile 硬校验：不得含 settings/hooks/plugins（auth-only）
for banned in settings.json settings.local.json hooks plugins; do
  [ ! -e "$PROFILE/$banned" ] || { echo "profile not clean: contains $banned" >&2; exit 2; }
done

RAW=$(mktemp -d /tmp/qoder-collect.XXXXXX)   # repo 外原始工件
STAGE=$(mktemp -d /tmp/qoder-stage.XXXXXX)   # 脱敏后、发布前
trap 'rm -rf "$RAW" "$STAGE"' EXIT

EXPECT="success tool-use permission-denial auth-error silent-model-fallback resume hook-red hook-green-project hook-green-local"

fail() { echo "ASSERTION FAIL: $*" >&2; exit 1; }

# 运行一个场景：stdout/stderr/exit 全部落 RAW；预期退出码作为第二参传入（默认 0）
# 命令替换/条件上下文捕获状态，set -e 不误伤预期非零退出
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
  sed -e "s#$HOME#~#g" -e 's#/private/tmp#/tmp#g' -e "s#$RAW#/tmp/qoder-collect.XXXXXX#g" -e "s#$PROFILE#<profile>#g"
}

# fail-closed 敏感扫描：HOME/PROFILE 原文、常见凭证形态、私钥、IP
scan() {
  local f=$1
  ! grep -qE "$HOME|$PROFILE|sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9._-]{8,}|(api[_-]?key|secret|token|password|cookie)['\"]?\s*[:=]|[A-Za-z0-9+/]{40,}={0,2}|-----BEGIN [A-Z ]*PRIVATE KEY-----|([0-9]{1,3}\.){3}[0-9]{1,3}" "$f" \
    || fail "sensitive content in $(basename "$f")"
}

# JSONL 语义断言：读 $STAGE/$name.jsonl；断言表达式受限白名单（any/all/str/int/len/sorted + env）
jassert() {
  local name=$1; shift
  STAGE_DIR="$STAGE" FIXTURE="$name" python3 - "$@" <<'PY'
import json,sys,os
rows=[json.loads(l) for l in open(f"{os.environ['STAGE_DIR']}/{os.environ['FIXTURE']}.jsonl") if l.strip()]
name=os.environ['FIXTURE']
env={"rows":rows,
     "init":next((r for r in rows if r.get("subtype")=="init"),None),
     "result":[r for r in rows if r.get("type")=="result"][-1] if any(r.get("type")=="result" for r in rows) else None,
     "assistant":[r for r in rows if r.get("type")=="assistant"]}
safety={"any":any,"all":all,"str":str,"int":int,"len":len,"sorted":sorted,"True":True,"False":False,"None":None}
for c in sys.argv[1:]:
    try: ok=eval(c, {"__builtins__":{}, **safety}, env)
    except Exception as e: print(f"{name}: check error {c}: {e}"); sys.exit(1)
    if ok is not True: print(f"{name}: FAILED {c}"); sys.exit(1)
print(f"{name}: ok")
PY
}

# ---- fixture: success ----
SCENARIO_CWD=$RAW
run success 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$PROFILE" --strict-mcp-config --allowed-mcp-server-names nothing \
  --tools "" --setting-sources user
jassert success \
  'init is not None' 'init.get("tools")==[]' 'init.get("mcp_servers")==[]' \
  'init.get("permissionMode")=="default"' 'init.get("model")=="Auto"' \
  'result.get("result")=="ok"' 'result.get("is_error") is False' \
  'rows[0].get("subtype")=="hook_started"'

# ---- fixture: tool-use（读 RAW 内生成的确定性文件，不触机器文件）----
TOOLFILE="$RAW/tool-input.txt"; printf 'F317-DETERMINISTIC-LINE-1\n' > "$TOOLFILE"
run tool-use 0 "$QODER_BIN" -p "Read the file $TOOLFILE and reply with its exact content." \
  -o stream-json --config-dir "$PROFILE" --tools "Read" --setting-sources user
jassert tool-use \
  'any(b.get("type")=="tool_use" and b.get("name")=="Read" and str(b.get("input",{}).get("file_path","")).endswith("tool-input.txt") for r in assistant for b in r.get("message",{}).get("content",[]))' \
  'any(b.get("type")=="tool_result" and "F317-DETERMINISTIC-LINE-1" in str(b.get("content")) for r in rows if r.get("type")=="user" for b in (r.get("message",{}).get("content") or []))' \
  'result.get("is_error") is False'

# ---- fixture: permission-denial（唯一临时目标）----
PWNED="$RAW/pwned-$$.txt"; rm -f "$PWNED"
run permission-denial 0 "$QODER_BIN" -p "Use the Write tool to create $PWNED with content 'x'. Do it now, do not ask." \
  -o stream-json --config-dir "$PROFILE" --tools "Write" --setting-sources user
[ ! -e "$PWNED" ] || fail "permission-denial: target file was written"
echo "target_absent=true" >> "$STAGE/permission-denial.side-effect"
jassert permission-denial \
  'any(b.get("is_error") for r in rows if r.get("type")=="user" for b in (r.get("message",{}).get("content") or []))' \
  'result.get("is_error") is False'

# ---- fixture: auth-error（空 config dir，预期 exit 1）----
EMPTY=$(mktemp -d "$RAW/empty.XXXXXX")
run auth-error 1 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$EMPTY" --tools ""
jassert auth-error 'result.get("is_error") is True' 'result.get("subtype")=="success"'

# ---- fixture: silent-model-fallback ----
run silent-model-fallback 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$PROFILE" -m definitely-not-a-model-xyz --tools "" --setting-sources user
jassert silent-model-fallback 'init.get("model")=="Auto"' 'result.get("is_error") is False'

# ---- fixture: resume（依赖 success 的 session_id；断言正确回忆）----
SID=$(python3 -c "import json;print(next(json.loads(l)['session_id'] for l in open('$STAGE/success.jsonl') if l.strip()))")
run resume 0 "$QODER_BIN" -r "$SID" -p "In one short sentence: what did I ask you in the previous turn?" \
  -o stream-json --config-dir "$PROFILE" --tools "" --setting-sources user
jassert resume 'result.get("session_id")=="'"$SID"'"' 'result.get("is_error") is False' \
  '"ok" in str(result.get("result","")).lower()'

# ---- fixtures: S5 hook 红→绿（每场景独立 project + 独立 marker）----
mkproj() { local d; d=$(mktemp -d "$RAW/proj.XXXXXX"); mkdir -p "$d/.qoder"; echo "$d"; }

P1D=$(mkproj); echo '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch '"$P1D"'/marker"}]}]}}' > "$P1D/.qoder/settings.json"
SCENARIO_CWD=$P1D
run hook-red 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json --config-dir "$PROFILE" --tools ""
[ -e "$P1D/marker" ] || fail "hook-red: malicious hook did NOT run (expected red)"
echo "marker_present=true" >> "$STAGE/hook-red.side-effect"
jassert hook-red 'any(r.get("subtype")=="hook_started" and "marker" in str(r.get("hook_name","")) for r in rows)'

P2D=$(mkproj); echo '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch '"$P2D"'/marker"}]}]}}' > "$P2D/.qoder/settings.json"
SCENARIO_CWD=$P2D
run hook-green-project 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$PROFILE" --tools "" --setting-sources user
[ ! -e "$P2D/marker" ] || fail "hook-green-project: marker exists (block failed)"
echo "marker_absent=true" >> "$STAGE/hook-green-project.side-effect"
jassert hook-green-project 'not any("marker" in str(r.get("hook_name","")) for r in rows if r.get("subtype")=="hook_started")'

P3D=$(mkproj); echo '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch '"$P3D"'/marker"}]}]}}' > "$P3D/.qoder/settings.local.json"
SCENARIO_CWD=$P3D
run hook-green-local 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$PROFILE" --tools "" --setting-sources user
[ ! -e "$P3D/marker" ] || fail "hook-green-local: marker exists (block failed)"
echo "marker_absent=true" >> "$STAGE/hook-green-local.side-effect"
jassert hook-green-local 'not any("marker" in str(r.get("hook_name","")) for r in rows if r.get("subtype")=="hook_started")'

# ---- 发布前：敏感扫描 + 显式完整性 + generation manifest（sha256 + 断言结果）----
for f in "$STAGE"/*; do scan "$f"; done
for name in $EXPECT; do
  for suf in jsonl stderr.txt exit; do [ -f "$STAGE/$name.$suf" ] || fail "missing artifact $name.$suf"; done
done
ACTUAL=$(cd "$STAGE" && ls *.jsonl | sed 's/\.jsonl//' | sort)
[ "$ACTUAL" = "$(echo $EXPECT | tr ' ' '\n' | sort)" ] || fail "stale/extra fixtures in staging: $ACTUAL"

python3 - "$STAGE" "$EXPECT" > "$STAGE/generation.json" <<'PY'
import json,sys,hashlib,os
stage,expect=sys.argv[1],sys.argv[2].split()
def sha(p): return hashlib.sha256(open(p,'rb').read()).hexdigest()
print(json.dumps({"generation":"qoder-f317","expect":expect,
  "artifacts":{n:{s:sha(f"{stage}/{n}.{s}") for s in ("jsonl","stderr.txt","exit")} for n in expect},
  "side_effects":sorted(os.path.basename(p) for p in __import__('glob').glob(f"{stage}/*.side-effect"))},indent=2))
PY

# ---- 原子发布：DEST/gen-<hash> 暂存 + 单一 rename 指针 ----
GENHASH=$(python3 -c "import hashlib;print(hashlib.sha256(open('$STAGE/generation.json','rb').read()).hexdigest()[:12])")
PUBLISH="$DEST/.gen-$GENHASH"
rm -rf "$PUBLISH"; cp -R "$STAGE" "$PUBLISH"
TMP="$DEST/.current.tmp"; rm -rf "$TMP"
mv "$PUBLISH" "$TMP" && mv "$TMP" "$PUBLISH"   # 同目录 rename，原子可见
ln -sfn ".gen-$GENHASH" "$DEST/current" || fail "publish pointer failed"
echo "published generation $GENHASH: $EXPECT"
