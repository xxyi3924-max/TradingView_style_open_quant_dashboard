"""Strategy-report metrics for a qlib run, structured like TradingView's Strategy Report.

Inputs are the engine's own files: report.csv (account equity, benchmark return, costs),
holdings.csv (daily positions at deal price) and config.json. Exit prices of round trips come from
the same qlib bins the engine traded on (close.day.bin), so per-trade P&L reconciles with the account:
    sum(trade P&L, gross) - commissions == final account - initial capital.
Trade P&L is gross of costs (TradingView shows commission separately as "commission load").
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

from . import config
from .symbols import qlib_to_tv

TRADING_DAYS = 252
DEFAULT_QLIB = config.WORK_QUANT / "etf_rotation" / "data" / "raw" / "qlib_data"


# ------------------------------------------------------------------------------------- qlib bins
@lru_cache(maxsize=4)
def _calendar(provider: str) -> list[str]:
    return pd.read_csv(Path(provider) / "calendars" / "day.txt", header=None)[0].astype(str).tolist()


@lru_cache(maxsize=4096)
def bin_close(provider: str, instrument: str) -> pd.Series:
    """qlib $close for one instrument (the engine's deal price with deal_price='close')."""
    path = Path(provider) / "features" / instrument.lower() / "close.day.bin"
    a = np.fromfile(path, dtype="<f4")
    start, values = int(a[0]), a[1:].astype("float64")
    cal = _calendar(provider)
    return pd.Series(values, index=cal[start:start + len(values)])


# ------------------------------------------------------------------------------------- trades
@dataclass
class Trade:
    instrument: str
    entry_date: str
    entry_price: float
    entry_qty: float
    exit_date: str
    exit_price: float
    pnl: float
    open: bool
    bars: int
    max_value: float
    stale: bool = False      # engine carried a stale price on the last held day (suspended / backfilled data)
    runup: float = 0.0       # best mark-to-market P&L while held (favorable excursion, >= 0)
    drawdown: float = 0.0    # worst mark-to-market P&L while held (adverse excursion, <= 0)


def round_trips(holdings: pd.DataFrame, dates: list[str], provider: str) -> list[Trade]:
    """Continuous holding periods per instrument. P&L sums amount[t-1] * (price[t] - price[t-1]),
    which accounts for resizing; the exit day is priced at that day's bin close."""
    h = holdings[holdings["amount"] > 0]
    by_inst = {k: g.set_index("date").sort_index() for k, g in h.groupby("instrument")}
    pos = {d: i for i, d in enumerate(dates)}
    out: list[Trade] = []
    for inst, g in by_inst.items():
        held = g.index.tolist()
        # split into runs of consecutive trading dates
        runs, cur = [], [held[0]]
        for a, b in zip(held, held[1:]):
            if pos[b] == pos[a] + 1:
                cur.append(b)
            else:
                runs.append(cur)
                cur = [b]
        runs.append(cur)
        closes = None
        for run in runs:
            amt, px = g.loc[run, "amount"].to_numpy(), g.loc[run, "price"].to_numpy()
            path = np.concatenate([[0.0], np.cumsum(amt[:-1] * np.diff(px))])   # mark-to-market P&L per held day
            pnl = float(path[-1])
            last_i = pos[run[-1]]
            is_open = last_i == len(dates) - 1
            stale = False
            if is_open:
                exit_date, exit_px = run[-1], float(px[-1])
            else:
                exit_date = dates[last_i + 1]
                if closes is None:
                    closes = bin_close(provider, inst)
                last_close = float(closes.get(run[-1], np.nan))
                stale = not np.isfinite(last_close) or abs(last_close - px[-1]) > 1e-6 * max(abs(px[-1]), 1.0)
                exit_px = float(closes.get(exit_date, np.nan))
                if not np.isfinite(exit_px):      # suspended on the exit day: carry the last price
                    exit_px = float(px[-1])
                pnl += float(amt[-1] * (exit_px - px[-1]))
                path = np.append(path, pnl)
            out.append(Trade(inst, run[0], float(px[0]), float(amt[0]), exit_date, exit_px, pnl, is_open,
                             len(run), float(np.max(amt * px)), stale,
                             runup=float(max(path.max(), 0.0)), drawdown=float(min(path.min(), 0.0))))
    out.sort(key=lambda t: (t.entry_date, t.instrument))
    return out


# ------------------------------------------------------------------------------------- helpers
def _episodes(equity: pd.Series) -> tuple[list[dict], list[dict]]:
    """Drawdowns: peak -> trough -> recovery (the last one may be unrecovered).
    Run-ups: trough (or the start) -> the peak where the next drawdown begins (or the end)."""
    v = equity.to_numpy(dtype="float64")
    d = pd.to_datetime(equity.index)
    drawdowns: list[dict] = []
    peak_i, trough_i, in_dd = 0, 0, False
    for i in range(1, len(v)):
        if v[i] >= v[peak_i]:
            if in_dd:
                drawdowns.append({"peak": peak_i, "trough": trough_i, "recovered": i})
                in_dd = False
            peak_i = trough_i = i
        else:
            if not in_dd or v[i] < v[trough_i]:
                trough_i = i
            in_dd = True
    if in_dd:
        drawdowns.append({"peak": peak_i, "trough": trough_i, "recovered": None})
    dd_out = [{"start": str(d[x["peak"]].date()), "end": str(d[x["trough"]].date()),
               "pct": float(v[x["trough"]] / v[x["peak"]] - 1),
               "days": int(((d[x["recovered"]] if x["recovered"] is not None else d[-1]) - d[x["peak"]]).days),
               "recovered": str(d[x["recovered"]].date()) if x["recovered"] is not None else None} for x in drawdowns]
    lows = [0] + [x["trough"] for x in drawdowns]
    highs = [x["peak"] for x in drawdowns] + [len(v) - 1]
    runups = [{"start": str(d[lo].date()), "end": str(d[hi].date()), "pct": float(v[hi] / v[lo] - 1),
               "days": int((d[hi] - d[lo]).days)} for lo, hi in zip(lows, highs) if hi > lo and v[hi] > v[lo]]
    return runups, dd_out


def _streaks(wins: list[bool]) -> dict:
    best = {True: 0, False: 0}
    lens = {True: [], False: []}
    cur, run = None, 0
    for w in wins + [None]:
        if w == cur:
            run += 1
            continue
        if cur is not None:
            lens[cur].append(run)
            best[cur] = max(best[cur], run)
        cur, run = w, 1
    return {"max_win": best[True], "max_loss": best[False],
            "avg_win": float(np.mean(lens[True])) if lens[True] else 0.0,
            "avg_loss": float(np.mean(lens[False])) if lens[False] else 0.0}


def _period_returns(nav: pd.Series, bench: pd.Series, freq: str) -> list[dict]:
    idx = pd.to_datetime(nav.index)
    s = pd.Series(nav.to_numpy(), index=idx).resample(freq).last()
    b = pd.Series(bench.to_numpy(), index=idx).resample(freq).last()
    first_s, first_b = nav.iloc[0], bench.iloc[0]
    rs = s.pct_change()
    rb = b.pct_change()
    rs.iloc[0] = s.iloc[0] / first_s - 1
    rb.iloc[0] = b.iloc[0] / first_b - 1
    label = {"ME": "%Y-%m", "QE": "%Y-Q", "YE": "%Y"}[freq]
    out = []
    for t, x, y in zip(rs.index, rs.to_numpy(), rb.to_numpy()):
        name = f"{t.year}-Q{(t.month - 1) // 3 + 1}" if freq == "QE" else t.strftime(label)
        out.append({"period": name, "strategy": float(x), "benchmark": float(y)})
    return out


def _f(x):
    if x is None:
        return None
    x = float(x)
    return x if np.isfinite(x) else None


def _plain(x):
    """Recursively convert numpy scalars to JSON-safe Python values (NaN/inf -> None)."""
    if isinstance(x, dict):
        return {k: _plain(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_plain(v) for v in x]
    if isinstance(x, (np.bool_, bool)):
        return bool(x)
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.floating, float)):
        return float(x) if np.isfinite(x) else None
    return x


