"""QuantiFi 2026 (UTEFA hackathon): order-book data as chart bars, and tools/backtest.py runs as Strategy Reports.

Time: each training day is one calendar date and each tick (100 timestamp units) one second, so day -2 starts at
2026-01-05 00:00 UTC, day -1 at 2026-01-06 and so on; a day's 10,000 ticks end at 02:46:40. Prices are the mid of the
best bid and ask. Runs live in <QUANTIFI_ROOT>/runs/<strategy>/<stamp>/ (meta.json, fills.csv, equity.csv, greeks.csv)
and are addressed as quantifi:<strategy>/<stamp>.

A run replays the website's fill rules; a stress scenario of it (tools/backtest.py --stress: our takes eat into the side
of the book they trade against, which refills Obizhaeva-Wang style; a thinner book; a delay) lives in
<run>/stress/<label>/ and is reported like any run, with the website run beside it. Trades are holding periods per product: flat -> position -> flat, a
sign flip closing one and opening the next. Days start flat, so a position held at a day's close ends its trade
there, marked at mid (the last day's is shown as open). There is no capital base, so money is in coins and
percentages of capital are left out; Sharpe and Sortino use PnL over 100-tick blocks, scaled to one day.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import uuid
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

from . import bars, config
from .report import _f, _plain, _streaks

PREFIX = "QUANTIFI:"
BASE = 1_767_571_200            # 2026-01-05 00:00 UTC (a Monday): day -2, tick 0
FIRST_DAY = -2
TICKS_PER_DAY = 10_000
BLOCK = 100                     # ticks per Sharpe/Sortino step
SERIES_EVERY = 10               # report and product curves keep every 10th tick (+ each day's last)
TF_SECONDS = {"1S": 1, "5S": 5, "15S": 15, "30S": 30}


def root() -> Path:
    return Path(config.QUANTIFI_ROOT)


def time_of(day, ts):
    return BASE + (np.asarray(day) - FIRST_DAY) * 86400 + np.asarray(ts) // 100


def label(day: int, ts: int) -> str:
    return f"Day {'−' if day < 0 else ''}{abs(day)} · {int(ts):,}"


# ------------------------------------------------------------------------------------- market data
def _stamp(files) -> str:
    return "|".join(f"{f}:{f.stat().st_mtime_ns}" for f in files)


@lru_cache(maxsize=2)
def _prices(root_: str, stamp: str) -> pd.DataFrame:
    frames = [pd.read_csv(f, sep=";", usecols=["day", "timestamp", "product", "bid_price_1", "ask_price_1"])
              for f in sorted(Path(root_, "Data").glob("prices_day_*.csv"))]
    df = pd.concat(frames, ignore_index=True).sort_values(["product", "day", "timestamp"], kind="stable")
    df["mid"] = (df["bid_price_1"] + df["ask_price_1"]) / 2.0           # NaN when a side is empty
    for c in ("mid", "bid_price_1", "ask_price_1"):
        df[c] = df.groupby(["product", "day"])[c].transform(lambda s: s.ffill().bfill())
    df["time"] = time_of(df["day"].to_numpy(), df["timestamp"].to_numpy())
    vol = _trade_volume(root_, stamp)
    df = df.merge(vol, on=["day", "timestamp", "product"], how="left")
    df["volume"] = df["volume"].fillna(0.0)
    df = df.rename(columns={"bid_price_1": "bid", "ask_price_1": "ask"})
    return df[["day", "timestamp", "product", "time", "mid", "bid", "ask", "volume"]].reset_index(drop=True)


@lru_cache(maxsize=2)
def _trade_volume(root_: str, stamp: str) -> pd.DataFrame:
    frames = []
    for f in sorted(Path(root_, "Data").glob("trades_day_*.csv")):
        t = pd.read_csv(f, sep=";", usecols=["timestamp", "symbol", "quantity"])
        t["day"] = int(f.stem.split("_")[-1])
        frames.append(t)
    if not frames:
        return pd.DataFrame(columns=["day", "timestamp", "product", "volume"])
    t = pd.concat(frames).rename(columns={"symbol": "product", "quantity": "volume"})
    return t.groupby(["day", "timestamp", "product"], as_index=False)["volume"].sum()


def prices() -> pd.DataFrame:
    files = sorted(root().joinpath("Data").glob("*_day_*.csv"))
    if not files:
        raise FileNotFoundError(f"no QuantiFi data in {root() / 'Data'}")
    return _prices(str(root()), _stamp(files))


@lru_cache(maxsize=4)
def _paths_cache(root_: str, stamp: str) -> dict:
    """(product, day) -> (timestamps, times, mids, best bids, best asks) arrays, one entry per tick."""
    df = _prices(root_, stamp)
    return {k: (g["timestamp"].to_numpy(), g["time"].to_numpy(), g["mid"].to_numpy(dtype=float),
                g["bid"].to_numpy(dtype=float), g["ask"].to_numpy(dtype=float))
            for k, g in df.groupby(["product", "day"], sort=False)}


def _tick_arrays(product: str, day: int):
    files = sorted(root().joinpath("Data").glob("*_day_*.csv"))
    return _paths_cache(str(root()), _stamp(files)).get((product, day))


def ticks(product: str, day: int):
    """(timestamps, times, mids) of one product's day."""
    t = _tick_arrays(product, day)
    return t[:3] if t else None


