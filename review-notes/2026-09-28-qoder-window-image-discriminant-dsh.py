#!/usr/bin/env python3
"""Window-opening discriminant, take 2: image path vs catalog path (点点/dsh-v41-flash, F317).

Why this exists: the packet line "网关抖动是独立开窗因子，保鲜保证率 ~79%" was reached by
counting legs whose window exceeded a threshold. Counting is fine; the ATTRIBUTION was not
tested. This script tests it against the two candidate structural discriminants that were
already in §4 of the discriminants note -- and separates them, because they co-occur.

Discipline (all read-only, no new instrumentation):
  * window        = recv(input.prompt.received) - ss(SessionStart hook.finished); never t0.
  * image marker  = `uploadImage|image-upload|base64 image|image/upload` anywhere at or
                    before recv. Deliberately NOT window-limited: a window-limited marker
                    would be trivially biased (short window => upload happens after recv
                    => leg misclassified as non-image). Both scorings are printed and must
                    agree, otherwise the marker is window-dependent and the test is void.
  * catalog       = win_catalog column of the committed window table (already validated).
  * jitter marker = FAILED|fetch failed|AbortError|reconnect inside the window, plus the
                    single largest in-window inter-event gap, to see WHERE the time sits.

Output: 4-way (img x catalog) contingency with medians, Fisher exact on the image split,
and a per-leg trace attribution for the outlier legs.

Usage: python3 review-notes/2026-09-28-qoder-window-image-discriminant-dsh.py
"""
from __future__ import annotations

import csv
import datetime as dt
import glob
import os
import re
import statistics as st
from math import comb

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
TABLE = os.path.join(HERE, "2026-09-28-qoder-runlog-window-table-dsh.tsv")
RUN_GLOBS = [
    os.path.join(REPO, ".cat-cafe/qoder-profiles/*/logs/runs/*"),
]

TS = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00)")
IMAGE = re.compile(r"uploadImage|image-upload|base64 image|image/upload")
JITTER = re.compile(r"FAILED|fetch failed|AbortError|reconnect")
THRESHOLD_MS = 14_000  # the packet's "14-46s 窗" lower edge


def ms(iso: str) -> int:
    return int(dt.datetime.fromisoformat(iso).timestamp() * 1000)


def fisher_two_sided(a: int, b: int, c: int, d: int) -> float:
    """Two-sided Fisher exact for [[a,b],[c,d]]."""
    n, s, r = a + b + c + d, a + c, a + b
    tot = comb(n, s)
    obs = comb(r, a) * comb(n - r, s - a) / tot
    p = 0.0
    lo, hi = max(0, s - (n - r)), min(r, s)
    for k in range(lo, hi + 1):
        pr = comb(r, k) * comb(n - r, s - k) / tot
        if pr <= obs + 1e-12:
            p += pr
    return p


def load_legs() -> list[dict]:
    dirs = [d for g in RUN_GLOBS for d in glob.glob(g)]
    legs = []
    for row in csv.DictReader(open(TABLE), delimiter="\t"):
        hit = [d for d in dirs if d.endswith(row["run"])]
        if not hit:
            continue
        try:
            text = open(os.path.join(hit[0], "qodercli.log"), errors="replace").read()
        except OSError:
            continue
        ev = []
        for line in text.splitlines():
            m = TS.match(line)
            if m:
                ev.append((ms(m.group(1)), line[m.end():].strip()))
        ss = next((t for t, s in ev if "SessionStart" in s and "finished" in s), None)
        recv = next((t for t, s in ev if "input.prompt.received" in s), None)
        if ss is None or recv is None:
            continue  # leg unmeasurable, not zero
        pre, win = [s for t, s in ev if t <= recv], [s for t, s in ev if ss <= t <= recv]
        gaps = [ev[i + 1][0] - ev[i][0]
                for i in range(len(ev) - 1)
                if ss <= ev[i][0] and ev[i + 1][0] <= recv]
        legs.append(dict(
            run=row["run"][-12:], status=row["cache_status"], age=row["cache_age_s"],
            window=recv - ss, catalog=row["win_catalog"] == "1",
            image_pre=bool(IMAGE.search(" ".join(pre))),
            image_win=bool(IMAGE.search(" ".join(win))),
            jitter=sum(1 for s in win if JITTER.search(s)),
            gap=max(gaps, default=0),
        ))
    return legs


def med(xs) -> float:
    return st.median(xs) / 1000 if xs else float("nan")


def main() -> None:
    legs = load_legs()
    print(f"legs scanned: {len(legs)}")
    bad = [l["run"] for l in legs if l["image_pre"] != l["image_win"]]
    print(f"marker sanity (pre-recv vs window-limited disagree): {len(bad)} {bad}")
    if bad:
        print("  -> marker is window-dependent; contingency below is VOID")

    for group in ("fresh", "stale"):
        g = [l for l in legs if l["status"] == group]
        hi = [l for l in g if l["window"] >= THRESHOLD_MS]
        img = [l for l in g if l["image_pre"]]
        noimg = [l for l in g if not l["image_pre"]]
        print(f"\n===== {group} n={len(g)}  >= {THRESHOLD_MS/1000:.0f}s: {len(hi)}")
        print(f"  image legs    n={len(img):>3}  window med={med([l['window'] for l in img]):7.1f}s"
              f"  >=thr {sum(1 for l in img if l['window'] >= THRESHOLD_MS)}/{len(img)}")
        print(f"  non-image     n={len(noimg):>3}  window med={med([l['window'] for l in noimg]):7.1f}s"
              f"  >=thr {sum(1 for l in noimg if l['window'] >= THRESHOLD_MS)}/{len(noimg)}")
        a = sum(1 for l in img if l["window"] >= THRESHOLD_MS)
        b = len(img) - a
        c = sum(1 for l in noimg if l["window"] >= THRESHOLD_MS)
        d = len(noimg) - c
        if img and noimg:
            print(f"  Fisher [[{a},{b}],[{c},{d}]] two-sided p={fisher_two_sided(a,b,c,d):.3g}")

    print("\n===== 4-way: do the two discriminants explain each other?")
    print(f"{'image':>6}{'catalog':>9} | {'n':>4} {'window med':>11} {'>=thr':>6}")
    for i in (True, False):
        for c in (True, False):
            g = [l for l in legs if l["image_pre"] == i and l["catalog"] == c]
            if g:
                print(f"{str(i):>6}{str(c):>9} | {len(g):>4} {med([l['window'] for l in g]):>10.1f}s"
                      f" {sum(1 for l in g if l['window'] >= THRESHOLD_MS):>4}/{len(g)}")

    print("\n===== is jitter presence a predictor? (identical signature, different window)")
    for l in sorted(legs, key=lambda x: -x["window"])[:10]:
        print(f"  {l['run']} age={l['age']:>6} win={l['window']/1000:7.1f}s "
              f"largestGap={l['gap']/1000:7.1f}s img={int(l['image_pre'])} cat={int(l['catalog'])} "
              f"jitterLines={l['jitter']}")


if __name__ == "__main__":
    main()
