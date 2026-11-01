"""Strategy Report for a Pine strategy run, in the same JSON shape as the qlib report (tvre.report) so the
dock renders both, plus TradingView-specific parts: P&L by signal and by side, chart markers, plots."""
from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ..report import _episodes, _f, _period_returns, _plain, _streaks
from .broker import LONG, Trade
from .runtime import RunResult


def _iso(t: int, intraday: bool) -> str:
    d = datetime.fromtimestamp(t, timezone.utc)
    return d.strftime("%Y-%m-%d %H:%M") if intraday else d.strftime("%Y-%m-%d")


def tv_ratios(closed: list[Trade], initial: float, rfr_annual_pct: float, open_pnl: float = 0.0,
              end_time: int | None = None) -> tuple[float | None, float | None]:
    """TradingView's Sharpe and Sortino: monthly returns of closed-trade equity (from the first exit; the open
    trade's P&L counts at the last bar) minus risk_free_rate / 12, over their population standard deviation /
    downside deviation, not annualized. Identical to TradingView on 36 of the 45 trade-exact parity runs and
    within ~1% on most others (re/STRATEGY_PARITY.md)."""
    if not closed:
        return None, None
    s = pd.Series([t.profit for t in closed], index=pd.to_datetime([t.exit_time for t in closed], unit="s"))
    if open_pnl and end_time is not None:
        s = pd.concat([s, pd.Series([open_pnl], index=pd.to_datetime([end_time], unit="s"))])
    m = (initial + s.sort_index().cumsum()).resample("ME").last().ffill()
    prev = np.concatenate([[initial], m.to_numpy()[:-1]])
    r = m.to_numpy() / prev - 1.0
    if len(r) < 2:
        return None, None
    ex = r - rfr_annual_pct / 100.0 / 12.0
    sd = r.std(ddof=0)
    dd = math.sqrt(np.mean(np.minimum(ex, 0.0) ** 2))
    return (_f(ex.mean() / sd) if sd else None), (_f(ex.mean() / dd) if dd else None)


def tv_max_drawdown(trades: list[Trade], initial: float) -> float:
    """TradingView's max drawdown: peaks of closed-trade equity, troughs including each trade's worst open
    loss (matches TradingView exactly on the parity runs)."""
    eq, peak, worst = initial, initial, 0.0
    for t in trades:
        worst = max(worst, peak - (eq + t.drawdown))
        eq += t.profit
        peak = max(peak, eq)
    return worst


