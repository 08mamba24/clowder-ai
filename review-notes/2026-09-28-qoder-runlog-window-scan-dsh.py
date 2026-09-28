#!/usr/bin/env python3
"""Per-run CLI-log window scan (点点/dsh-v41-flash, F317 qoder leg-latency line).

Why this exists: the 196-leg segment table (2026-09-28-qoder-leg-scan-dsh.py) measures
`init_gap = input.prompt.received - process_start` but cannot say WHAT the 26.7s
zero-event window is. Every qoder run also writes

    <profile>/logs/runs/<run_id>/qodercli.log     (second-resolution; always on, env debug=false)
    <profile>/logs/runs/<run_id>/manifest.json    (exact argv, cli_version, cwd, pid)

so the window is already instrumented -- no new instrumentation, no manual CLI run.

Milestones per run (all read-only):
  t0            process.started
  resume        cli.arguments.parsed resume=true|false   <- 判别一 new vs resume, argv truth
  ready         session.phase.finished phase="qoder_runtime.ready"  (+ wait_catalog flag)
  ss_end        SessionStart hook.finished that precedes recv (security-scan plugin)
  transport     "[endpoints] Inference transport ready operation=<op>"
  cat_req/resp  operation=modelCatalogFetch -->/<--
  cat_saved     "[catalog] Saved model cache to disk"
  cache_age_s   "[catalog] Loaded N models from stale disk cache (age Xs)"
  recv          input.prompt.received
  model         model.request.started -> model.response.completed (CLI clock)

Derived: init=recv-t0, window=recv-ss_end, stall0=transport-ready,
         stall1=cat_saved-transport, stall2=recv-cat_saved,
         win_catalog = the window contains the catalog-refresh path.

Join: --join-table attaches sess/idle_s from the canonical 196-leg TSV by pid.
"""
from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import re
import statistics as st

PROFILES = [
    "/Users/yuhan/cat-cafe/clowder-ai/.cat-cafe/qoder-profiles/qoder-flash",
    "/Users/yuhan/cat-cafe/clowder-ai/.cat-cafe/qoder-profiles/qoder",
]
TS = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00)")
STALE = re.compile(r"stale disk cache \(age (\d+)s\)")
TRANSPORT = re.compile(r"Inference transport ready operation=(.*?) route=")


def ms(iso: str) -> int:
    return int(dt.datetime.fromisoformat(iso).timestamp() * 1000)