def products() -> list[str]:
    return sorted(prices()["product"].unique())


def is_symbol(symbol: str) -> bool:
    return symbol.upper().startswith(PREFIX)


def get_bars(symbol: str, timeframe: str = "1", count: int = 5000, to: int | None = None) -> pd.DataFrame:
    product = symbol.split(":", 1)[1].upper()
    df = prices()
    df = df[df["product"] == product]
    if df.empty:
        raise KeyError(f"{product} is not a QuantiFi product")
    tf = bars.normalize_timeframe(timeframe)
    step = TF_SECONDS.get(tf) or (int(tf) * 60 if tf in bars.INTRADAY else 86400)
    start = BASE + (df["day"].to_numpy() - FIRST_DAY) * 86400
    key = start + (df["time"].to_numpy() - start) // step * step
    g = df.assign(_k=key).groupby("_k", sort=True)
    out = pd.DataFrame({"open": g["mid"].first(), "high": g["mid"].max(), "low": g["mid"].min(),
                        "close": g["mid"].last(), "volume": g["volume"].sum()})
    out.insert(0, "time", out.index.astype("int64"))
    out = out.reset_index(drop=True)
    if to is not None:
        out = out[out["time"] <= to]
    return out.tail(count).reset_index(drop=True)


def search(text: str, limit: int = 30) -> list[dict]:
    text = text.strip().upper()
    if not text:
        return []
    try:
        names = products()
    except FileNotFoundError:
        return []
    hits = [p for p in names if text in p or text in "QUANTIFI"]
    hits.sort(key=lambda p: (not p.startswith(text), p))
    return [{"id": PREFIX + p, "symbol": p, "description": f"{p} · QuantiFi 2026", "exchange": "QUANTIFI",
             "type": "commodity", "source": "quantifi"} for p in hits[:limit]]


def symbol_info(symbol: str) -> dict:
    p = symbol.split(":", 1)[1].upper()
    return {"pro_name": PREFIX + p, "full_name": PREFIX + p, "description": f"{p} · QuantiFi 2026", "exchange": "QUANTIFI",
            "currency_code": "COINS", "timezone": "Etc/UTC", "session": "24x7", "pricescale": 10, "minmov": 1,
            "type": "commodity", "source": "quantifi"}


# ------------------------------------------------------------------------------------- strategies and runs
def strategies() -> list[dict]:
    """Every .py under submission/ and other strategy/ that defines a Trader."""
    r = root()
    files = sorted(r.joinpath("submission").glob("*.py")) + sorted(r.joinpath("other strategy").rglob("*.py"))
    out = []
    for f in files:
        try:
            if "class Trader" not in f.read_text(errors="ignore"):
                continue
        except OSError:
            continue
        rel = f.relative_to(r).as_posix()
        own = rel.startswith("submission/")
        out.append({"path": rel, "slug": slug(rel), "label": f.stem if own else f"{f.parent.name}/{f.stem}",
                    "group": "Submission" if own else f.parent.name})
    return out


def slug(rel: str) -> str:
    p = Path(rel)
    return p.stem if p.parts[0] == "submission" else f"{p.parent.name}-{p.stem}".replace(" ", "_")


def runs_root() -> Path:
    return root() / "runs"


def resolve_run(run_id: str) -> Path:
    if not run_id.startswith("quantifi:"):
        raise FileNotFoundError(run_id)
    base = runs_root().resolve()
    d = (base / run_id[len("quantifi:"):]).resolve()
    if base not in d.parents or not (d / "meta.json").exists():
        raise FileNotFoundError(run_id)
    return d


def list_runs(query: str = "") -> list[dict]:
    out = []
    if not runs_root().exists():
        return out
    for m in runs_root().glob("*/*/meta.json"):
        d = m.parent
        rid = f"quantifi:{d.parent.name}/{d.name}"
        if query and query.lower() not in rid.lower():
            continue
        try:
            meta = json.loads(m.read_text())
        except (OSError, ValueError):
            continue
        s = meta.get("summary", {})
        days = meta.get("days") or []
        out.append({"id": rid, "market": "quantifi", "pool": meta.get("label") or d.parent.name, "folder": "", "name": d.name,
                    "mtime": m.stat().st_mtime, "signal": meta.get("path"), "topk": None, "rebalance_days": None,
                    "start": f"Day {min(days)}" if days else "", "end": f"Day {max(days)}" if days else "",
                    "annual_return": None, "sharpe": s.get("sharpe"), "max_drawdown": None,
                    "pnl": s.get("pnl"), "max_drawdown_coins": s.get("max_drawdown")})
    out.sort(key=lambda r: r["mtime"], reverse=True)
    return out


