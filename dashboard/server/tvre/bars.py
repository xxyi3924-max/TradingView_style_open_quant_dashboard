"""Bar frames and timeframe helpers shared by all providers.

A bar frame is a DataFrame with columns time (int Unix seconds), open, high, low, close, volume,
sorted ascending. Daily-and-longer bars are stamped at 00:00 UTC of their exchange-local date
(week bars on the Monday, month bars on the 1st), so bars from different providers line up.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

COLUMNS = ["time", "open", "high", "low", "close", "volume"]
INTRADAY = {"1", "3", "5", "15", "30", "45", "60", "120", "180", "240"}
SECONDS = {"1S", "5S", "15S", "30S"}
DAILY_PLUS = {"D", "W", "M"}
TIMEFRAMES = sorted(INTRADAY, key=int) + ["D", "W", "M"]


def normalize_timeframe(tf: str) -> str:
    tf = (tf or "D").upper()
    aliases = {"1D": "D", "1W": "W", "1M": "M", "1H": "60", "4H": "240", "2H": "120", "3H": "180"}
    tf = aliases.get(tf, tf)
    if tf not in INTRADAY and tf not in DAILY_PLUS and tf not in SECONDS:
        raise ValueError(f"unsupported timeframe {tf!r}")
    return tf


def empty() -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series(dtype="int64" if c == "time" else "float64") for c in COLUMNS})


def day_stamp(dates: pd.Series | pd.DatetimeIndex) -> np.ndarray:
    """00:00 UTC of each (naive, exchange-local) date as Unix seconds."""
    d = pd.DatetimeIndex(pd.to_datetime(np.asarray(dates))).normalize()
    return np.asarray(d.asi8 // 1_000_000_000, dtype="int64")


def period_stamp(local_dates, tf: str) -> np.ndarray:
    """Stamp exchange-local dates for timeframe tf: D -> the date, W -> its Monday, M -> the 1st."""
    d = pd.DatetimeIndex(pd.to_datetime(np.asarray(local_dates))).normalize()
    if tf == "W":
        d = d - pd.to_timedelta(d.weekday, unit="D")
    elif tf == "M":
        d = d.to_period("M").to_timestamp()
    return day_stamp(d)


def resample(daily: pd.DataFrame, tf: str) -> pd.DataFrame:
    """Aggregate daily bars into W (Monday-stamped) or M (1st-stamped) bars."""
    if tf == "D" or daily.empty:
        return daily.reset_index(drop=True)
    dt = pd.to_datetime(daily["time"], unit="s")
    if tf == "W":
        key = (dt - pd.to_timedelta(dt.dt.weekday, unit="D")).dt.normalize()
    elif tf == "M":
        key = dt.dt.to_period("M").dt.to_timestamp()
    else:
        raise ValueError(f"cannot resample daily bars to {tf}")
    g = daily.assign(_k=key.to_numpy()).groupby("_k", sort=True)
    out = pd.DataFrame({
        "open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
        "close": g["close"].last(), "volume": g["volume"].sum(),
    })
    out.insert(0, "time", day_stamp(out.index))
    return out.reset_index(drop=True)


def to_records(df: pd.DataFrame) -> list[dict]:
    df = df[COLUMNS].replace([np.inf, -np.inf], np.nan).dropna(subset=["open", "high", "low", "close"])
    recs = df.to_dict("records")
    for r in recs:
        r["time"] = int(r["time"])
        if r["volume"] != r["volume"]:
            r["volume"] = 0.0
    return recs
