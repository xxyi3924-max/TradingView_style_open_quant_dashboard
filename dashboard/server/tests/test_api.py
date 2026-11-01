"""HTTP API: local data parity with the parquet panels, CRUD persistence, alerts end to end."""
import numpy as np
import pandas as pd
import pytest

from tvre import bars, config, data

from .conftest import local_data, qlib_engine


@local_data
def test_local_bars_equal_parquet_rows(client):
    r = client.get("/api/bars", params={"symbol": "SSE:510300", "timeframe": "D", "count": 50, "source": "local"})
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "local" and len(body["bars"]) == 50
    ref = pd.read_parquet(config.CN_ETF_PRICES, columns=["trade_date", "ts_code", "open", "high", "low", "close"],
                          filters=[("ts_code", "=", "510300.SH")]).sort_values("trade_date").tail(50)
    got = pd.DataFrame(body["bars"])
    np.testing.assert_allclose(got[["open", "high", "low", "close"]].to_numpy(),
                               ref[["open", "high", "low", "close"]].to_numpy())
    assert got.time.tolist() == bars.day_stamp(ref.trade_date).tolist()


@local_data
def test_local_paging_with_to(client):
    a = client.get("/api/bars", params={"symbol": "SSE:510300", "count": 100, "source": "local"}).json()["bars"]
    b = client.get("/api/bars", params={"symbol": "SSE:510300", "count": 100, "source": "local",
                                        "to": a[0]["time"] - 1}).json()["bars"]
    assert len(b) == 100 and b[-1]["time"] < a[0]["time"]


@local_data
def test_local_weekly_and_intraday_rejected(client):
    w = client.get("/api/bars", params={"symbol": "SSE:510300", "timeframe": "W", "count": 10, "source": "local"})
    assert w.status_code == 200 and len(w.json()["bars"]) == 10
    i = client.get("/api/bars", params={"symbol": "SSE:510300", "timeframe": "5", "source": "local"})
    assert i.status_code == 404


def test_unknown_symbol_404(client):
    assert client.get("/api/bars", params={"symbol": "XX:NOPE", "source": "local"}).status_code == 404


@local_data
def test_indicator_endpoint_aligned_with_bars(client):
    r = client.get("/api/indicator", params={"symbol": "SSE:510300", "type": "RSI", "source": "local", "count": 200})
    body = r.json()
    assert len(body["time"]) == len(body["values"]["rsi"]) == 200
    assert body["values"]["rsi"][0] is None and 0 < body["values"]["rsi"][-1] < 100


def test_watchlist_crud(client):
    wl = client.post("/api/watchlists", json={"name": "CN", "symbols": ["SSE:510300"]}).json()
    up = client.patch(f"/api/watchlists/{wl['id']}", json={"symbols": ["SSE:510300", "SZSE:159915"]}).json()
    assert up["symbols"] == ["SSE:510300", "SZSE:159915"]
    names = [w["name"] for w in client.get("/api/watchlists").json()]
    assert names == ["Watchlist", "CN"]
    assert client.delete(f"/api/watchlists/{wl['id']}").json()["ok"]
    assert client.patch(f"/api/watchlists/{wl['id']}", json={"name": "x"}).status_code == 404


def test_layout_roundtrip_sets_last_layout(client):
    state = {"grid": "2h", "charts": [{"symbol": "SSE:510300", "timeframe": "D", "studies": [{"type": "RSI"}],
                                       "drawings": [{"type": "trend", "points": [[1, 4.1], [2, 4.3]]}]}]}
    lay = client.post("/api/layouts", json={"name": "main", "state": state}).json()
    assert client.get(f"/api/layouts/{lay['id']}").json()["state"] == state
    assert client.get("/api/settings/last_layout").json()["value"] == lay["id"]


@pytest.fixture
def fake_bars(monkeypatch):
    """Deterministic bar feed for alert tests: a series we can extend to simulate new bars."""
    closes = [4.0, 4.1, 4.2, 4.3]

    def frame():
        d = pd.bdate_range("2025-01-01", periods=len(closes))
        c = np.array(closes)
        return pd.DataFrame({"time": bars.day_stamp(d), "open": c, "high": c, "low": c, "close": c,
                             "volume": np.ones(len(c))})

    monkeypatch.setattr(data, "get_bars", lambda *a, **k: (frame().tail(k.get("count", 500)), "local"))
    return closes


def test_alert_fires_once_on_new_crossing_bar(client, fake_bars):
    cond = {"left": {"kind": "price", "field": "close"}, "op": "crossing_up", "right": {"kind": "value", "value": 4.5}}
    a = client.post("/api/alerts", json={"symbol": "SSE:510300", "timeframe": "D", "condition": cond}).json()
    assert a["active"] and "crossing up" in a["description"]
    assert client.post("/api/alerts/check").json()["fired"] == []          # nothing crossed yet
    fake_bars.append(4.6)                                                   # new bar crosses 4.5
    fired = client.post("/api/alerts/check").json()["fired"]
    assert len(fired) == 1 and fired[0]["value"] == pytest.approx(4.6)
    assert client.get("/api/alerts").json()[0]["active"] is False          # "once" deactivates
    fake_bars.extend([4.4, 4.7])
    assert client.post("/api/alerts/check").json()["fired"] == []
    assert len(client.get("/api/alerts/log").json()) == 1