def scan_run(run_dir: str) -> dict | None:
    log = os.path.join(run_dir, "qodercli.log")
    man = os.path.join(run_dir, "manifest.json")
    if not os.path.isfile(log):
        return None
    r: dict = {"run": os.path.basename(run_dir), "transport": {}, "ss_ends": []}
    if os.path.isfile(man):
        try:
            m = json.load(open(man))
            argv = m.get("argv") or []
            r["pid"] = m.get("pid")
            r["cli_version"] = m.get("cli_version")
            r["has_r"] = int("-r" in argv)
            r["model"] = argv[argv.index("-m") + 1] if "-m" in argv else ""
        except Exception:
            pass
    with open(log, errors="replace") as fh:
        for line in fh:
            m = TS.match(line)
            if not m:
                continue
            t = ms(m.group(1))
            if "process.started" in line:
                r["t0"] = t
            elif "cli.arguments.parsed" in line:
                r["resume"] = line.split("resume=")[-1].strip()
            elif "cli.route.entered" in line:
                r.setdefault("route", t)
            elif 'phase="qoder_runtime.ready"' in line and "session.phase.finished" in line:
                r["ready"] = t
                g = re.search(r"wait_catalog=(\w+)", line)
                if g:
                    r["wait_catalog"] = g.group(1)
            elif "hook.finished" in line and "SessionStart" in line:
                r["ss_ends"].append(t)
            elif "Inference transport ready" in line:
                g = TRANSPORT.search(line)
                r["transport"].setdefault(g.group(1) if g else "?", t)
            elif "operation=modelCatalogFetch" in line:
                if "-->" in line:
                    r.setdefault("cat_req", t)
                elif "<--" in line:
                    r.setdefault("cat_resp", t)
            elif "[catalog] Saved model cache" in line:
                r.setdefault("cat_saved", t)
            elif "stale disk cache" in line:
                g = STALE.search(line)
                if g:
                    r.setdefault("cache_age_s", int(g.group(1)))
            elif "inbound session_message received type=user" in line:
                r.setdefault("inbound", t)
            elif "input.prompt.received" in line:
                r.setdefault("recv", t)
            elif "model.request.started" in line:
                r.setdefault("mstart", t)
            elif "model.response.completed" in line:
                r.setdefault("mend", t)
    if "t0" not in r:
        return None
    # SessionStart end that belongs to THIS leg's startup (last one before recv, else first)
    ss = r["ss_ends"]
    if ss:
        before = [t for t in ss if not r.get("recv") or t <= r["recv"]]
        r["ss_end"] = max(before) if before else min(ss)
    # window content markers
    if r.get("recv") and r.get("ss_end"):
        r["win_catalog"] = int(any(r["ss_end"] <= t <= r["recv"] for t in
                                   [r.get("cat_req"), r.get("cat_resp"), r.get("cat_saved")] if t))
        r["win_transport"] = int(any(r["ss_end"] <= t <= r["recv"] for t in r["transport"].values()))
    return r


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--join-table", default="review-notes/2026-09-28-qoder-leg-latency-table-dsh.tsv")
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    by_pid: dict[str, dict] = {}
    if a.join_table and os.path.isfile(a.join_table):
        with open(a.join_table) as fh:
            hdr = fh.readline().rstrip("\n").split("\t")
            for line in fh:
                c = line.rstrip("\n").split("\t")
                d = dict(zip(hdr, c))
                m = re.search(r"-p(\d+)\.jsonl$", d.get("seg", ""))
                if m:
                    by_pid[m.group(1)] = d

    runs = []
    for prof in PROFILES:
        for rd in sorted(glob.glob(os.path.join(prof, "logs/runs/*"))):
            row = scan_run(rd)
            if row:
                row["profile"] = os.path.basename(prof)
                runs.append(row)
    runs.sort(key=lambda r: r["t0"])

    def val(r, name):
        t0 = r["t0"]
        j = by_pid.get(str(r.get("pid")), {})
        tr = r["transport"].get("model catalog fetch")
        return {
            "init": (r["recv"] - t0) if r.get("recv") else None,
            "window": (r["recv"] - r["ss_end"]) if r.get("recv") and r.get("ss_end") else None,
            "ready": (r["ready"] - t0) if r.get("ready") else None,
            "ss_end": (r["ss_end"] - t0) if r.get("ss_end") else None,
            "ss_gap": (r["ss_end"] - r["ready"]) if r.get("ss_end") and r.get("ready") else None,
            "transport": (tr - t0) if tr else None,
            "stall0": (tr - r["ready"]) if tr and r.get("ready") else None,
            "cat_ms": (r["cat_resp"] - r["cat_req"]) if r.get("cat_resp") and r.get("cat_req") else None,
            "stall2": (r["recv"] - r["cat_saved"]) if r.get("recv") and r.get("cat_saved") else None,
            "model": (r["mend"] - r["mstart"]) if r.get("mend") and r.get("mstart") else None,
            "cache_age": r.get("cache_age_s"),
            "idle": (float(j["idle_s"]) * 1000) if j.get("idle_s") else None,
        }[name]

    def vals(name, pred=lambda r: True):
        return [v for v in (val(r, name) for r in runs if pred(r)) if v is not None]

    def stats(name, xs, ind="  "):
        if not xs:
            print(f"{ind}{name:22s} n=0")
            return
        print(f"{ind}{name:22s} n={len(xs):3d} min={min(xs)/1000:7.1f}s p25={pct(xs,.25)/1000:7.1f} "
              f"med={st.median(xs)/1000:6.1f}s p75={pct(xs,.75)/1000:7.1f} max={max(xs)/1000:8.1f}s")

    def pearson(xs, ys):
        n = len(xs)
        if n < 3:
            return None
        mx, my = sum(xs) / n, sum(ys) / n
        num = sum((p - mx) * (q - my) for p, q in zip(xs, ys))
        dx = sum((p - mx) ** 2 for p in xs) ** 0.5
        dy = sum((q - my) ** 2 for q in ys) ** 0.5
        return num / (dx * dy) if dx and dy else None

    if a.out:
        cols = ["ready", "ss_end", "transport", "window", "init", "stall0", "cat_ms", "stall2", "model"]
        names = {"ready": "ready_ms", "ss_end": "ss_end_ms", "transport": "transport_ms",
                 "window": "window_ms", "init": "init_ms", "stall0": "stall0_ms",
                 "cat_ms": "cat_fetch_ms", "stall2": "stall2_ms", "model": "model_ms"}
        hdr = ["UTC", "profile", "run", "pid", "resume", "argv_r", "cli", "sess", "idle_s",
               "cache_age_s", "win_catalog"] + [names[c] for c in cols]
        lines = ["\t".join(hdr)]
        for r in runs:
            j = by_pid.get(str(r.get("pid")), {})
            row = [dt.datetime.fromtimestamp(r["t0"] / 1000, dt.timezone.utc).strftime("%m-%d %H:%M:%S"),
                   r["profile"], r["run"], str(r.get("pid")), r.get("resume", ""), str(r.get("has_r", "")),
                   str(r.get("cli_version", "")), j.get("sess", ""), j.get("idle_s", ""),
                   str(r.get("cache_age_s", "")), str(r.get("win_catalog", ""))]
            row += ["" if val(r, c) is None else str(int(val(r, c))) for c in cols]
            lines.append("\t".join(row))
        open(a.out, "w").write("\n".join(lines) + "\n")
        print(f"[artifact] per-run window table -> {a.out} ({len(runs)} rows)")

    print("== coverage ==")
    print("runs:", len(runs), "| recv:", sum(1 for r in runs if r.get("recv")),
          "| catalog fetch:", sum(1 for r in runs if r.get("cat_req")),
          "| stale-cache line:", sum(1 for r in runs if r.get("cache_age_s") is not None),
          "| transport=model catalog fetch:", sum(1 for r in runs if "model catalog fetch" in r["transport"]))
    print("wait_catalog flags:", {k: sum(1 for r in runs if r.get("wait_catalog") == k) for k in ("true", "false")})
    print()
    for label, pred in [("ALL prompt legs", lambda r: r.get("recv")),
                        ("NEW  (resume=false)", lambda r: r.get("resume") == "false"),
                        ("RESUME (resume=true)", lambda r: r.get("resume") == "true"),
                        ("cache FRESH (no stale line)", lambda r: r.get("cache_age_s") is None and r.get("recv")),
                        ("cache STALE", lambda r: r.get("cache_age_s") is not None and r.get("recv")),
                        ("window contains catalog", lambda r: r.get("win_catalog")),
                        ("window w/o catalog", lambda r: r.get("recv") and not r.get("win_catalog"))]:
        n = sum(1 for r in runs if pred(r))
        print(f"-- {label} (n={n})")
        for c in ("ready", "ss_gap", "window", "init", "stall0", "cat_ms", "stall2", "model"):
            stats(c, vals(c, pred))
    print()
    print("== window anatomy: does the window hold the catalog path? ==")
    for c in ("ready", "window", "init"):
        stats(c, vals(c))
    print()
    print("== correlations ==")
    def corr(n1, n2):
        xs, ys = [], []
        for r in runs:
            p, q = val(r, n1), val(r, n2)
            if p is None or q is None:
                continue
            xs.append(p)
            ys.append(q)
        return len(xs), pearson(xs, ys)
    for x, y in [("init", "idle"), ("window", "idle"), ("init", "cache_age"), ("stall0", "cache_age"),
                 ("window", "cache_age"), ("init", "model")]:
        n, r_ = corr(x, y)
        print(f"  r({x}, {y}) = {'-' if r_ is None else f'{r_:+.3f}'}  (n={n})")
    print()
    print("== longest windows (top 12) ==")
    for r in sorted([r for r in runs if val(r, "window") is not None], key=lambda r: -val(r, "window"))[:12]:
        print(f"  {dt.datetime.fromtimestamp(r['t0']/1000, dt.timezone.utc):%m-%d %H:%M} {r['profile']:11s} "
              f"pid={r.get('pid')} resume={r.get('resume')} cache_age={r.get('cache_age_s')}s "
              f"win={val(r,'window')/1000:6.1f}s cat_in_win={r.get('win_catalog')} init={val(r,'init')/1000:6.1f}s")


def pct(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    i = min(len(xs) - 1, max(0, int(round(q * (len(xs) - 1)))))
    return xs[i]


if __name__ == "__main__":
    main()
