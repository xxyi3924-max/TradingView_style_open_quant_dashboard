"""Symbol identity across the three naming schemes we touch.

TradingView id  SSE:510300 / SZSE:159915 / NASDAQ:AAPL   (what the UI uses)
Local ts_code   510300.SH  / 159915.SZ                   (etf_rotation parquet panels)
Qlib code       SH510300   / SZ159915                    (qlib bins, backtest holdings)
US tickers are stored without exchange locally; any TradingView US exchange prefix maps to them.
"""
from __future__ import annotations

from dataclasses import dataclass

CN_EXCHANGES = {"SH": "SSE", "SZ": "SZSE", "BJ": "BSE"}
TV_TO_CN = {v: k for k, v in CN_EXCHANGES.items()}
US_EXCHANGES = {"NASDAQ", "NYSE", "AMEX", "NYSEARCA", "BATS", "CBOE", "ARCA"}


@dataclass(frozen=True)
class LocalRef:
    market: str   # "cn_etf" | "us"
    code: str     # ts_code for cn_etf, ticker for us


def ts_to_tv(ts_code: str) -> str:
    code, ex = ts_code.split(".")
    return f"{CN_EXCHANGES[ex]}:{code}"


def tv_to_ts(tv_id: str) -> str | None:
    ex, _, code = tv_id.partition(":")
    return f"{code}.{TV_TO_CN[ex]}" if ex in TV_TO_CN and code else None


def qlib_to_tv(instrument: str) -> str:
    """SH510300 -> SSE:510300. Anything else is a US ticker, returned bare (SLB, BRK.B): TradingView resolves
    the listing exchange itself, and a guessed NASDAQ: prefix is wrong for NYSE names. The code part must be
    digits, so tickers like SHW or SZLMY are not read as Chinese listings."""
    ex, code = instrument[:2].upper(), instrument[2:]
    return f"{CN_EXCHANGES[ex]}:{code}" if ex in CN_EXCHANGES and code.isdigit() else instrument


def tv_to_qlib(tv_id: str) -> str | None:
    ts = tv_to_ts(tv_id)
    if ts is None:
        return None
    code, ex = ts.split(".")
    return f"{ex}{code}"


def to_local(tv_id: str) -> LocalRef | None:
    """Map a TradingView id to the local panel that can serve it, if any."""
    ts = tv_to_ts(tv_id)
    if ts:
        return LocalRef("cn_etf", ts)
    ex, _, code = tv_id.partition(":")
    if ex in US_EXCHANGES and code:
        return LocalRef("us", code.replace(".", "-"))
    return None