# ------------------------------------------------------------------------------------- report
def build(run_dir: Path) -> dict:
    return _plain(_build(run_dir))


def _build(run_dir: Path) -> dict:
    cfg = json.loads((run_dir / "config.json").read_text()) if (run_dir / "config.json").exists() else {}
    rep = pd.read_csv(run_dir / "report.csv", index_col=0).sort_index()
    rep.index = rep.index.astype(str).str[:10]
    holdings = pd.read_csv(run_dir / "holdings.csv", encoding="utf-8-sig") if (run_dir / "holdings.csv").exists() \
        else pd.DataFrame(columns=["date", "instrument", "amount", "price", "name"])
    holdings["date"] = holdings["date"].astype(str).str[:10]
    provider = str(cfg.get("provider_uri") or DEFAULT_QLIB)
    initial = float(cfg.get("account") or rep["account"].iloc[0])
    currency = "USD" if cfg.get("market_region") == "us" else "CNY"

    equity = rep["account"].astype(float)
    dates = equity.index.tolist()
    rets = equity.pct_change().fillna(equity.iloc[0] / initial - 1)
    bench_ret = rep["bench"].fillna(0.0).astype(float)
    bench_nav = initial * (1 + bench_ret).cumprod()
    pnl = equity - initial
    peak = equity.cummax()
    dd_abs = equity - peak
    dd_pct = equity / peak - 1
    commission = float(rep["total_cost"].iloc[-1]) if "total_cost" in rep else 0.0

    trades = round_trips(holdings, dates, provider) if not holdings.empty else []
    closed = [t for t in trades if not t.open]
    ret_pct = [t.pnl / (t.entry_qty * t.entry_price) for t in trades]
    gross_profit = float(sum(t.pnl for t in trades if t.pnl > 0))
    gross_loss = float(-sum(t.pnl for t in trades if t.pnl < 0))
    wins = [t.pnl > 0 for t in closed]
    n_closed = len(closed)
    years = max((pd.Timestamp(dates[-1]) - pd.Timestamp(dates[0])).days / 365.25, 1e-9)
    total_return = float(equity.iloc[-1] / initial - 1)
    daily_std = float(rets.std(ddof=1))
    downside = float(np.sqrt(np.mean(np.minimum(rets.to_numpy(), 0) ** 2)))
    runups, drawdowns = _episodes(equity)
    names = holdings.drop_duplicates("instrument").set_index("instrument")["name"].to_dict() if "name" in holdings else {}

    by_inst: dict[str, float] = {}
    for t in trades:
        by_inst[t.instrument] = by_inst.get(t.instrument, 0.0) + t.pnl
    profits_by_instrument = sorted(({"instrument": k, "symbol": qlib_to_tv(k), "name": names.get(k, ""), "pnl": v}
                                    for k, v in by_inst.items()), key=lambda r: r["pnl"], reverse=True)

    r = np.array(ret_pct) if ret_pct else np.array([])
    hist_edges = np.linspace(np.floor(r.min() * 20) / 20, np.ceil(r.max() * 20) / 20, 21) if r.size > 1 else np.array([0, 1])
    hist, _ = np.histogram(r, bins=hist_edges) if r.size else (np.array([]), None)
    entry_wd = pd.Series([pd.Timestamp(t.entry_date).day_name()[:3] for t in trades], dtype="object")
    by_weekday = [{"key": k, "avg_return": _f(np.mean([x for x, w in zip(ret_pct, entry_wd) if w == k])) if (entry_wd == k).any() else None,
                   "trades": int((entry_wd == k).sum())} for k in ["Mon", "Tue", "Wed", "Thu", "Fri"]]
    mret = pd.Series(rets.to_numpy(), index=pd.to_datetime(dates))
    by_month = [{"key": m, "avg_daily_return": _f(mret[mret.index.month == i + 1].mean())}
                for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])]

    times = (pd.to_datetime(dates).astype("int64") // 1_000_000_000).astype(int).tolist()
    return {
        "meta": {"name": run_dir.name, "start": dates[0], "end": dates[-1], "initial_capital": initial, "currency": currency,
                 "pool": cfg.get("pool"), "signal": cfg.get("signal"), "topk": cfg.get("topk"),
                 "rebalance_days": cfg.get("rebalance_days"), "open_cost": cfg.get("open_cost"),
                 "close_cost": cfg.get("close_cost"), "benchmark": cfg.get("benchmark"), "config": cfg},
        "key_stats": {
            "total_pnl": _f(pnl.iloc[-1]), "total_pnl_pct": total_return,
            "max_drawdown": _f(-dd_abs.min()), "max_drawdown_pct": _f(-dd_pct.min()),
            "profitable_pct": _f(sum(wins) / n_closed) if n_closed else None, "wins": int(sum(wins)), "closed_trades": n_closed,
            "profit_factor": _f(gross_profit / gross_loss) if gross_loss else None,
        },
        "series": {"time": times, "pnl": [_f(x) for x in pnl], "buy_hold_pnl": [_f(x) for x in bench_nav - initial],
                   "drawdown": [_f(x) for x in dd_abs], "drawdown_pct": [_f(x) for x in dd_pct]},
        "breakdown": {"gross_profit": gross_profit, "gross_loss": gross_loss, "commission": commission,
                      "net_pnl_trades": gross_profit - gross_loss - commission,
                      # account P&L the trade list cannot explain; 0 unless the engine priced positions stale
                      "unattributed": _f(pnl.iloc[-1] - (gross_profit - gross_loss - commission)),
                      "stale_trades": sum(t.stale for t in trades),
                      "profits_by_instrument": profits_by_instrument},
        "periodical": {
            "cagr": _f((equity.iloc[-1] / initial) ** (1 / years) - 1), "total_return": total_return,
            "sharpe": _f(rets.mean() / daily_std * np.sqrt(TRADING_DAYS)) if daily_std else None,
            "sortino": _f(rets.mean() / downside * np.sqrt(TRADING_DAYS)) if downside else None,
            "monthly": _period_returns(equity, bench_nav, "ME"), "quarterly": _period_returns(equity, bench_nav, "QE"),
            "yearly": _period_returns(equity, bench_nav, "YE"),
        },
        "benchmarking": {"strategy_return": total_return, "buy_hold_return": _f(bench_nav.iloc[-1] / initial - 1),
                         "outperformance": _f(total_return - (bench_nav.iloc[-1] / initial - 1)),
                         "correlation": _f(np.corrcoef(rets, bench_ret)[0, 1])
                         if len(rets) > 2 and rets.std() > 0 and bench_ret.std() > 0 else None},
        "growth_decline": {
            "avg_runup_days": _f(np.mean([x["days"] for x in runups])) if runups else None,
            "avg_drawdown_days": _f(np.mean([x["days"] for x in drawdowns])) if drawdowns else None,
            "max_drawdown_of_initial": _f(-dd_abs.min() / initial),
            "runup": {"max": _f(max((x["pct"] for x in runups), default=None)),
                      "avg": _f(np.mean([x["pct"] for x in runups])) if runups else None},
            "drawdown": {"max": _f(min((x["pct"] for x in drawdowns), default=None)),
                         "avg": _f(np.mean([x["pct"] for x in drawdowns])) if drawdowns else None,
                         "current": _f(dd_pct.iloc[-1])},
            "runups": runups[-200:], "drawdowns": drawdowns[-200:],
        },
        "distribution": {
            "expectancy": _f(np.mean([t.pnl for t in trades])) if trades else None,
            "expectancy_pct": _f(np.mean(ret_pct)) if ret_pct else None,
            "largest_profit": _f(max((t.pnl for t in trades), default=None)),
            "largest_loss": _f(min((t.pnl for t in trades), default=None)),
            "avg_profit_pct": _f(np.mean([x for x in ret_pct if x > 0])) if any(x > 0 for x in ret_pct) else None,
            "avg_loss_pct": _f(np.mean([x for x in ret_pct if x < 0])) if any(x < 0 for x in ret_pct) else None,
            "winners": sum(1 for t in closed if t.pnl > 0), "losers": sum(1 for t in closed if t.pnl < 0),
            "breakevens": sum(1 for t in closed if t.pnl == 0), "open": len(trades) - n_closed,
            "histogram": {"edges": [float(x) for x in hist_edges], "counts": [int(x) for x in hist]},
        },
        "streaks": _streaks(wins),
        "time_patterns": {"by_entry_weekday": by_weekday, "by_month": by_month},
        "trades": [{"n": i + 1, "instrument": t.instrument, "symbol": qlib_to_tv(t.instrument), "name": names.get(t.instrument, ""),
                    "entry_date": t.entry_date, "entry_price": t.entry_price, "qty": t.entry_qty,
                    "exit_date": t.exit_date, "exit_price": t.exit_price, "pnl": t.pnl,
                    "return_pct": t.pnl / (t.entry_qty * t.entry_price), "bars": t.bars, "open": t.open,
                    "max_value": t.max_value, "stale": t.stale, "runup": t.runup, "drawdown": t.drawdown}
                   for i, t in enumerate(trades)],
    }


# ------------------------------------------------------------------------------------- one instrument
@lru_cache(maxsize=8)
def _holdings(path: str, mtime: float) -> pd.DataFrame:
    h = pd.read_csv(path, encoding="utf-8-sig")
    h["date"] = h["date"].astype(str).str[:10]
    return h


def instrument_detail(run_dir: Path, instrument: str) -> dict:
    """What the strategy did with one instrument: every operation (buy, add, trim, sell), its holding periods
    (round trips) and a P&L summary. Prices are the engine's daily valuation closes, the same marks the round-trip
    P&L uses (an exit is valued at the exit day's close), so the operations add up to the trips."""
    cfg = json.loads((run_dir / "config.json").read_text()) if (run_dir / "config.json").exists() else {}
    provider = str(cfg.get("provider_uri") or DEFAULT_QLIB)
    rep = pd.read_csv(run_dir / "report.csv", index_col=0).sort_index()
    dates = rep.index.astype(str).str[:10].tolist()
    hp = run_dir / "holdings.csv"
    h = _holdings(str(hp), hp.stat().st_mtime) if hp.exists() else pd.DataFrame(columns=["date", "instrument", "amount", "price"])
    g = h[(h["instrument"] == instrument) & (h["amount"] > 0)]
    if g.empty:
        raise KeyError(instrument)
    name = str(g["name"].iloc[0]) if "name" in g else ""
    trips = round_trips(g, dates, provider)
    pos = {d: i for i, d in enumerate(dates)}
    g = g.set_index("date").sort_index()

    ops: list[dict] = []
    path_by_date: dict[str, float] = {}         # daily mark-to-market cumulative P&L while held
    cum = 0.0                                   # realised P&L of finished holding periods
    for t in trips:
        run = [d for d in g.index if pos[t.entry_date] <= pos[d] <= pos[t.entry_date] + t.bars - 1]
        amt, px = g.loc[run, "amount"].to_numpy(dtype=float), g.loc[run, "price"].to_numpy(dtype=float)
        path = np.concatenate([[0.0], np.cumsum(amt[:-1] * np.diff(px))])
        for d, v in zip(run, path):
            path_by_date[d] = cum + float(v)
        path_by_date[t.exit_date] = cum + t.pnl
        prev = 0.0
        for i, d in enumerate(run):
            dq = amt[i] - prev
            if abs(dq) > 1e-9 * max(1.0, amt[i]):
                kind = "buy" if i == 0 else ("add" if dq > 0 else "trim")
                ops.append({"date": d, "action": kind, "qty": float(dq), "price": float(px[i]), "value": float(dq * px[i]),
                            "position": float(amt[i]), "cum_pnl": cum + float(path[i]), "trip_pnl": None})
            prev = amt[i]
        if not t.open:
            ops.append({"date": t.exit_date, "action": "sell", "qty": -float(amt[-1]), "price": t.exit_price,
                        "value": -float(amt[-1] * t.exit_price), "position": 0.0, "cum_pnl": cum + t.pnl, "trip_pnl": t.pnl})
        else:                                   # still held: mark it at the last date so the history ends at the total
            ops.append({"date": t.exit_date, "action": "open", "qty": 0.0, "price": t.exit_price, "value": 0.0,
                        "position": float(amt[-1]), "cum_pnl": cum + t.pnl, "trip_pnl": t.pnl})
        cum += t.pnl

    first_i = pos[trips[0].entry_date]
    pnl_path, last_v = [], 0.0
    for d in dates[first_i:]:                   # flat between holding periods
        last_v = path_by_date.get(d, last_v)
        pnl_path.append([d, last_v])
    pnls = [t.pnl for t in trips]
    closed = [t for t in trips if not t.open]
    rets = [t.pnl / (t.entry_qty * t.entry_price) for t in trips if t.entry_qty and t.entry_price]
    last = trips[-1]
    summary = {
        "pnl": float(sum(pnls)), "trips": len(trips), "closed": len(closed),
        "wins": sum(t.pnl > 0 for t in closed), "losses": sum(t.pnl < 0 for t in closed),
        "win_rate": (sum(t.pnl > 0 for t in closed) / len(closed)) if closed else None,
        "avg_return": float(np.mean(rets)) if rets else None,
        "best": float(max(pnls)), "worst": float(min(pnls)),
        "days_held": int(sum(t.bars for t in trips)), "first": trips[0].entry_date, "last": last.exit_date,
        "buys": sum(o["action"] in ("buy", "add") for o in ops), "sells": sum(o["action"] in ("trim", "sell") for o in ops),
        "bought_value": float(sum(o["value"] for o in ops if o["value"] > 0)),
        "sold_value": float(-sum(o["value"] for o in ops if o["value"] < 0)),
        "open_qty": float(g["amount"].iloc[-1]) if last.open else 0.0,
        "open_value": float(g["amount"].iloc[-1] * g["price"].iloc[-1]) if last.open else 0.0,
        "open_pnl": float(last.pnl) if last.open else 0.0,
    }
    return _plain({
        "instrument": instrument, "symbol": qlib_to_tv(instrument), "name": name, "summary": summary,
        "trips": [{"entry_date": t.entry_date, "entry_price": t.entry_price, "qty": t.entry_qty, "exit_date": t.exit_date,
                   "exit_price": t.exit_price, "pnl": t.pnl, "return_pct": t.pnl / (t.entry_qty * t.entry_price) if t.entry_qty and t.entry_price else None,
                   "days": t.bars, "open": t.open, "max_value": t.max_value, "runup": t.runup, "drawdown": t.drawdown, "stale": t.stale}
                  for t in trips],
        "operations": ops,
        "pnl_path": pnl_path,
    })
