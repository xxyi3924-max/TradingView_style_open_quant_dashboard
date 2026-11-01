"""TradingView data through the Node sidecar (primary feed)."""
from __future__ import annotations

from datetime import datetime
from functools import lru_cache
from zoneinfo import ZoneInfo

import httpx
import numpy as np
import pandas as pd

from .. import bars, config


class SidecarError(RuntimeError):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code = status, code


_client = httpx.Client(base_url=config.SIDECAR_URL, timeout=60.0)


def _get(path: str, **params) -> dict:
    try:
        r = _client.get(path, params={k: v for k, v in params.items() if v is not None})
    except httpx.TransportError as e:
        raise SidecarError(503, "SIDECAR_DOWN", f"sidecar unreachable: {e}") from e
    body = r.json()
    if r.status_code != 200:
        raise SidecarError(r.status_code, body.get("code", "ERROR"), body.get("error", r.text))
    return body


def healthy() -> bool:
    try:
        return bool(_get("/health").get("ok"))
    except SidecarError:
        return False


@lru_cache(maxsize=512)
def symbol_info(symbol: str) -> dict:
    return _get("/symbol", symbol=symbol)


def _timezone(symbol: str) -> str:
    try:
        return symbol_info(symbol).get("timezone") or "Etc/UTC"
    except SidecarError:
        return "Etc/UTC"


def get_bars(symbol: str, timeframe: str, count: int = 500, to: int | None = None,
             adjustment: str | None = None) -> pd.DataFrame:
    """`adjustment`: None/"splits" (TradingView's default, ADJ off) or "dividends" (ADJ on)."""
    tf = bars.normalize_timeframe(timeframe)
    body = _get("/candles", symbol=symbol, timeframe=tf, count=count, to=to, adjustment=adjustment)
    df = pd.DataFrame(body["candles"], columns=bars.COLUMNS)
    if df.empty:
        return bars.empty()
    if tf in bars.DAILY_PLUS:
        df["time"] = restamp(symbol, tf, df["time"].tolist())
    df["volume"] = df["volume"].fillna(0.0)
    return df[bars.COLUMNS]


def restamp(symbol: str, tf: str, times: list[int]) -> np.ndarray:
    """TradingView stamps D/W/M bars at session open; restamp to our 00:00-UTC period convention."""
    tz = ZoneInfo(_timezone(symbol))
    return bars.period_stamp([datetime.fromtimestamp(t, tz).date() for t in times], tf)


def search(text: str, type_: str | None = None) -> list[dict]:
    return [dict(r, source="tradingview") for r in _get("/search", q=text, type=type_)["results"]]


def quotes(symbols: list[str]) -> dict:
    return _get("/quotes", symbols=",".join(symbols))


def indicator(symbol: str, timeframe: str, indicator_id: str, count: int = 300, inputs: str | None = None) -> dict:
    return _get("/indicator", symbol=symbol, timeframe=bars.normalize_timeframe(timeframe),
                indicator=indicator_id, count=count, inputs=inputs)
