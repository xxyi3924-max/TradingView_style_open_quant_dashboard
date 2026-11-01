"""Sensitivity grid: a strategy replayed under every stress scenario of tools/backtest.py.

Axes (backtest.STRESS_STOPS): push half-life h in ticks (0 = the website, inf = no decay within the day), liquidity
share s (fraction of displayed volume and market trades that is ours; the push per unit is lambda / s) and delay d
(ticks before an order reaches the book). Every scenario replays all training days; only summaries are kept.

Usage:
  python3 tools/stress.py submission/example_trader.py [--out runs/example_trader/<stamp>]
  python3 tools/stress.py --all          # every strategy's latest website run, tables to docs/stress_results.md
  python3 tools/stress.py --doc          # rebuild docs/stress_results.md from the saved grids, without replaying
Writes stress_grid.json next to the website run's meta.json and prints the tables. The results doc also shows each
strategy under the previous model (K ln Q per taken unit, Avellaneda & Stoikov eq. 11) for comparison.
"""
import argparse
import csv
import glob
import itertools
import json
import math
import os
import sys
import time
from multiprocessing import Pool
from typing import Dict, Iterable, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tools import backtest as bt  # noqa: E402

DOC = os.path.join(bt.ROOT, "docs", "stress_results.md")
OLD_K = os.path.join(bt.RUNS, "impact_k.json")     # K per product of the previous model, as it was calibrated
REFERENCE = [("Mild", 10, 0.75, 0), ("Moderate", 100, 0.5, 0), ("Severe", 1000, 0.25, 1)]   # (name, h, share, delay)


def scenarios() -> List[bt.Stress]:
    s = bt.STRESS_STOPS
    return [bt.Stress(h, sh, d) for d, sh, h in itertools.product(s["delay"], s["share"], s["half_life"])]


def _num(x) -> str:
    return f"{x:,.0f}".replace("-", "−")


def run_grid(path: str, days=(-2, -1, 0)) -> dict:
    t0 = time.time()
    path = os.path.abspath(path)
    lam = bt.calibrate_lambda(tuple(sorted(bt.TTE)))
    grid = scenarios()
    jobs = [(path, d, st, lam) for st in grid for d in days]
    with Pool(os.cpu_count() or 1) as pool:
        results = pool.map(bt._replay_day, jobs, chunksize=1)
    cells = []
    for k, st in enumerate(grid):
        rs = results[k * len(days):(k + 1) * len(days)]
        s = bt.summarize(bt._stitch(rs), [f for r in rs for f in r.fills])
        s.pop("products")
        cells.append({"half_life": None if math.isinf(st.half_life) else st.half_life, "share": st.share,
                      "delay": st.delay, "label": st.label(), **s})
    website = next(c for c in cells if c["label"] == bt.Stress().label())
    traded = sorted({f.product for r in results[:len(days)] for f in r.fills})
    stops = bt.STRESS_STOPS
    return {"strategy": os.path.splitext(os.path.basename(path))[0], "label": os.path.basename(path),
            "path": os.path.relpath(path, bt.ROOT), "created": time.strftime("%Y-%m-%d %H:%M:%S"),
            "seconds": round(time.time() - t0, 1), "days": list(days),
            "axes": {"half_life": [None if math.isinf(h) else h for h in stops["half_life"]], "share": stops["share"],
                     "delay": stops["delay"]},
            "lambda": {p: lam.get(p) for p in traded}, "website": website, "cells": cells}


def markdown(grid: dict) -> str:
    """One table per delay: rows = liquidity share, columns = push half-life, cells = PnL (share of website PnL)."""
    base = grid["website"]["pnl"]
    hs = grid["axes"]["half_life"]
    by = {(c["half_life"], c["share"], c["delay"]): c for c in grid["cells"]}
    out = []
    for d in grid["axes"]["delay"]:
        out.append(f"**Delay {d} tick{'s' if d != 1 else ''}**\n")
        out.append("| liquidity share | " + " | ".join(f"h {'∞' if h is None else f'{h:g}'}" for h in hs) + " |")
        out.append("|---|" + "---|" * len(hs))
        for s in grid["axes"]["share"]:
            row = []
            for h in hs:
                c = by.get((h, s, d))
                if c is None:
                    row.append("")
                    continue
                pct = f" ({_num(100 * c['pnl'] / base)}%)" if base else ""
                row.append(f"{_num(c['pnl'])}{pct}")
            out.append(f"| {round(s * 100)}% | " + " | ".join(row) + " |")
        out.append("")
    return "\n".join(out)


def klnq_cost(fills: Iterable[Tuple[int, int, str, int, str]], k: Dict[str, float]) -> float:
    """The previous model's charge on a run's fills (day, timestamp, product, qty, kind): every taken unit paid K ln Q,
    Q being the units taken that tick on that side of the product; resting fills paid nothing."""
    q: Dict[Tuple[int, int, str, bool], int] = {}
    for day, ts, product, qty, kind in fills:
        if kind == "take":
            key = (day, ts, product, qty > 0)
            q[key] = q.get(key, 0) + abs(qty)
    return sum(k.get(p, 0.0) * n * math.log(n) for (_, _, p, _), n in q.items() if n > 1)