def test_alert_once_per_bar_keeps_firing_on_new_bars(client, fake_bars):
    cond = {"left": {"kind": "price", "field": "close"}, "op": "greater_than", "right": {"kind": "value", "value": 4.25}}
    client.post("/api/alerts", json={"symbol": "S", "timeframe": "D", "condition": cond, "trigger": "once_per_bar"})
    assert len(client.post("/api/alerts/check").json()["fired"]) == 1      # current bar 4.3 > 4.25
    assert client.post("/api/alerts/check").json()["fired"] == []          # same bar: not again
    fake_bars.append(4.35)
    assert len(client.post("/api/alerts/check").json()["fired"]) == 1


def test_alert_validation_400(client, fake_bars):
    bad = {"left": {"kind": "price"}, "op": "explode", "right": {"kind": "value", "value": 1}}
    assert client.post("/api/alerts", json={"symbol": "S", "condition": bad}).status_code == 400


def test_alert_replay(client, fake_bars):
    fake_bars.extend([4.6, 4.4, 4.7])
    cond = {"left": {"kind": "price", "field": "close"}, "op": "crossing_up", "right": {"kind": "value", "value": 4.5}}
    r = client.post("/api/alerts/replay", json={"symbol": "S", "condition": cond}).json()
    assert len(r["times"]) == 2


def test_backtest_runs_include_us_study_as_folders(client):
    runs = client.get("/api/backtest/runs").json()
    markets = {r["market"] for r in runs}
    if "us" not in markets:
        pytest.skip("us_stock_rotation runs not present")
    us = next(r for r in runs if r["market"] == "us" and r["folder"])
    assert us["id"].startswith("us:") and us["id"].split("/")[2] == us["folder"].split("/")[0]
    rep = client.get(f"/api/backtest/report/{us['id']}").json()
    assert rep["meta"]["currency"] == "USD"
    assert all(":" not in p["symbol"] for p in rep["breakdown"]["profits_by_instrument"])   # bare US tickers
    assert client.get("/api/backtest/report/us:../../etc").status_code == 404
    assert client.get("/api/backtest/report/us:sector_leaders55/backtest/nope").status_code == 404


@qlib_engine
def test_backtest_runs_listing_and_load(client):
    runs = client.get("/api/backtest/runs", params={"pool": "momentum53", "q": "mom_12_1_(masked)"}).json()
    assert runs, "expected the reference momentum53 run"
    run = client.get(f"/api/backtest/runs/{runs[0]['id']}").json()
    rep = pd.read_csv(config.ETF_POOLS_ROOT / runs[0]["id"] / "report.csv", index_col=0)
    np.testing.assert_allclose(run["series"]["nav"], (rep.account / rep.account.iloc[0]).to_numpy())
    assert run["summary"]["sharpe"] == pytest.approx(runs[0]["sharpe"])
    assert {t["side"] for t in run["trades"]} == {"buy", "sell"}
    assert all(t["symbol"].split(":")[0] in ("SSE", "SZSE") for t in run["trades"])


@qlib_engine
def test_backtest_rejects_bad_params(client):
    assert client.post("/api/backtest", json={"pool": "nope"}).status_code == 400
    assert client.post("/api/backtest", json={"pool": "momentum53", "signal": "EVIL"}).status_code == 400
    assert client.post("/api/backtest", json={"pool": "momentum53", "provider_uri": "/"}).status_code == 400
    assert client.post("/api/backtest", json={"pool": "momentum53", "signal_file": "/etc/passwd"}).status_code == 400
    assert client.get("/api/backtest/runs/../../etc").status_code == 404
    assert client.post("/api/backtest", json={"pool": "momentum53", "account": -5}).status_code == 400


def test_alert_defaults_to_one_month_expiry_and_expired_alerts_stop(client, fake_bars, store):
    import time as _t
    cond = {"left": {"kind": "price", "field": "close"}, "op": "greater_than", "right": {"kind": "value", "value": 1}}
    a = client.post("/api/alerts", json={"symbol": "S", "condition": cond}).json()
    assert abs(a["expires"] - (_t.time() + 30 * 86400)) < 60
    store.set_alert(a["id"], expires=_t.time() - 1)
    assert client.post("/api/alerts/check").json()["fired"] == []
    assert client.get("/api/alerts").json()[0]["active"] is False


def test_store_migrates_old_alert_table(tmp_path):
    import sqlite3
    from tvre.store import Store
    db = tmp_path / "old.sqlite3"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, timeframe TEXT NOT NULL, "
                "condition TEXT NOT NULL, trigger TEXT NOT NULL DEFAULT 'once', message TEXT NOT NULL DEFAULT '', "
                "active INTEGER NOT NULL DEFAULT 1, created REAL NOT NULL, last_bar INTEGER, last_fired REAL)")
    con.commit(); con.close()
    s = Store(db)
    assert s.create_alert("S", "D", {"op": "x"}, expires=123.0)["expires"] == 123.0
