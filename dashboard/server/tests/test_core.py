"""Bars/resampling, symbol mapping, persistence and the alert engine (offline)."""
import numpy as np
import pandas as pd
import pytest

from tvre import alerts, bars, symbols
from tvre.store import Store


def daily_frame(closes, start="2024-01-01"):
    d = pd.bdate_range(start, periods=len(closes))
    c = np.asarray(closes, dtype=float)
    return pd.DataFrame({"time": bars.day_stamp(d), "open": c, "high": c + 1, "low": c - 1, "close": c,
                         "volume": np.ones(len(c))})


# ---------------------------------------------------------------- bars
def test_weekly_resample_matches_pandas_ohlc():
    rng = np.random.default_rng(0)
    f = daily_frame(100 + rng.normal(size=60).cumsum())
    w = bars.resample(f, "W")
    idx = pd.to_datetime(f.time, unit="s")
    ref = f.set_index(idx).resample("W-MON", label="left", closed="left").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}).dropna()
    np.testing.assert_allclose(w[["open", "high", "low", "close", "volume"]].to_numpy(), ref.to_numpy())
    assert (pd.to_datetime(w.time, unit="s").dt.weekday == 0).all()


def test_monthly_resample_stamped_on_first():
    f = daily_frame(range(1, 70))
    m = bars.resample(f, "M")
    assert (pd.to_datetime(m.time, unit="s").dt.day == 1).all()
    assert m.close.iloc[0] == f[pd.to_datetime(f.time, unit="s").dt.month == 1].close.iloc[-1]


@pytest.mark.parametrize("tf,norm", [("1D", "D"), ("1h", "60"), ("4H", "240"), ("w", "W"), ("5", "5")])
def test_timeframe_aliases(tf, norm):
    assert bars.normalize_timeframe(tf) == norm


def test_bad_timeframe():
    with pytest.raises(ValueError):
        bars.normalize_timeframe("7X")


# ---------------------------------------------------------------- symbols
def test_symbol_roundtrips():
    assert symbols.ts_to_tv("510300.SH") == "SSE:510300"
    assert symbols.tv_to_ts("SZSE:159915") == "159915.SZ"
    assert symbols.tv_to_qlib("SSE:510300") == "SH510300"
    assert symbols.qlib_to_tv("SZ159915") == "SZSE:159915"
    assert symbols.to_local("NASDAQ:AAPL") == symbols.LocalRef("us", "AAPL")
    assert symbols.to_local("BINANCE:BTCUSDT") is None


def test_qlib_us_tickers_are_not_read_as_china_listings():
    # US study holdings use bare tickers; SHW / SZLMY start like SH/SZ qlib codes but are not Chinese listings
    assert symbols.qlib_to_tv("SH510300") == "SSE:510300"
    assert symbols.qlib_to_tv("SHW") == "SHW" and symbols.qlib_to_tv("SZLMY") == "SZLMY"
    assert symbols.qlib_to_tv("BRK.B") == "BRK.B"                      # bare: TradingView names the exchange


# ---------------------------------------------------------------- store
def test_store_persists_across_reopen(tmp_path):
    p = tmp_path / "s.sqlite3"
    s = Store(p)
    wl = s.create_watchlist("Tech", ["nasdaq:aapl", "NASDAQ:AAPL", "NASDAQ:MSFT"])
    assert wl["symbols"] == ["NASDAQ:AAPL", "NASDAQ:MSFT"]
    lay = s.save_layout("main", {"panes": [{"symbol": "SSE:510300", "drawings": [{"type": "hline", "price": 4.2}]}]})
    s.set_setting("last_layout", lay["id"])
    s2 = Store(p)
    assert [w["name"] for w in s2.watchlists()] == ["Watchlist", "Tech"]
    assert s2.layout(lay["id"])["state"]["panes"][0]["drawings"][0]["price"] == 4.2
    assert s2.get_setting("last_layout") == lay["id"]


def test_layout_save_by_name_overwrites(store):
    a = store.save_layout("x", {"v": 1})
    b = store.save_layout("x", {"v": 2})
    assert a["id"] == b["id"] and store.layout(a["id"])["state"] == {"v": 2}


# ---------------------------------------------------------------- alerts
PRICE = {"kind": "price", "field": "close"}


