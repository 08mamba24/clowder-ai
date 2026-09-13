#!/usr/bin/env python3
"""F317 qoder fixture generation 验证器（唯一读方入口）。

fail-closed：解析 DEST/current 指针 → 限制目标仍在 DEST 内 → 校验 schema/collector/expect
→ 重算 artifacts + side_effects 全量 sha256 → 目录内不得有缺失/额外/篡改文件。
任何一步失败非零退出。
用法: python3 verify.py [DEST]   # 默认脚本所在目录
"""
import hashlib, json, os, sys

EXPECT = ["success", "tool-use", "permission-denial", "auth-error",
          "silent-model-fallback", "resume", "hook-red", "hook-green-project", "hook-green-local"]
ARTIFACT_SUFFIXES = ("jsonl", "stderr.txt", "exit", "assert")
SCHEMA = "qoder-f317-generation/2"


def fail(msg):
    print(f"VERIFY FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def main():
    dest = os.path.realpath(os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))))
    current = os.path.join(dest, "current")
    if not os.path.islink(current):
        fail("current is not a symlink")
    target = os.readlink(current)
    gendir = os.path.realpath(os.path.join(dest, target))
    if os.path.dirname(gendir) != dest:
        fail(f"current escapes DEST: {target}")

    manifest_path = os.path.join(gendir, "generation.json")
    try:
        g = json.load(open(manifest_path))
    except Exception as e:
        fail(f"unreadable generation.json: {e}")
    if g.get("schema") != SCHEMA or g.get("collector") != "collect.sh":
        fail(f"unexpected schema/collector: {g.get('schema')}/{g.get('collector')}")
    if sorted(g.get("expect", [])) != sorted(EXPECT):
        fail(f"expect mismatch: {g.get('expect')}")

    expected_files = {"generation.json"}
    for n in EXPECT:
        for s in ARTIFACT_SUFFIXES:
            h = g["artifacts"].get(n, {}).get(s)
            if not h:
                fail(f"manifest missing hash for {n}.{s}")
            p = os.path.join(gendir, f"{n}.{s}")
            if not os.path.isfile(p):
                fail(f"missing artifact {n}.{s}")
            if sha(p) != h:
                fail(f"hash mismatch: {n}.{s}")
            expected_files.add(f"{n}.{s}")
    for name, h in g.get("side_effects", {}).items():
        p = os.path.join(gendir, name)
        if not os.path.isfile(p):
            fail(f"missing side-effect receipt {name}")
        if sha(p) != h:
            fail(f"hash mismatch: side-effect {name}")
        expected_files.add(name)

    actual = set(os.listdir(gendir))
    extra, missing = actual - expected_files, expected_files - actual
    if missing:
        fail(f"missing files: {sorted(missing)}")
    if extra:
        fail(f"extra/tampered files: {sorted(extra)}")

    print(f"verified generation {os.path.basename(gendir)}: {len(EXPECT)} fixtures, "
          f"{len(g['side_effects'])} side-effect receipts, all hashes match")


if __name__ == "__main__":
    main()
