"""Symbol details for the right-panel card (TradingView's "details" widget): identity, last price,
session status and key stats. Quote fields come from the TradingView quote snapshot when the sidecar
is up; the statistics (30-day average volume, 52-week range, performance) are computed from daily bars,
so they also work on the local fallback."""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd

QUOTE_FIELDS = ("description", "local_description", "exchange", "type", "sector", "industry", "currency_code",
                "current_session", "update_mode", "lp", "lp_time", "ch", "chp", "volume", "prev_close_price",
                "open_price", "high_price", "low_price", "dividends_yield", "beta_1_year", "market_cap_basic",
                "price_earnings_ttm", "bid", "ask", "pricescale")

# (label, calendar days) for the performance tiles; YTD is computed from Jan 1
PERIODS = (("1W", 7), ("1M", 30), ("3M", 91), ("6M", 182), ("YTD", None), ("1Y", 365))


def _close_at(daily: pd.DataFrame, t: int) -> float | None:
    """Close of the last bar stamped at or before t (epoch seconds)."""
    i = int(np.searchsorted(daily["time"].to_numpy(), t, side="right")) - 1
    return float(daily["close"].iloc[i]) if i >= 0 else None


def stats(daily: pd.DataFrame, now: int | None = None) -> dict:
    """Key stats from daily bars (time = 00:00 UTC of the session date)."""
    if daily.empty:
        return {}
    d = daily.sort_values("time").reset_index(drop=True)
    last_t = int(d["time"].iloc[-1]) if now is None else now
    last = float(d["close"].iloc[-1])
    year = d[d["time"] > last_t - 365 * 86400]
    perf = {}
    for label, days in PERIODS:
        if days is None:
            jan1 = int(datetime(datetime.fromtimestamp(last_t, timezone.utc).year, 1, 1, tzinfo=timezone.utc).timestamp())
            base = _close_at(d, jan1 - 1)
        else:
            base = _close_at(d, last_t - days * 86400)
        perf[label] = last / base - 1 if base else None
    return {
        "last_close": last,
        "prev_close": float(d["close"].iloc[-2]) if len(d) > 1 else None,
        "avg_volume_30d": float(d["volume"].iloc[-30:].mean()),
        "high_52w": float(year["high"].max()),
        "low_52w": float(year["low"].min()),
        "performance": perf,
    }


def session_label(current_session: str | None, update_mode: str | None) -> dict:
    """TradingView market-status line: 'Market open' (green), 'Pre-market', 'Post-market', 'Market closed'."""
    label = {"market": "Market open", "pre_market": "Pre-market", "post_market": "Post-market",
             "out_of_session": "Market closed"}.get(current_session or "", "Market closed" if current_session else None)
    delay = None
    if update_mode and update_mode.startswith("delayed_streaming_"):
        delay = int(update_mode.rsplit("_", 1)[-1]) // 60
    return {"status": current_session, "label": label, "delayed_minutes": delay}


def build(symbol: str, quote: dict | None, daily: pd.DataFrame, source: str, name: str | None = None) -> dict:
    q = {k: (quote or {}).get(k) for k in QUOTE_FIELDS}
    st = stats(daily)
    last = q["lp"] if q["lp"] is not None else st.get("last_close")
    prev = q["prev_close_price"] if q["prev_close_price"] is not None else st.get("prev_close")
    ch = q["ch"] if q["ch"] is not None else (last - prev if last is not None and prev else None)
    chp = q["chp"] if q["chp"] is not None else (ch / prev * 100 if ch is not None and prev else None)
    exchange, _, short = symbol.partition(":")
    return {
        "symbol": symbol, "short_name": short or symbol, "exchange": q["exchange"] or exchange,
        "description": q["description"] or name or symbol, "local_description": q["local_description"],
        "type": q["type"], "sector": q["sector"], "industry": q["industry"], "currency": q["currency_code"],
        "last": last, "change": ch, "change_pct": chp,
        "volume": q["volume"] if q["volume"] is not None else (float(daily["volume"].iloc[-1]) if not daily.empty else None),
        "open": q["open_price"], "high": q["high_price"], "low": q["low_price"], "prev_close": prev,
        "bid": q["bid"], "ask": q["ask"], "dividends_yield": q["dividends_yield"], "beta_1y": q["beta_1_year"],
        "market_cap": q["market_cap_basic"], "pe_ttm": q["price_earnings_ttm"],
        "session": session_label(q["current_session"], q["update_mode"]),
        "stats": st, "source": source,
    }
