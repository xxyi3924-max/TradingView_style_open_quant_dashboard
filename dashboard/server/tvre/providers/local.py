"""Local daily bars from the Work_Quant parquet panels (CN ETFs, US stocks).

CN ETF prices are eastmoney 前复权 with *additive* dividend adjustment anchored at the panel's
vintage (raw - local is constant between dividend ex-dates, 0 after the last one). TradingView's
default feed is unadjusted, so levels differ before the latest dividend; returns within a
dividend segment are identical. Volumes are converted from lots to shares.
"""
from __future__ import annotations

from functools import lru_cache

import pandas as pd

from .. import bars, config
from ..symbols import LocalRef, ts_to_tv


@lru_cache(maxsize=2)
def _panel(market: str) -> dict[str, pd.DataFrame]:
    if market == "cn_etf":
        df = pd.read_parquet(config.CN_ETF_PRICES,
                             columns=["trade_date", "ts_code", "open", "high", "low", "close", "volume"])
        df = df.rename(columns={"ts_code": "code", "trade_date": "date"})
        df["volume"] = df["volume"] * 100.0   # panel stores lots (手); TradingView reports shares
    elif market == "us":
        df = pd.read_parquet(config.US_PRICES, columns=["date", "ticker", "open", "high", "low", "close", "volume"])
        df = df.rename(columns={"ticker": "code"})
    else:
        raise KeyError(market)
    df = df.dropna(subset=["open", "high", "low", "close"]).sort_values(["code", "date"])
    df["time"] = bars.day_stamp(df["date"])
    return {code: g[bars.COLUMNS].reset_index(drop=True) for code, g in df.groupby("code", sort=False)}


@lru_cache(maxsize=1)
def cn_names() -> dict[str, str]:
    m = pd.read_parquet(config.CN_ETF_MASTER, columns=["ts_code", "name"])
    return dict(zip(m.ts_code, m.name))


def has(ref: LocalRef) -> bool:
    return ref.code in _panel(ref.market)


def get_bars(ref: LocalRef, timeframe: str, count: int = 500, to: int | None = None) -> pd.DataFrame:
    tf = bars.normalize_timeframe(timeframe)
    if tf not in bars.DAILY_PLUS:
        raise ValueError(f"local data is daily; timeframe {tf} needs the TradingView provider")
    daily = _panel(ref.market).get(ref.code)
    if daily is None:
        raise KeyError(f"{ref.market}:{ref.code} not in local data")
    out = bars.resample(daily, tf)
    if to is not None:
        out = out[out["time"] <= to]
    return out.tail(count).reset_index(drop=True)


def search(text: str, limit: int = 30) -> list[dict]:
    text = text.strip().upper()
    if not text:
        return []
    out = []
    names = cn_names()
    for code in _panel("cn_etf"):
        name = names.get(code, "")
        if text in code or text in name.upper():
            out.append({"id": ts_to_tv(code), "symbol": code.split(".")[0], "description": name,
                        "exchange": ts_to_tv(code).split(":")[0], "type": "fund", "source": "local"})
    for code in _panel("us"):
        if code.startswith(text):
            out.append({"id": f"NASDAQ:{code}", "symbol": code, "description": code, "exchange": "US",
                        "type": "stock", "source": "local"})
    out.sort(key=lambda r: (r["symbol"] != text, len(r["symbol"])))
    return out[:limit]