_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _spawn(cmd: list[str], out: Path, info: dict, wait: bool) -> dict:
    """Run a tools/backtest.py command as a job; done when <out>/meta.json is written."""
    job_id = uuid.uuid4().hex[:12]
    with _jobs_lock:
        _jobs[job_id] = {"id": job_id, "status": "running", "started": time.time(), **info}

    def execute():
        t0 = time.time()
        proc = subprocess.run(cmd, cwd=root(), capture_output=True, text=True, timeout=1800,
                              env={**os.environ, "PYTHONPATH": str(root())})
        with _jobs_lock:
            job = _jobs[job_id]
            job["elapsed"] = time.time() - t0
            job["log"] = (proc.stdout + proc.stderr)[-4000:]
            if proc.returncode == 0 and (out / "meta.json").exists():
                job["status"] = "done"
                job["run_id"] = "quantifi:" + out.resolve().relative_to(runs_root().resolve()).as_posix()
                job["summary"] = json.loads((out / "meta.json").read_text()).get("summary")
            else:
                job["status"] = "error"
                job["error"] = (proc.stderr or proc.stdout)[-2000:] or f"exit {proc.returncode}"

    if wait:
        execute()
    else:
        threading.Thread(target=execute, daemon=True).start()
    return job(job_id)


def start(strategy: str, wait: bool = False) -> dict:
    known = {s["path"]: s for s in strategies()}
    if strategy not in known:
        raise ValueError(f"unknown strategy {strategy!r}")
    s = known[strategy]
    out = runs_root() / s["slug"] / time.strftime("%Y%m%d-%H%M%S")
    cmd = [sys.executable, str(root() / "tools" / "backtest.py"), str(root() / strategy), "--out", str(out), "--label", s["label"]]
    return _spawn(cmd, out, {"strategy": strategy}, wait)


# Stops of the stress sliders, as in tools/backtest.py STRESS_STOPS (None = the push never decays within the day).
STRESS_STOPS = {"half_life": [0, 1, 10, 100, 1000, None], "share": [1.0, 0.75, 0.5, 0.25, 0.1], "delay": [0, 1]}


def stress_label(half_life: float | None, share: float, delay: int) -> str:
    return f"h{'inf' if half_life is None else f'{half_life:g}'}_s{round(share * 100)}_d{delay}"


def scenario(run_id: str, half_life: float | None, share: float, delay: int, wait: bool = False) -> dict:
    """A stress scenario of a website run: done at once if it was replayed before, otherwise a job that replays it."""
    if half_life not in STRESS_STOPS["half_life"] or float(share) not in STRESS_STOPS["share"] or int(delay) not in STRESS_STOPS["delay"]:
        raise ValueError(f"not a stress stop: h={half_life} share={share} delay={delay}")
    d = resolve_run(run_id)
    meta = json.loads((d / "meta.json").read_text())
    if meta.get("stress"):
        raise ValueError("pick the website run, not a scenario of it")
    lab = stress_label(half_life, float(share), int(delay))
    out = d / "stress" / lab
    if (out / "meta.json").exists():
        return {"status": "done", "run_id": f"{run_id}/stress/{lab}"}
    arg = f"h={'inf' if half_life is None else f'{half_life:g}'},share={float(share):g},delay={int(delay)}"
    cmd = [sys.executable, str(root() / "tools" / "backtest.py"), str(root() / meta["path"]), "--out", str(out),
           "--label", meta.get("label") or "", "--stress", arg]
    return _spawn(cmd, out, {"strategy": meta.get("path"), "scenario": lab}, wait)


def job(job_id: str) -> dict | None:
    with _jobs_lock:
        j = _jobs.get(job_id)
        return dict(j) if j else None