def old_model(folder: str) -> Optional[float]:
    """Website PnL minus the previous model's charge on the same fills; None without its calibration file."""
    try:
        with open(OLD_K) as f:
            k = json.load(f)["k"]
        meta = json.load(open(os.path.join(folder, "meta.json")))
        with open(os.path.join(folder, "fills.csv"), newline="") as f:
            rows = [(int(r["day"]), int(r["timestamp"]), r["product"], int(r["qty"]), r["kind"]) for r in csv.DictReader(f)]
    except (OSError, ValueError, KeyError):
        return None
    return meta["summary"]["pnl"] - klnq_cost(rows, k)


def summary(rows: List[Tuple[dict, Optional[float]]]) -> str:
    """One row per strategy: website PnL, the previous model, the reference scenarios and the grid's extremes."""
    def with_pct(v, base):
        if v is None:
            return "—"
        return f"{_num(v)} ({_num(100 * v / base)}%)" if base else _num(v)
    head = ["Strategy", "Website", "Old model (K·ln Q)"] + [
        f"{n}: h {h:g} · {round(s * 100)}% · {'no delay' if d == 0 else f'{d}-tick delay'}" for n, h, s, d in REFERENCE] + [
        "Profitable scenarios", "Worst scenario"]
    out = ["| " + " | ".join(head) + " |", "|---" * len(head) + "|"]
    for grid, old in rows:
        base = grid["website"]["pnl"]
        by = {(c["half_life"], c["share"], c["delay"]): c["pnl"] for c in grid["cells"]}
        refs = [with_pct(by.get((h, s, d)), base) for _, h, s, d in REFERENCE]
        pnls = [c["pnl"] for c in grid["cells"]]
        out.append(f"| {grid['label']} | {_num(base)} | {with_pct(old, base)} | " + " | ".join(refs) +
                   f" | {sum(v > 0 for v in pnls)} of {len(pnls)} | {_num(min(pnls))} |")
    return "\n".join(out)


def write_doc() -> str:
    """docs/stress_results.md from every strategy's saved grid (latest website run)."""
    rows, sections = [], []
    for _slug, folder in sorted(latest_website_runs().items()):
        path = os.path.join(folder, "stress_grid.json")
        if not os.path.exists(path):
            continue
        with open(path) as f:
            grid = json.load(f)
        rows.append((grid, old_model(folder)))
        sections.append(_section(grid))
    text = ("# Stress results\n\nGenerated by `python3 tools/stress.py --all` (or `--doc` from the saved grids); the model is "
            "described in [slippage_model.md](slippage_model.md). PnL is over the three training days, with its share of "
            "the website PnL in brackets. h is the push half-life in ticks, the percentage the liquidity share (of displayed "
            "volume and market trades), and the delay the ticks before an order reaches the book; h 0 · 100% · no delay is "
            "the website.\n\n## Summary\n\n" + summary(rows) + "\n\n*Old model*: the previous impact pass, each taken unit "
            "charged K·ln Q on the website's fills (no feedback). *Mild*, *Moderate* and *Severe* are three cells of the "
            "grid below; *Profitable scenarios* counts the grid cells with PnL above zero.\n\n" + "\n".join(sections))
    with open(DOC, "w") as f:
        f.write(text)
    return text


def latest_website_runs() -> Dict[str, str]:
    """slug -> folder of its newest website (unstressed) run."""
    out: Dict[str, str] = {}
    for m in sorted(glob.glob(os.path.join(bt.RUNS, "*", "*", "meta.json"))):
        try:
            meta = json.load(open(m))
        except (OSError, ValueError):
            continue
        if meta.get("stress") is None and "lambda" in meta:
            out[os.path.basename(os.path.dirname(os.path.dirname(m)))] = os.path.dirname(m)
    return out


def _section(grid: dict) -> str:
    w = grid["website"]
    lam = ", ".join(f"{p} {v:.3f}" for p, v in grid["lambda"].items() if v is not None)
    return (f"## {grid['label']}\n\nWebsite PnL {_num(w['pnl'])} over days {', '.join(map(str, grid['days']))}; "
            f"{_num(w['taken_volume'])} units taken from the book. Push per unit taken (lambda): {lam}.\n\n{markdown(grid)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("strategy", nargs="?", help="path to a file defining class Trader")
    ap.add_argument("--out", help="website run folder to write stress_grid.json into (default: its latest run)")
    ap.add_argument("--all", action="store_true", help="every strategy's latest website run; tables to docs/stress_results.md")
    ap.add_argument("--doc", action="store_true", help="only rebuild docs/stress_results.md from the saved grids")
    a = ap.parse_args()
    if a.all:
        for slug, folder in sorted(latest_website_runs().items()):
            meta = json.load(open(os.path.join(folder, "meta.json")))
            grid = run_grid(os.path.join(bt.ROOT, meta["path"]))
            grid["label"] = meta["label"]
            with open(os.path.join(folder, "stress_grid.json"), "w") as f:
                json.dump(grid, f, indent=1)
            print(f"{slug}: {grid['seconds']}s", flush=True)
    if a.all or a.doc:
        write_doc()
        print(f"wrote {os.path.relpath(DOC, bt.ROOT)}")
        return 0
    if not a.strategy:
        ap.error("give a strategy file or --all")
    grid = run_grid(a.strategy)
    folder = a.out or latest_website_runs().get(os.path.splitext(os.path.basename(a.strategy))[0])
    if folder:
        with open(os.path.join(folder, "stress_grid.json"), "w") as f:
            json.dump(grid, f, indent=1)
    print(_section(grid))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
