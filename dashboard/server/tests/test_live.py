"""Live checks against TradingView through the sidecar: data agreement and indicator parity.

Run with the sidecar up (npm start in sidecar/). Skipped automatically if it is not reachable.
"""
import numpy as np
import pandas as pd
import pytest

from tvre import bars
from tvre.providers import local, tradingview
from tvre.symbols import to_local

from .conftest import sidecar_up

pytestmark = [pytest.mark.live, pytest.mark.skipif(not sidecar_up(), reason="sidecar not running")]


def test_tv_daily_bars_are_restamped_to_local_dates():
    df = tradingview.get_bars("SSE:510300", "D", 30)
    assert (df.time % 86400 == 0).all()
    assert (pd.to_datetime(df.time, unit="s").dt.weekday < 5).all()


def test_local_is_additive_dividend_adjusted_tv_raw():
    """raw (TradingView, unadjusted) - local (前复权, additive) is a step function of dividends."""
    tv = tradingview.get_bars("SSE:510300", "D", 2000)
    lo = local.get_bars(to_local("SSE:510300"), "D", 2000)
    m = tv.merge(lo, on="time", suffixes=("_tv", "_lo"))
    assert len(m) > 1500
    diff = m.close_tv - m.close_lo
    # the adjusted series is rounded to 3 decimals, so the offset jitters by up to ~3 ticks
    for col in ("open", "high", "low"):
        assert ((m[f"{col}_tv"] - m[f"{col}_lo"] - diff).abs() <= 0.0035).mean() > 0.99, col
    seg = diff.rolling(5, center=True, min_periods=1).median()
    steps = np.flatnonzero(seg.diff().abs() > 0.005)
    assert 3 <= len(steps) <= 12, "about one dividend ex-date per year (8 for 510300 since 2018)"
    assert (seg.diff().fillna(0) <= 0.0035).all(), "offset only shrinks as dividends roll off"
    tail = diff.iloc[-60:].abs()
    assert tail.max() <= 0.0035 and tail.mean() < 0.002, "after the latest dividend: only 1-3 tick vendor print noise"
    np.testing.assert_allclose(m.volume_tv, m.volume_lo, rtol=1e-6)


def test_tv_weekly_matches_our_resample_of_tv_daily():
    d = tradingview.get_bars("SSE:510300", "D", 400)
    w_tv = tradingview.get_bars("SSE:510300", "W", 60)
    w_ours = bars.resample(d, "W")
    m = w_tv.merge(w_ours, on="time", suffixes=("_tv", "_us")).iloc[1:-1]   # drop partial edge weeks
    assert len(m) > 40
    for col in ("open", "high", "low", "close"):
        np.testing.assert_allclose(m[f"{col}_tv"], m[f"{col}_us"], rtol=1e-9, err_msg=col)
    np.testing.assert_allclose(m.volume_tv, m.volume_us, rtol=1e-6)


def test_intraday_bars_available():
    df = tradingview.get_bars("NASDAQ:AAPL", "15", 100)
    assert len(df) == 100 and (np.diff(df.time) > 0).all()


@pytest.mark.parametrize("kind", ["SMA", "EMA", "RSI", "OBV", "BB", "MACD", "ATR", "STOCH"])
def test_indicator_parity_with_tradingview(client, kind):
    r = client.get("/api/parity", params={"symbol": "SSE:510300", "type": kind, "count": 400, "warmup": 300})
    if r.status_code == 502 and "STUDY_ERROR" in r.text:
        pytest.skip(f"TradingView refused the anonymous {kind} study: {r.json()['detail'][:80]}")
    assert r.status_code == 200, r.text
    for plot, rep in r.json()["plots"].items():
        assert rep["n"] > 50, (plot, rep)
        assert rep["max_rel_err"] < 1e-6, (kind, plot, rep)


def test_tv_monthly_stamped_on_first_and_matches_resample():
    d = tradingview.get_bars("SSE:510300", "D", 800)
    m_tv = tradingview.get_bars("SSE:510300", "M", 30)
    assert (pd.to_datetime(m_tv.time, unit="s").dt.day == 1).all()
    m = m_tv.merge(bars.resample(d, "M"), on="time", suffixes=("_tv", "_us")).iloc[1:-1]
    assert len(m) > 20
    np.testing.assert_allclose(m.close_tv, m.close_us, rtol=1e-9)


def test_stream_bars_are_restamped(live_server):
    """Through a real uvicorn server (TestClient buffers infinite SSE responses)."""
    import json as _json
    import httpx
    with httpx.stream("GET", f"{live_server}/api/stream/bars", params={"symbol": "BINANCE:BTCUSDT", "timeframe": "D"},
                      timeout=30) as r:
        for line in r.iter_lines():
            if line.startswith("data: "):
                payload = _json.loads(line[6:])
                assert payload and all(c["time"] % 86400 == 0 for c in payload)
                return
    raise AssertionError("no data event")
