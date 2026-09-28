#!/usr/bin/env python3
"""Image-path scoping for the qoder leg-window line (点点/dsh-v41-flash, F317).

Why this exists: the discriminants note (§9) established that "带图腿" is the
structural window opener, but left two scoping questions open:
  (Q1) where do the images come from / can they be dropped?
  (Q2) is the image path really a different network mode (`networkMode=httpdns`)?

This script answers both from read-only artifacts, plus it pins the denominators
used by the Packet v3.1 table so the two calibers (fresh share vs all-sample
cohort) cannot be silently mixed.

Artifacts read (all local, no writes, no new instrumentation):
  * .cat-cafe/qoder-profiles/*/logs/runs/*/qodercli.log  — CLI process logs
  * .cat-cafe/qoder-profiles/*/projects/*/*.jsonl        — CLI session transcripts
  * review-notes/2026-09-28-qoder-runlog-window-table-dsh.tsv — committed leg table

Usage: python3 review-notes/2026-09-28-qoder-image-path-scoping-dsh.py
"""
from __future__ import annotations

import collections
import csv
import datetime as dt
import glob
import json
import os
import re
import statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
TABLE = os.path.join(HERE, "2026-09-28-qoder-runlog-window-table-dsh.tsv")
RUN_GLOBS = [os.path.join(REPO, ".cat-cafe/qoder-profiles/*/logs/runs/*/*.log")]
TRANSCRIPT_GLOBS = [os.path.join(REPO, ".cat-cafe/qoder-profiles/*/projects/*/*.jsonl")]

TS = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00)")
REQ = re.compile(r"\[qoder-server-request\]")
OP = re.compile(r"operation=(\w+)")
NETMODE = re.compile(r"networkMode=(\w+)")


def secs(a: str, b: str) -> float:
    return (dt.datetime.fromisoformat(b) - dt.datetime.fromisoformat(a)).total_seconds()


def uploaded_filenames() -> collections.Counter[str]:
    """Distinct image files the CLI ever attached (Q1: what are the bytes?)."""
    names: collections.Counter[str] = collections.Counter()
    for pattern in TRANSCRIPT_GLOBS:
        for fn in glob.glob(pattern):
            try:
                text = open(fn, errors="ignore").read()
            except OSError:
                continue
            if "image_file" not in text:
                continue
            for line in text.splitlines():
                if "image_file" not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                stack = [rec]
                while stack:
                    node = stack.pop()
                    if isinstance(node, dict):
                        if node.get("type") == "image_file":
                            names[str(node.get("filename"))] += 1
                        stack.extend(node.values())
                    elif isinstance(node, list):
                        stack.extend(node)
    return names


def leg_logs() -> list[tuple[str, list[str]]]:
    out = []
    for pattern in RUN_GLOBS:
        for p in sorted(glob.glob(pattern)):
            try:
                out.append((os.path.basename(os.path.dirname(p)), open(p, errors="ignore").read().splitlines()))
            except OSError:
                continue
    return out


def main() -> None:
    rows = list(csv.DictReader(open(TABLE), delimiter="\t"))
    logs = leg_logs()

    print("=" * 72)
    print("Q1a. 上传的到底是什么字节（transcript image_file 文件名分布）")
    names = uploaded_filenames()
    for name, count in names.most_common(10):
        size = os.path.getsize(name) if os.path.exists(name) else None
        print(f"  {count:3d}x  {name}  size={size}")
    print(f"  不同文件数 = {len(names)}（1 表示全部带图腿传的是同一个文件）")

    print("=" * 72)
    print("Q1b. 上传与 prompt 的时序（upload 在首个 inbound prompt 之前还是之后）")
    before = after = runs = 0
    gaps: list[float] = []
    gap_ops: collections.Counter[str] = collections.Counter()
    silent_only = 0
    for run, lines in logs:
        ups = [i for i, l in enumerate(lines) if "--> operation=uploadImage" in l]
        if not ups:
            continue
        runs += 1
        first_in = next((i for i, l in enumerate(lines) if "inbound session_message received" in l), None)
        if first_in is not None:
            for u in ups:
                if u < first_in:
                    before += 1
                else:
                    after += 1
        ss = None
        ops: list[str] = []
        up_ts = None
        for l in lines:
            m = TS.match(l)
            if not m:
                continue
            t = m.group(1)
            if ss is None and "hook.finished" in l and "SessionStart" in l:
                ss = t
                continue
            if ss and up_ts is None and "--> operation=uploadImage" in l:
                up_ts = t
                break
            if ss and up_ts is None and REQ.search(l):
                o = OP.search(l)
                if o:
                    ops.append(o.group(1))
        if ss and up_ts:
            gaps.append(secs(ss, up_ts))
            for o in ops:
                gap_ops[o] += 1
            if not ops:
                silent_only += 1
    gaps.sort()
    print(f"  含 uploadImage 的 run: {runs}")
    print(f"  upload 在首个 inbound prompt 之前 {before} / 之后 {after}")
    print(f"  SessionStart(hook.finished) → upload: min {gaps[0]:.1f}s  p50 {st.median(gaps):.1f}s  max {gaps[-1]:.1f}s")
    print(f"  该区间内 qoder-server-request 操作分布: {dict(gap_ops)}")
    print(f"  区间内一个请求都没有的腿: {silent_only}/{len(gaps)}（纯静默段）")

    print("=" * 72)
    print("Q2. networkMode 是不是图片路径专有（全操作交叉表）")
    cross: collections.Counter[tuple[str, str]] = collections.Counter()
    modes: collections.Counter[str] = collections.Counter()
    for _, lines in logs:
        for l in lines:
            if not REQ.search(l):
                continue
            o, m = OP.search(l), NETMODE.search(l)
            if m:
                modes[m.group(1)] += 1
            if o and m:
                cross[(o.group(1), m.group(1))] += 1
    print(f"  networkMode 总体分布: {dict(modes)}")
    for (op, mode), count in cross.most_common(12):
        print(f"    {count:5d}  {op:26s} {mode}")

    print("=" * 72)
    print("Packet v3.1 口径分母（防止 fresh 占比 与 全样本中位 混用）")
    by_status = collections.Counter(r["cache_status"] for r in rows)
    print(f"  cache_status: {dict(by_status)}")
    img_runs = {run for run, lines in logs if any("uploadImage" in l for l in lines)}
    buckets: dict[tuple[str, str, str], list[float]] = collections.defaultdict(list)
    for r in rows:
        w = r["window_ms"]
        if not w:
            continue
        img = "img" if r["run"] in img_runs else "txt"
        cat = "cat" if r["win_catalog"] == "1" else "nocat"
        if r["cache_status"] not in ("fresh", "stale"):
            continue
        buckets[(r["cache_status"], img, cat)].append(float(w) / 1000.0)
    for key in sorted(buckets):
        vals = sorted(buckets[key])
        ge14 = sum(1 for v in vals if v >= 14.0)
        print(f"  {key[0]:5s} {key[1]:3s} {key[2]:5s}  n={len(vals):3d}  窗中位={st.median(vals):6.1f}s  ≥14s={ge14}")
    for cohort in ("fresh", "stale"):
        for axis in ("img", "txt"):
            vals = [v for (s, i, c), vs in buckets.items() if s == cohort and i == axis for v in vs]
            if vals:
                ge14 = sum(1 for v in vals if v >= 14.0)
                print(f"  [{cohort} {axis}] n={len(vals):3d} 窗中位={st.median(vals):6.1f}s ≥14s={ge14}")


if __name__ == "__main__":
    main()