# ------------------------------------------------------------------------------------- run files -> trades
def _load(d: Path) -> tuple[dict, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    meta = json.loads((d / "meta.json").read_text())
    fills = pd.read_csv(d / "fills.csv")
    eq = pd.read_csv(d / "equity.csv")
    g = pd.read_csv(d / "greeks.csv") if (d / "greeks.csv").exists() else pd.DataFrame()
    return meta, fills, eq, g


def _effective(fills: pd.DataFrame) -> pd.DataFrame:
    """Fills with their settlement price as float (a stress scenario's takes include the fractional push)."""
    f = fills.reset_index(drop=True).copy()
    f["px"] = f["price"].astype(float)
    return f


def _product_days(fills: pd.DataFrame, days: list[int]) -> dict:
    """(product, day) -> per-tick arrays: timestamps, times, mids, position, cash, mark-to-market, fill tick index."""
    out = {}
    for (p, day), g in fills.groupby(["product", "day"], sort=False):
        t = ticks(p, day)
        if t is None:
            continue
        ts, tm, mid = t
        idx = np.searchsorted(ts, g["timestamp"].to_numpy())
        qty = np.zeros(len(ts))
        cash = np.zeros(len(ts))
        np.add.at(qty, idx, g["qty"].to_numpy(dtype=float))
        np.add.at(cash, idx, -(g["qty"] * g["px"]).to_numpy(dtype=float))
        pos, csum = np.cumsum(qty), np.cumsum(cash)
        out[(p, day)] = {"ts": ts, "time": tm, "mid": mid, "pos": pos, "cash": csum, "mtm": csum + pos * mid,
                         "idx": dict(zip(g.index, idx))}
    return out


def _trips(fills: pd.DataFrame, pdays: dict, last_day: int) -> tuple[list[dict], list[dict]]:
    """Holding periods per product and day, and the operations (one per fill, plus day-end closes)."""
    trips: list[dict] = []
    ops: list[dict] = []
    for (p, day), arr in pdays.items():
        pos, trip = 0, None
        g = fills[(fills["product"] == p) & (fills["day"] == day)]
        for i, r in zip(g.index, g.itertuples()):
            k = arr["idx"][i]
            left, px = int(r.qty), float(r.px)
            while left:
                sign = 1 if left > 0 else -1
                if pos == 0:
                    trip = {"product": p, "day": day, "side": "long" if sign > 0 else "short", "entry_ts": int(r.timestamp),
                            "entry_k": int(k), "entry_price": px, "cash": 0.0, "max_pos": 0}
                take = left if pos == 0 or (pos > 0) == (sign > 0) else sign * min(abs(left), abs(pos))
                before = pos
                pos += take
                left -= take
                trip["cash"] -= take * px
                trip["max_pos"] = max(trip["max_pos"], abs(pos))
                long_ = trip["side"] == "long"
                if before == 0:
                    act = "buy" if long_ else "short"
                elif pos == 0:
                    act = "sell" if long_ else "cover"
                elif abs(pos) > abs(before):
                    act = "add" if long_ else "short_add"
                else:
                    act = "trim" if long_ else "cover_trim"
                op = {"product": p, "day": day, "ts": int(r.timestamp), "k": int(k), "action": act, "qty": take, "price": px,
                      "position": pos, "trip_pnl": None, "kind": r.kind}
                if pos == 0:
                    op["trip_pnl"] = trips_close(trips, trip, arr, int(r.timestamp), int(k), px, False, "")
                    trip = None
                ops.append(op)
        if pos != 0:                                    # still held at the day's close: marked at the last mid
            k = len(arr["ts"]) - 1
            last = day == last_day
            pnl = trips_close(trips, trip, arr, int(arr["ts"][k]), k, float(arr["mid"][k]), last, "Day end · mid", pos)
            ops.append({"product": p, "day": day, "ts": int(arr["ts"][k]), "k": k, "action": "open" if last else "dayend",
                        "qty": 0, "price": float(arr["mid"][k]), "position": pos if last else 0, "trip_pnl": pnl, "kind": ""})
    trips.sort(key=lambda t: (t["day"], t["entry_ts"], t["product"]))
    ops.sort(key=lambda o: (o["day"], o["ts"]))
    return trips, ops


def trips_close(trips: list, trip: dict, arr: dict, ts: int, k: int, px: float, open_: bool, why: str, pos: int = 0) -> float:
    pnl = trip["cash"] + pos * px
    a = trip["entry_k"]
    base = arr["mtm"][a - 1] if a > 0 else 0.0
    path = arr["mtm"][a:k + 1] - base
    trips.append({**trip, "exit_ts": ts, "exit_k": k, "exit_price": px, "pnl": pnl, "open": open_, "exit_label": why,
                  "runup": float(max(path.max(), 0.0)) if len(path) else 0.0,
                  "drawdown": float(min(path.min(), 0.0)) if len(path) else 0.0, "ticks": k - a + 1})
    return pnl


# ------------------------------------------------------------------------------------- statistics
def _ratios(vals: np.ndarray) -> tuple[float | None, float | None]:
    steps = vals[BLOCK::BLOCK] - vals[:-BLOCK:BLOCK]
    if len(steps) < 2:
        return None, None
    sd = steps.std(ddof=1)
    down = float(np.sqrt(np.mean(np.minimum(steps, 0.0) ** 2)))
    scale = np.sqrt(TICKS_PER_DAY / BLOCK)
    return (_f(steps.mean() / sd * scale) if sd else None), (_f(steps.mean() / down * scale) if down else None)


def _max_dd(vals: np.ndarray) -> float:
    v = np.concatenate([[0.0], vals])
    return float((np.maximum.accumulate(v) - v).max())


def _curve(eq: pd.DataFrame) -> np.ndarray:
    return eq["pnl"].to_numpy(dtype=float)


def _keep(eq: pd.DataFrame) -> np.ndarray:
    """Rows kept in drawn curves: every SERIES_EVERY-th tick of each day plus its last."""
    n = eq.groupby("day").cumcount().to_numpy()
    last = ~eq["day"].duplicated(keep="last").to_numpy()
    return (n % SERIES_EVERY == 0) | last


def _r(x, nd=6):
    return None if x is None else round(float(x), nd)


@lru_cache(maxsize=16)
def _report_cached(d: str, mtime: float) -> dict:
    return _plain(_build(Path(d)))


def report(run_id: str) -> dict:
    d = resolve_run(run_id)
    return _report_cached(str(d), (d / "meta.json").stat().st_mtime)


def _website(d: Path) -> dict | None:
    """The website run a scenario folder (<run>/stress/<label>) was made from, as numbers to show beside it."""
    base = d.parent.parent
    if d.parent.name != "stress" or not (base / "meta.json").exists():
        return None
    eq = pd.read_csv(base / "equity.csv")
    curve = _curve(eq)
    keep = _keep(eq)
    s = json.loads((base / "meta.json").read_text()).get("summary", {})
    rel = base.resolve().relative_to(runs_root().resolve()).as_posix()
    return {"run": f"quantifi:{rel}", "total_pnl": float(curve[-1]) if len(curve) else 0.0, "max_drawdown": _max_dd(curve),
            "sharpe": _ratios(curve)[0], "fills": s.get("fills"),
            "series": {"time": time_of(eq["day"].to_numpy(), eq["timestamp"].to_numpy())[keep].astype(int).tolist(),
                       "pnl": [_r(x, 4) for x in curve[keep]]}}


def _build(d: Path) -> dict:
    meta, fills_raw, eq, greeks = _load(d)
    days = [int(x) for x in meta.get("days") or sorted(eq["day"].unique())]
    fills = _effective(fills_raw)
    pdays = _product_days(fills, days)
    trips, _ = _trips(fills, pdays, max(days))
    curve = _curve(eq)
    keep = _keep(eq)
    times = time_of(eq["day"].to_numpy(), eq["timestamp"].to_numpy())
    peak = np.maximum.accumulate(np.concatenate([[0.0], curve]))[1:]
    sharpe, sortino = _ratios(curve)
    total = float(curve[-1]) if len(curve) else 0.0

    closed = [t for t in trips if not t["open"]]
    pnls = [t["pnl"] for t in trips]
    ret = [t["pnl"] / (t["max_pos"] * t["entry_price"]) if t["max_pos"] and t["entry_price"] else 0.0 for t in trips]
    gp = float(sum(x for x in pnls if x > 0))
    gl = float(-sum(x for x in pnls if x < 0))
    wins = [t["pnl"] > 0 for t in sorted(closed, key=lambda t: (t["day"], t["exit_ts"]))]
    push_cost = float(fills["push"].sum()) if "push" in fills else 0.0

    by_prod: dict[str, float] = {}
    for (p, _day), arr in pdays.items():
        by_prod[p] = by_prod.get(p, 0.0) + float(arr["mtm"][-1])
    day_end = eq.groupby("day", sort=True).tail(1)
    ends = dict(zip(day_end["day"], curve[day_end.index]))
    prev, by_day = 0.0, []
    n_fills = fills.groupby("day").size().to_dict()
    for day in days:
        v = float(ends.get(day, prev))
        by_day.append({"day": day, "pnl": _r(v - prev, 4), "fills": int(n_fills.get(day, 0))})
        prev = v

    r = np.array(ret) if ret else np.array([])
    edges = np.linspace(np.floor(r.min() * 20) / 20, np.ceil(r.max() * 20) / 20, 21) if r.size > 1 else np.array([0, 1])
    hist, _ = np.histogram(r, bins=edges) if r.size else (np.array([]), None)
    bounds = [{"day": int(day), "start": int(time_of(day, 0)), "end": int(time_of(day, (TICKS_PER_DAY - 1) * 100))} for day in days]

    s = meta.get("summary", {})
    q = {
        "stress": meta.get("stress"), "label": meta.get("label"), "path": meta.get("path"), "created": meta.get("created"),
        "seconds": meta.get("seconds"), "days": days, "tte": meta.get("tte"), "sharpe": sharpe, "sortino": sortino,
        "fills": int(len(fills)), "volume": int(fills["qty"].abs().sum()) if len(fills) else 0,
        "taken_fills": int((fills["kind"] == "take").sum()) if len(fills) else 0,
        "resting_fills": int((fills["kind"] == "passive").sum()) if len(fills) else 0,
        "taken_volume": int(fills.loc[fills["kind"] == "take", "qty"].abs().sum()) if len(fills) else 0,
        "push_cost": push_cost, "rejected": meta.get("rejected", 0), "errors": meta.get("errors", 0),
        "first_error": meta.get("first_error", ""), "website": _website(d),
        "by_day": by_day, "lambda": {p: meta.get("lambda", {}).get(p) for p in sorted(by_prod)},
        "constants": meta.get("constants", {}), "has_greeks": bool(meta.get("has_greeks")) and not greeks.empty,
        "day_bounds": bounds, "summary_engine": s,
    }
    if q["has_greeks"]:
        gt = time_of(greeks["day"].to_numpy(), greeks["timestamp"].to_numpy())
        q["greeks"] = {"time": gt.astype(int).tolist(),
                       **{c: [_r(x, 4) for x in greeks[c]] for c in ("spot", "opt_delta", "lychee", "net_delta", "gamma", "vega", "theta")}}

    def trow(i: int, t: dict) -> dict:
        qty = t["max_pos"]
        return {"n": i + 1, "instrument": t["product"], "symbol": PREFIX + t["product"], "name": "", "side": t["side"],
                "entry_label": "", "exit_label": t["exit_label"],
                "entry_time": int(time_of(t["day"], t["entry_ts"])), "exit_time": int(time_of(t["day"], t["exit_ts"])),
                "entry_date": label(t["day"], t["entry_ts"]), "exit_date": label(t["day"], t["exit_ts"]),
                "entry_price": _r(t["entry_price"]), "qty": qty, "exit_price": _r(t["exit_price"]), "pnl": _r(t["pnl"]),
                "return_pct": _r(t["pnl"] / (qty * t["entry_price"])) if qty and t["entry_price"] else None,
                "bars": t["ticks"], "open": t["open"], "max_value": _r(qty * t["entry_price"], 2), "stale": False,
                "runup": _r(t["runup"]), "drawdown": _r(t["drawdown"])}

    return {
        "meta": {"kind": "quantifi", "name": f"{meta.get('label')} · {d.name}", "symbol": None, "timeframe": "1",
                 "start": label(days[0], 0), "end": label(days[-1], (TICKS_PER_DAY - 1) * 100), "initial_capital": 0,
                 "currency": "COINS", "pool": meta.get("label"), "signal": meta.get("path"), "topk": None, "rebalance_days": None,
                 "open_cost": None, "close_cost": None, "benchmark": None, "config": {"rules": meta.get("rules")}},
        "key_stats": {"total_pnl": total, "total_pnl_pct": None, "max_drawdown": _max_dd(curve), "max_drawdown_pct": None,
                      "profitable_pct": _f(sum(wins) / len(closed)) if closed else None, "wins": int(sum(wins)),
                      "closed_trades": len(closed), "profit_factor": _f(gp / gl) if gl else None},
        "series": {"time": times[keep].astype(int).tolist(), "pnl": [_r(x, 4) for x in curve[keep]],
                   "buy_hold_pnl": [], "drawdown": [_r(x, 4) for x in (curve - peak)[keep]], "drawdown_pct": []},
        "breakdown": {"gross_profit": gp, "gross_loss": gl, "commission": 0.0,
                      "net_pnl_trades": gp - gl, "unattributed": _f(total - (gp - gl)), "stale_trades": 0,
                      "profits_by_instrument": sorted(({"instrument": p, "symbol": PREFIX + p, "name": "", "pnl": _r(v, 4)}
                                                       for p, v in by_prod.items()), key=lambda x: -x["pnl"])},
        "periodical": {"cagr": None, "total_return": None, "sharpe": sharpe, "sortino": sortino,
                       "monthly": [], "quarterly": [], "yearly": []},
        "benchmarking": {"strategy_return": None, "buy_hold_return": None, "outperformance": None, "correlation": None},
        "growth_decline": {"avg_runup_days": None, "avg_drawdown_days": None, "max_drawdown_of_initial": None,
                           "runup": {"max": None, "avg": None}, "drawdown": {"max": None, "avg": None, "current": None},
                           "runups": [], "drawdowns": []},
        "distribution": {
            "expectancy": _f(np.mean(pnls)) if pnls else None, "expectancy_pct": _f(np.mean(ret)) if ret else None,
            "largest_profit": _f(max(pnls, default=None)), "largest_loss": _f(min(pnls, default=None)),
            "avg_profit_pct": _f(np.mean([x for x in ret if x > 0])) if any(x > 0 for x in ret) else None,
            "avg_loss_pct": _f(np.mean([x for x in ret if x < 0])) if any(x < 0 for x in ret) else None,
            "winners": sum(t["pnl"] > 0 for t in closed), "losers": sum(t["pnl"] < 0 for t in closed),
            "breakevens": sum(t["pnl"] == 0 for t in closed), "open": len(trips) - len(closed),
            "histogram": {"edges": [float(x) for x in edges], "counts": [int(x) for x in hist]}},
        "streaks": _streaks(wins),
        "time_patterns": {"by_entry_weekday": [], "by_month": []},
        "trades": [trow(i, t) for i, t in enumerate(trips)],
        "quantifi": q,
    }


# ------------------------------------------------------------------------------------- one product
@lru_cache(maxsize=16)
def _instrument_cached(d: str, mtime: float, product: str) -> dict:
    return _plain(_instrument(Path(d), product))


def instrument_detail(run_id: str, product: str) -> dict:
    d = resolve_run(run_id)
    return _instrument_cached(str(d), (d / "meta.json").stat().st_mtime, product)


def _instrument(d: Path, product: str) -> dict:
    meta, fills_raw, _eq, _g = _load(d)
    days = [int(x) for x in meta.get("days") or sorted(fills_raw["day"].unique())]
    fills = _effective(fills_raw[fills_raw["product"] == product])
    if fills.empty:
        raise KeyError(product)
    pdays = _product_days(fills, days)
    trips, ops = _trips(fills, pdays, max(days))

    carry, series_t, series_v, carry_at = 0.0, [], [], {}
    for day in days:
        arr = pdays.get((product, day))
        if arr is None:
            continue
        carry_at[day] = carry
        n = len(arr["ts"])
        keep = (np.arange(n) % SERIES_EVERY == 0) | (np.arange(n) == n - 1)
        series_t += arr["time"][keep].astype(int).tolist()
        series_v += [_r(x, 4) for x in (carry + arr["mtm"])[keep]]
        carry += float(arr["mtm"][-1])

    out_ops = []
    for o in ops:
        arr = pdays[(product, o["day"])]
        out_ops.append({"date": label(o["day"], o["ts"]), "time": int(time_of(o["day"], o["ts"])), "action": o["action"],
                        "qty": o["qty"], "price": _r(o["price"]), "value": _r(o["qty"] * o["price"], 2), "position": o["position"],
                        "cum_pnl": _r(carry_at[o["day"]] + arr["mtm"][o["k"]], 4), "trip_pnl": _r(o["trip_pnl"], 4),
                        "kind": o["kind"]})
    pnls = [t["pnl"] for t in trips]
    closed = [t for t in trips if not t["open"]]
    rets = [t["pnl"] / (t["max_pos"] * t["entry_price"]) for t in trips if t["max_pos"] and t["entry_price"]]
    last = trips[-1]
    fq = fills["qty"]
    summary = {
        "pnl": carry, "trips": len(trips), "closed": len(closed), "wins": sum(t["pnl"] > 0 for t in closed),
        "losses": sum(t["pnl"] < 0 for t in closed),
        "win_rate": (sum(t["pnl"] > 0 for t in closed) / len(closed)) if closed else None,
        "avg_return": float(np.mean(rets)) if rets else None, "best": max(pnls), "worst": min(pnls),
        "days_held": int(sum(t["ticks"] for t in trips)), "first": label(trips[0]["day"], trips[0]["entry_ts"]),
        "last": label(last["day"], last["exit_ts"]), "buys": int((fq > 0).sum()), "sells": int((fq < 0).sum()),
        "bought_value": float((fills["px"] * fq)[fq > 0].sum()), "sold_value": float(-(fills["px"] * fq)[fq < 0].sum()),
        "open_qty": float(ops[-1]["position"]) if last["open"] else 0.0,
        "open_value": float(ops[-1]["position"] * last["exit_price"]) if last["open"] else 0.0,
        "open_pnl": float(last["pnl"]) if last["open"] else 0.0,
    }
    return {
        "kind": "quantifi", "instrument": product, "symbol": PREFIX + product, "name": "", "summary": summary,
        "trips": [{"entry_date": label(t["day"], t["entry_ts"]), "entry_time": int(time_of(t["day"], t["entry_ts"])),
                   "entry_price": _r(t["entry_price"]), "qty": t["max_pos"], "side": t["side"],
                   "exit_date": label(t["day"], t["exit_ts"]), "exit_time": int(time_of(t["day"], t["exit_ts"])),
                   "exit_price": _r(t["exit_price"]), "pnl": _r(t["pnl"]),
                   "return_pct": _r(t["pnl"] / (t["max_pos"] * t["entry_price"])) if t["max_pos"] and t["entry_price"] else None,
                   "days": t["ticks"], "open": t["open"], "max_value": _r(t["max_pos"] * t["entry_price"], 2),
                   "runup": _r(t["runup"]), "drawdown": _r(t["drawdown"]), "stale": False} for t in trips],
        "operations": out_ops,
        "pnl_path": [],
        "pnl_series": {"time": series_t, "value": series_v},
        "lambda": meta.get("lambda", {}).get(product),
        "push_cost": float(fills["push"].sum()) if "push" in fills else 0.0,
    }


# ------------------------------------------------------------------------------------- chart overlay
PALETTE = ["#FF9800", "#9C27B0", "#00BCD4", "#E91E63", "#795548", "#3949AB"]
MAX_PANES = 4          # strategy numbers beyond this many own panes are left off the chart


def _owner(key: str, names: set[str]) -> str | None:
    """Which product an indicator key belongs to: a segment naming it, a voucher strike, or a unique prefix (tel ->
    TELLURIUM). None: the key is about the whole strategy."""
    parts = key.split(".")
    if parts[0] == "quote" and len(parts) >= 3:
        return ".".join(parts[2:])
    for seg in parts:
        if seg.upper() in names:
            return seg.upper()
    for seg in parts:
        if seg.isdigit() and f"VOUCHER_{seg}" in names:
            return f"VOUCHER_{seg}"
    for seg in parts:
        hits = [n for n in names if len(seg) >= 3 and n.startswith(seg.upper())]
        if len(hits) == 1:
            return hits[0]
    return None


def _label(key: str, owner: str | None) -> str:
    parts = [p for p in key.split(".") if not owner or (p.upper() != owner and f"VOUCHER_{p}" != owner and not owner.startswith(p.upper()))]
    return ".".join(parts) or key


def _changes(day_rows: list[tuple[int, np.ndarray, np.ndarray]]) -> tuple[list[int], list]:
    """Per-tick values (several days) as change points, each day restated at its first tick."""
    times, vals = [], []
    for _day, tm, v in day_rows:
        keep = np.ones(len(v), dtype=bool)
        keep[1:] = v[1:] != v[:-1]
        times += tm[keep].astype(int).tolist()
        vals += [_r(x, 4) for x in v[keep]]
    return times, vals


@lru_cache(maxsize=16)
def _overlay_cached(d: str, mtime: float, product: str) -> dict:
    return _plain(_overlay(Path(d), product))


def overlay(run_id: str, product: str) -> dict:
    """What the upper chart draws for one product of a run: the book's best bid and ask, the strategy's quotes, its
    position, and the numbers it keeps (traderData / Trader.plots) that belong to this product or to the whole strategy.
    Lines come as change points (unix seconds); price-like numbers share the price pane, the rest get their own."""
    d = resolve_run(run_id)
    return _overlay_cached(str(d), (d / "meta.json").stat().st_mtime, product)


def _overlay(d: Path, product: str) -> dict:
    meta = json.loads((d / "meta.json").read_text())
    days = [int(x) for x in meta.get("days") or []]
    fills = pd.read_csv(d / "fills.csv")
    traded = set(fills["product"].unique())
    names = set(products())
    lines: list[dict] = []
    arrays = {day: _tick_arrays(product, day) for day in days}
    arrays = {k: v for k, v in arrays.items() if v is not None}
    for side, col in (("bid", 3), ("ask", 4)):
        t, v = _changes([(day, a[1], a[col]) for day, a in arrays.items()])
        lines.append({"group": "Book", "label": side, "pane": "price", "style": "step", "color": "#B2B5BE", "time": t, "value": v})

    pos_rows = []
    f = fills[fills["product"] == product]
    for day, a in arrays.items():
        g = f[f["day"] == day]
        q = np.zeros(len(a[0]))
        np.add.at(q, np.searchsorted(a[0], g["timestamp"].to_numpy()), g["qty"].to_numpy(dtype=float))
        pos_rows.append((day, a[1], np.cumsum(q)))
    t, v = _changes(pos_rows)
    lines.append({"group": "Position", "label": "position", "pane": "Position", "style": "step", "color": "#2962FF", "time": t, "value": v})

    path = d / "indicators.csv"
    ind = pd.read_csv(path) if path.exists() else pd.DataFrame(columns=["day", "timestamp", "key", "value"])
    panes, color = 0, 0
    for key, g in ind.groupby("key", sort=True):
        owner = _owner(str(key), names)
        if owner != product and not (owner is None and product in traded):
            continue
        g = g.sort_values(["day", "timestamp"], kind="stable")
        tm = time_of(g["day"].to_numpy(), g["timestamp"].to_numpy()).astype(int).tolist()
        vals = [None if pd.isna(x) else _r(x, 4) for x in g["value"]]
        if str(key).startswith("quote."):
            side = str(key).split(".")[1]
            lines.append({"group": "Your quotes", "label": side, "pane": "price", "style": "dots",
                          "color": "#2962FF" if side == "bid" else "#F23645", "time": tm, "value": vals})
            continue
        price_like = False
        ok = g["value"].notna().to_numpy()
        if ok.any() and arrays:
            mids = []
            for (day, ts) in zip(g["day"].to_numpy()[ok], g["timestamp"].to_numpy()[ok]):
                a = arrays.get(int(day))
                if a is not None:
                    mids.append(a[2][min(np.searchsorted(a[0], ts), len(a[0]) - 1)])
            if mids:
                m = np.asarray(mids)
                price_like = float(np.median(np.abs(g["value"].to_numpy(dtype=float)[ok][:len(m)] - m))) < 0.05 * float(np.median(np.abs(m)))
        label = _label(str(key), owner)
        if not price_like:
            if panes >= MAX_PANES:
                continue
            panes += 1
        lines.append({"group": label, "label": label, "pane": "price" if price_like else label,
                      "style": "line" if price_like or g["value"].nunique() > 12 else "step",
                      "color": PALETTE[color % len(PALETTE)], "time": tm, "value": vals})
        color += 1
    return {"run": f"quantifi:{d.parent.name}/{d.name}", "product": product, "symbol": PREFIX + product, "lines": lines}


def clear_caches() -> None:
    for fn in (_prices, _trade_volume, _paths_cache, _report_cached, _instrument_cached, _overlay_cached):
        fn.cache_clear()
