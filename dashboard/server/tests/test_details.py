"""Details card: stats from daily bars, quote precedence, session label, endpoint on the local fallback."""
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest

from tvre import bars, details

from .conftest import local_data
from tvre.providers import tradingview
from tvre.providers.tradingview import SidecarError


def daily(n=400, start="2025-01-02"):
    d = pd.bdate_range(start, periods=n)
    close = 10 + np.arange(n) * 0.01
    return pd.DataFrame({"time": bars.day_stamp(d), "open": close, "high": close + 0.5, "low": close - 0.5,
                         "close": close, "volume": np.arange(n, dtype=float) + 1})


def test_stats_from_daily_bars():
    df = daily()
    s = details.stats(df)
    last_t = int(df["time"].iloc[-1])
    assert s["last_close"] == pytest.approx(df["close"].iloc[-1])
    assert s["avg_volume_30d"] == pytest.approx(df["volume"].iloc[-30:].mean())
    year = df[df["time"] > last_t - 365 * 86400]
    assert s["high_52w"] == pytest.approx(year["high"].max()) and s["low_52w"] == pytest.approx(year["low"].min())
    # 1M performance: base = last close on or before t - 30 days
    base = df[df["time"] <= last_t - 30 * 86400]["close"].iloc[-1]
    assert s["performance"]["1M"] == pytest.approx(df["close"].iloc[-1] / base - 1)
    jan1 = datetime(datetime.fromtimestamp(last_t, timezone.utc).year, 1, 1, tzinfo=timezone.utc).timestamp()
    ybase = df[df["time"] < jan1]["close"].iloc[-1]
    assert s["performance"]["YTD"] == pytest.approx(df["close"].iloc[-1] / ybase - 1)


def test_quote_fields_take_precedence_and_bars_fill_gaps():
    df = daily()
    q = {"lp": 99.0, "ch": 1.0, "chp": 1.02, "volume": 5e6, "current_session": "market",
         "update_mode": "delayed_streaming_900", "description": "Fund X", "exchange": "SSE"}
    r = details.build("SSE:510300", q, df, "tradingview")
    assert (r["last"], r["change"], r["volume"], r["description"]) == (99.0, 1.0, 5e6, "Fund X")
    assert r["session"] == {"status": "market", "label": "Market open", "delayed_minutes": 15}
    r2 = details.build("SSE:510300", None, df, "local", name="沪深300ETF")
    last, prev = df["close"].iloc[-1], df["close"].iloc[-2]
    assert r2["last"] == pytest.approx(last) and r2["change"] == pytest.approx(last - prev)
    assert r2["change_pct"] == pytest.approx((last - prev) / prev * 100)
    assert r2["description"] == "沪深300ETF" and r2["session"]["label"] is None and r2["short_name"] == "510300"


def test_session_labels():
    assert details.session_label("out_of_session", None)["label"] == "Market closed"
    assert details.session_label("pre_market", "streaming")["label"] == "Pre-market"
    assert details.session_label("post_market", None)["delayed_minutes"] is None


@local_data
def test_details_endpoint_local_fallback(client, monkeypatch):
    def down(*a, **k):
        raise SidecarError(503, "SIDECAR_DOWN", "down")
    monkeypatch.setattr(tradingview, "get_bars", down)
    monkeypatch.setattr(tradingview, "quotes", down)
    r = client.get("/api/details", params={"symbol": "SSE:510300"})
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "local" and body["last"] > 0 and body["stats"]["avg_volume_30d"] > 0
    assert "300" in body["description"]
    assert client.get("/api/details", params={"symbol": "FOO:NOPE"}).status_code == 404


def test_bars_adjustment_is_validated(client):
    assert client.get("/api/bars", params={"symbol": "SSE:510300", "adjustment": "bogus"}).status_code == 422
