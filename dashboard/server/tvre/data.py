"""Data routing: TradingView first, local panels as fallback (or forced via source=). QUANTIFI: symbols are the
hackathon's order books (tvre.quantifi) and never go to TradingView."""
from __future__ import annotations

import pandas as pd

from . import bars, quantifi
from .providers import local, tradingview
from .providers.tradingview import SidecarError
from .symbols import to_local


class NoData(LookupError):
    pass


def get_bars(symbol: str, timeframe: str = "D", count: int = 500, to: int | None = None,
             source: str = "auto", adjustment: str | None = None) -> tuple[pd.DataFrame, str]:
    """`adjustment` applies to the TradingView feed only; the local panels are already
    dividend-adjusted (eastmoney 前复权), so they ignore it."""
    tf = bars.normalize_timeframe(timeframe)
    if quantifi.is_symbol(symbol):
        try:
            return quantifi.get_bars(symbol, tf, count, to), "quantifi"
        except (KeyError, FileNotFoundError) as e:
            raise NoData(str(e)) from e
    errors = []
    if source in ("auto", "tradingview"):
        try:
            return tradingview.get_bars(symbol, tf, count, to, adjustment), "tradingview"
        except SidecarError as e:
            errors.append(f"tradingview: {e}")
            if source == "tradingview" or (e.code in ("SYMBOL_ERROR", "NO_DATA") and to is None):
                raise NoData("; ".join(errors)) from e
    if source in ("auto", "local"):
        ref = to_local(symbol)
        if ref is None:
            errors.append(f"local: no local panel for {symbol}")
        else:
            try:
                return local.get_bars(ref, tf, count, to), "local"
            except (KeyError, ValueError) as e:
                errors.append(f"local: {e}")
    raise NoData("; ".join(errors) or f"no data for {symbol}")


def search(text: str, type_: str | None = None) -> list[dict]:
    results: list[dict] = quantifi.search(text)
    try:
        results += tradingview.search(text, type_)
    except SidecarError:
        pass
    seen = {r["id"] for r in results}
    results += [r for r in local.search(text) if r["id"] not in seen]
    return results