def build(res: RunResult, symbol: str, timeframe: str, currency: str = "") -> dict:
    bars = res.bars
    intraday = timeframe not in ("D", "W", "M") and not timeframe.endswith(("D", "W", "M"))
    p = res.props
    init = p.initial_capital
    times = [int(b["time"]) for b in bars]
    idx = pd.to_datetime(times, unit="s")
    equity = pd.Series(res.equity, index=idx)
    pnl = equity - init
    peak = equity.cummax()
    close = np.array([b["close"] for b in bars], dtype=float)
    trades_all = res.trades + res.open_trades
    # TradingView's buy & hold starts at the first trade's entry price (or the first bar if none)
    bh_start = trades_all[0].entry_price if trades_all else (close[0] if len(close) else 1.0)
    bh_from = trades_all[0].entry_bar if trades_all else 0
    bh_qty = init / bh_start if len(close) else 0.0
    bh_pnl = np.where(np.arange(len(close)) >= bh_from, bh_qty * (close - bh_start), 0.0) if len(close) else np.array([])
    bh_equity = pd.Series(init + bh_pnl, index=idx)

    closed: list[Trade] = res.trades
    trades = closed + res.open_trades
    ret = lambda t: t.profit / (t.qty * t.entry_price) if t.qty and t.entry_price else 0.0
    gross_profit = sum(t.profit for t in closed if t.profit > 0)
    gross_loss = -sum(t.profit for t in closed if t.profit < 0)
    net = sum(t.profit for t in closed)
    open_pl = sum(t.profit for t in res.open_trades)
    wins = [t.profit > 0 for t in closed]
    years = max((idx[-1] - idx[0]).days / 365.25, 1e-9) if len(idx) > 1 else 1e-9
    total_return = float(equity.iloc[-1] / init - 1) if len(equity) else 0.0
    sharpe, sortino = tv_ratios(closed, init, p.risk_free_rate, open_pl, times[-1] if times else None)
    max_dd = tv_max_drawdown(trades, init)
    peak_eq = max([init] + list(init + np.cumsum([t.profit for t in closed])))
    runups, drawdowns = _episodes(equity) if len(equity) > 1 else ([], [])
    daily = equity.pct_change().dropna()
    bh_daily = bh_equity.pct_change().dropna()

    by_signal: dict[str, float] = {}
    for t in closed:
        by_signal[t.entry_label] = by_signal.get(t.entry_label, 0.0) + t.profit
    by_side = {"Long": sum(t.profit for t in closed if t.dir == LONG), "Short": sum(t.profit for t in closed if t.dir != LONG)}

    r = np.array([ret(t) for t in closed])
    edges = np.linspace(np.floor(r.min() * 20) / 20, np.ceil(r.max() * 20) / 20, 21) if r.size > 1 else np.array([0, 1])
    counts, _ = np.histogram(r, bins=edges) if r.size else (np.array([]), None)
    wd = [pd.Timestamp(t.entry_time, unit="s").day_name()[:3] for t in closed]
    mret = daily

    def trade_row(i: int, t: Trade) -> dict:
        return {"n": i + 1, "instrument": symbol, "symbol": symbol, "name": t.entry_label, "side": "long" if t.dir == LONG else "short",
                "entry_label": t.entry_label, "exit_label": t.exit_label,
                "entry_date": _iso(t.entry_time, intraday), "entry_time": t.entry_time, "entry_price": t.entry_price, "qty": t.qty,
                "exit_date": _iso(t.exit_time, intraday), "exit_time": t.exit_time, "exit_price": t.exit_price, "pnl": t.profit,
                "return_pct": ret(t), "bars": t.exit_bar - t.entry_bar + 1, "open": t.open, "max_value": t.qty * t.entry_price,
                "stale": False, "runup": t.runup, "drawdown": t.drawdown}

    markers = []
    for t in trades:
        markers.append({"time": t.entry_time, "side": "buy" if t.dir == LONG else "sell", "text": t.entry_label, "kind": "entry"})
        if not t.open:
            markers.append({"time": t.exit_time, "side": "sell" if t.dir == LONG else "buy", "text": t.exit_label, "kind": "exit"})

    out = {
        "meta": {"kind": "pine", "name": res.title, "symbol": symbol, "timeframe": timeframe,
                 "start": _iso(times[0], intraday) if times else "", "end": _iso(times[-1], intraday) if times else "",
                 "initial_capital": init, "currency": currency, "pool": None, "signal": res.title, "topk": None,
                 "rebalance_days": None, "open_cost": None, "close_cost": None, "benchmark": "Buy and hold",
                 "config": {"props": p.__dict__, "inputs": [s.__dict__ for s in res.inputs]}},
        "key_stats": {"total_pnl": net + open_pl, "total_pnl_pct": (net + open_pl) / init,
                      "max_drawdown": max_dd, "max_drawdown_pct": max_dd / peak_eq if peak_eq else None,
                      "profitable_pct": _f(sum(wins) / len(closed)) if closed else None, "wins": int(sum(wins)),
                      "closed_trades": len(closed), "profit_factor": _f(gross_profit / gross_loss) if gross_loss else None},
        "series": {"time": times, "pnl": [_f(x) for x in pnl], "buy_hold_pnl": [_f(x) for x in bh_pnl],
                   "drawdown": [_f(x) for x in (equity - peak)], "drawdown_pct": [_f(x) for x in (equity / peak - 1)]},
        "breakdown": {"gross_profit": gross_profit, "gross_loss": gross_loss, "commission": res.broker.commission_paid,
                      "net_pnl_trades": net, "unattributed": 0.0, "stale_trades": 0,
                      "profits_by_instrument": [{"instrument": k, "symbol": "", "name": "", "pnl": v}
                                                for k, v in sorted(by_signal.items(), key=lambda kv: -kv[1])],
                      "profits_by_side": by_side, "margin_calls": res.broker.margin_calls,
                      "max_contracts_held": res.broker.max_contracts},
        "periodical": {"cagr": _f((equity.iloc[-1] / init) ** (1 / years) - 1) if len(equity) and equity.iloc[-1] > 0 else None,
                       "total_return": total_return, "sharpe": sharpe, "sortino": sortino,
                       "monthly": _period_returns(equity, bh_equity, "ME") if len(equity) else [],
                       "quarterly": _period_returns(equity, bh_equity, "QE") if len(equity) else [],
                       "yearly": _period_returns(equity, bh_equity, "YE") if len(equity) else []},
        "benchmarking": {"strategy_return": total_return, "buy_hold_return": _f(bh_equity.iloc[-1] / init - 1) if len(bh_equity) else None,
                         "outperformance": _f(total_return - (bh_equity.iloc[-1] / init - 1)) if len(bh_equity) else None,
                         "correlation": _f(np.corrcoef(daily, bh_daily)[0, 1]) if len(daily) > 2 and daily.std() > 0 and bh_daily.std() > 0 else None},
        "growth_decline": {
            "avg_runup_days": _f(np.mean([x["days"] for x in runups])) if runups else None,
            "avg_drawdown_days": _f(np.mean([x["days"] for x in drawdowns])) if drawdowns else None,
            "max_drawdown_of_initial": max_dd / init,
            "runup": {"max": _f(max((x["pct"] for x in runups), default=None)), "avg": _f(np.mean([x["pct"] for x in runups])) if runups else None},
            "drawdown": {"max": _f(min((x["pct"] for x in drawdowns), default=None)),
                         "avg": _f(np.mean([x["pct"] for x in drawdowns])) if drawdowns else None,
                         "current": _f(equity.iloc[-1] / peak.iloc[-1] - 1) if len(equity) else None},
            "runups": runups[-200:], "drawdowns": drawdowns[-200:]},
        "distribution": {
            "expectancy": _f(np.mean([t.profit for t in closed])) if closed else None,
            "expectancy_pct": _f(r.mean()) if r.size else None,
            "largest_profit": _f(max((t.profit for t in closed), default=None)),
            "largest_loss": _f(min((t.profit for t in closed), default=None)),
            "avg_profit_pct": _f(r[r > 0].mean()) if (r > 0).any() else None,
            "avg_loss_pct": _f(r[r < 0].mean()) if (r < 0).any() else None,
            "winners": int((r > 0).sum()), "losers": int((r < 0).sum()), "breakevens": int((r == 0).sum()),
            "open": len(res.open_trades), "histogram": {"edges": [float(x) for x in edges], "counts": [int(x) for x in counts]}},
        "streaks": _streaks(wins),
        "time_patterns": {
            "by_entry_weekday": [{"key": k, "avg_return": _f(np.mean([x for x, w in zip(r, wd) if w == k])) if k in wd else None,
                                  "trades": wd.count(k)} for k in ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] if k in wd or k in ("Mon", "Tue", "Wed", "Thu", "Fri")],
            "by_month": [{"key": m, "avg_daily_return": _f(mret[mret.index.month == i + 1].mean()) if len(mret) else None}
                         for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])]},
        "trades": [trade_row(i, t) for i, t in enumerate(trades)],
        "chart": {"markers": markers, "plots": {k: v for k, v in res.plots.items()}},
        "inputs": [s.__dict__ for s in res.inputs],
        "props": p.__dict__,
    }
    return _plain(out)