def val(v):
    return {"kind": "value", "value": v}


def test_crossing_up_fires_exactly_on_cross_bar():
    f = daily_frame([1, 2, 3, 6, 7, 4, 8])
    sig = alerts.signal({"left": PRICE, "op": "crossing_up", "right": val(5)}, f)
    assert np.flatnonzero(sig).tolist() == [3, 6]
    sig = alerts.signal({"left": PRICE, "op": "crossing_down", "right": val(5)}, f)
    assert np.flatnonzero(sig).tolist() == [5]
    sig = alerts.signal({"left": PRICE, "op": "crossing", "right": val(5)}, f)
    assert np.flatnonzero(sig).tolist() == [3, 5, 6]


def test_touch_then_cross_counts_once():
    # a[1] <= b[1] includes touching: 4 -> 5 (touch) -> 6 crosses on bar 2 only
    sig = alerts.signal({"left": PRICE, "op": "crossing_up", "right": val(5)}, daily_frame([4, 5, 6]))
    assert np.flatnonzero(sig).tolist() == [2]


def test_channel_ops():
    f = daily_frame([1, 5, 6, 12, 7, 0])
    c = {"left": PRICE, "upper": val(10), "lower": val(4)}
    assert np.flatnonzero(alerts.signal({**c, "op": "entering_channel"}, f)).tolist() == [1, 4]
    assert np.flatnonzero(alerts.signal({**c, "op": "exiting_channel"}, f)).tolist() == [3, 5]


def test_indicator_operand_crossing():
    rng = np.random.default_rng(7)
    f = daily_frame(100 + rng.normal(size=200).cumsum())
    cond = {"left": PRICE, "op": "crossing", "right": {"kind": "indicator", "type": "SMA", "inputs": {"length": 20}}}
    sig = alerts.signal(cond, f)
    assert not sig[:20].any()
    c, m = f.close.to_numpy(), pd.Series(f.close).rolling(20).mean().to_numpy()
    expect = [i for i in range(20, 200) if (c[i] - m[i]) * (c[i - 1] - m[i - 1]) < 0
              or (c[i] > m[i] and c[i - 1] == m[i - 1]) or (c[i] < m[i] and c[i - 1] == m[i - 1])]
    assert np.flatnonzero(sig).tolist() == expect


def test_evaluate_trigger_modes():
    f = daily_frame([1, 6, 1, 6, 1, 6])
    base = {"condition": {"left": PRICE, "op": "greater_than", "right": val(5)}, "last_bar": None}
    once = alerts.evaluate({**base, "trigger": "once"}, f)
    assert [x["bar_time"] for x in once] == [int(f.time[1])]
    every = alerts.evaluate({**base, "trigger": "once_per_bar"}, f)
    assert [x["bar_time"] for x in every] == [int(f.time[i]) for i in (1, 3, 5)]
    closed = alerts.evaluate({**base, "trigger": "once_per_bar_close"}, f)
    assert [x["bar_time"] for x in closed] == [int(f.time[i]) for i in (1, 3)]   # forming bar excluded
    since = alerts.evaluate({**base, "trigger": "once_per_bar", "last_bar": int(f.time[3])}, f)
    assert [x["bar_time"] for x in since] == [int(f.time[5])]


def test_validate_rejects_bad_conditions():
    with pytest.raises(ValueError):
        alerts.validate({"left": PRICE, "op": "nope", "right": val(1)})
    with pytest.raises(ValueError):
        alerts.validate({"left": PRICE, "op": "entering_channel", "upper": val(1)})


def test_period_stamp_snaps_week_and_month():
    import datetime as dt
    d = [dt.date(2026, 10, 7), dt.date(2026, 10, 2)]          # Wed, Fri
    assert pd.to_datetime(bars.period_stamp(d, "W"), unit="s").strftime("%Y-%m-%d").tolist() == ["2026-10-05", "2026-09-28"]
    assert pd.to_datetime(bars.period_stamp(d, "M"), unit="s").strftime("%Y-%m-%d").tolist() == ["2026-10-01", "2026-10-01"]
    assert pd.to_datetime(bars.period_stamp(d, "D"), unit="s").strftime("%Y-%m-%d").tolist() == ["2026-10-07", "2026-10-02"]
