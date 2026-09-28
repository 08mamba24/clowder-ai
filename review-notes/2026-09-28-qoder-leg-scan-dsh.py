#!/usr/bin/env python3
"""Scan qoder CLI segment logs + session transcripts to build a per-leg latency table.

Sources (all read-only):
  A. <profile>/logs/sessions/<enc>/<sessionId>/segments/<ISO>+08-00-<rand>-p<pid>.jsonl
     -- CLI-side structured event log; filename timestamp = process start.
  B. <profile>/projects/<enc>/<sessionId>.jsonl
     -- session transcript; message rows carry ISO-Z timestamps, control rows carry epoch ms.

Derived per leg:
  t0        process start (from segment filename)
  route     cli.route.entered
  recv      input.prompt.received        (CLI read stdin prompt)
  mstart    model.request.started
  mend      model.response.completed
  turnend   turn.finished
  init_gap  recv - t0        (CLI in-process startup / session restore)
  model_ms  mend - mstart    (CLI-observed provider latency)
  total_ms  turnend - t0
  sess_bytes_at_t0 / sess_lines_at_t0  (transcript size when the leg started)
  idle_ms   t0 - previous leg's turnend in the same session
"""
from __future__ import annotations

import bisect
import datetime as dt
import glob
import json
import os
import re
import sys

PROFILES = [
    "/Users/yuhan/cat-cafe/clowder-ai/.cat-cafe/qoder-profiles/qoder-flash",
    "/Users/yuhan/cat-cafe/clowder-ai/.cat-cafe/qoder-profiles/qoder",
]

SEG_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})\+08-00")


def parse_iso(s: str) -> int | None:
    """Parse '2026-09-28T22:54:43.861+08:00' or '...Z' into epoch ms."""
    if not isinstance(s, str) or len(s) < 20:
        return None
    try:
        return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


def seg_start_ms(name: str) -> int | None:
    m = SEG_RE.match(os.path.basename(name))
    if not m:
        return None
    y, mo, d, h, mi, s, ms = (int(x) for x in m.groups())
    tz = dt.timezone(dt.timedelta(hours=8))
    return int(dt.datetime(y, mo, d, h, mi, s, ms * 1000, tzinfo=tz).timestamp() * 1000)


def read_segment(path: str) -> dict:
    out: dict = {}
    with open(path, errors="replace") as fh:
        for line in fh:
            if '"ts":"' not in line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            t = parse_iso(o.get("ts", ""))
            ty = o.get("type")
            if t is None:
                continue
            if ty == "cli.route.entered" and "route" not in out:
                out["route"] = t
            elif ty == "input.prompt.received" and "recv" not in out:
                out["recv"] = t
            elif ty == "input.prompt.submitted" and "submitted" not in out:
                out["submitted"] = t
            elif ty == "model.request.started" and "mstart" not in out:
                out["mstart"] = t
            elif ty == "model.response.completed":
                out.setdefault("mend", t)
            elif ty == "turn.started" and "turnstart" not in out:
                out["turnstart"] = t
            elif ty == "turn.finished":
                out["turnend"] = t
            elif ty == "session.phase.finished" and (o.get("data") or {}).get("phase") == "qoder_runtime.ready":
                out["runtime_ready"] = t
    return out


def transcript_timeline(path: str) -> tuple[list[int], list[int]]:
    """Return (timestamps_ms, cumulative_bytes) for timestamped transcript rows."""
    ts: list[int] = []
    cb: list[int] = []
    total = 0
    with open(path, "rb") as fh:
        for raw in fh:
            total += len(raw)
            if b'"timestamp"' not in raw:
                continue
            t = None
            s = raw.decode("utf-8", "replace")
            m = re.search(r'"timestamp":(\d{10,16})', s)
            if m:
                v = int(m.group(1))
                t = v if v > 1_000_000_000_000 else v * 1000
            else:
                m = re.search(r'"timestamp":"([^"]+)"', s)
                if m:
                    t = parse_iso(m.group(1))
            if t:
                ts.append(t)
                cb.append(total)
    return ts, cb


def main() -> None:
    rows = []
    for prof in PROFILES:
        prof_name = os.path.basename(prof)
        for seg in glob.glob(os.path.join(prof, "logs/sessions/*/*/segments/*.jsonl")):
            seg_dir = os.path.dirname(os.path.dirname(seg))
            session_id = os.path.basename(seg_dir)
            enc = os.path.basename(os.path.dirname(seg_dir))
            t0 = seg_start_ms(seg)
            if not t0:
                continue
            ev = read_segment(seg)
            r = {
                "profile": prof_name,
                "session": session_id[:8],
                "session_full": session_id,
                "seg": os.path.basename(seg),
                "t0": t0,
            }
            r.update(ev)
            rows.append(r)

    # session size timelines
    cache: dict[str, tuple[list[int], list[int]]] = {}
    for r in rows:
        key = r["session_full"] + "|" + r["profile"]
        if key not in cache:
            prof = next(p for p in PROFILES if os.path.basename(p) == r["profile"])
            tp = glob.glob(os.path.join(prof, "projects/*", r["session_full"] + ".jsonl"))
            cache[key] = transcript_timeline(tp[0]) if tp else ([], [])
        ts, cb = cache[key]
        if ts:
            i = bisect.bisect_right(ts, r["t0"]) - 1
            r["sess_bytes"] = cb[i] if i >= 0 else 0
            r["sess_lines"] = i + 1 if i >= 0 else 0
        else:
            r["sess_bytes"] = 0
            r["sess_lines"] = 0

    # idle time since previous leg in same session
    by_sess: dict[str, list[dict]] = {}
    for r in rows:
        by_sess.setdefault(r["profile"] + "|" + r["session_full"], []).append(r)
    for legs in by_sess.values():
        legs.sort(key=lambda x: x["t0"])
        prev_end = None
        for leg in legs:
            leg["idle_ms"] = (leg["t0"] - prev_end) if prev_end else None
            prev_end = leg.get("turnend") or leg["t0"]

    rows.sort(key=lambda x: x["t0"])

    def g(r, k):
        return r.get(k)

    hdr = ["UTC", "profile", "sess", "pid", "route_ok", "runtime_ready_ms", "init_gap_ms",
           "model_ms", "total_ms", "recv2end_ms", "sess_KB", "sess_lines", "idle_s", "seg"]
    print("\t".join(hdr))
    for r in rows:
        t0 = r["t0"]
        utc = dt.datetime.fromtimestamp(t0 / 1000, dt.timezone.utc).strftime("%m-%d %H:%M:%S")
        pid = ""
        m = re.search(r"-p(\d+)\.jsonl$", r["seg"])
        if m:
            pid = m.group(1)
        init_gap = (r["recv"] - t0) if r.get("recv") else ""
        model_ms = (r["mend"] - r["mstart"]) if (r.get("mend") and r.get("mstart")) else ""
        total_ms = (r["turnend"] - t0) if r.get("turnend") else ""
        recv2end = (r["turnend"] - r["recv"]) if (r.get("turnend") and r.get("recv")) else ""
        rt = (r["runtime_ready"] - t0) if r.get("runtime_ready") else ""
        cells = [utc, r["profile"], r["session"], pid, "1" if r.get("route") else "0", rt,
                 init_gap, model_ms, total_ms, recv2end,
                 round(r["sess_bytes"] / 1024), r["sess_lines"],
                 round(r["idle_ms"] / 1000) if r.get("idle_ms") else "", r["seg"]]
        print("\t".join(str(c) for c in cells))


if __name__ == "__main__":
    main()
