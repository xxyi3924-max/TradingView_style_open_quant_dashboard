"""tvre.pine.optimize (search space, window metrics, Pine export, IS/OOS and walk-forward jobs) and the
strategy / optimiser HTTP endpoints."""
import math
import time

import numpy as np
import pandas as pd
import pytest

from tvre import bars as bars_mod, data
from tvre.pine import optimize as O
from tvre.pine.broker import LONG, Trade
from tvre.pine.runtime import InputSpec, Runtime
from tvre.providers import tradingview

CROSS = """//@version=6
strategy("SMA cross", overlay = true)
fastLen = input.int(5, "Fast", minval = 1)
slowLen = input(20, "Slow")
if ta.crossover(ta.sma(close, fastLen), ta.sma(close, slowLen))
    strategy.entry("L", strategy.long)
if ta.crossunder(ta.sma(close, fastLen), ta.sma(close, slowLen))
    strategy.close("L")
"""


def wave(n=600, seed=1):
    rng = np.random.default_rng(seed)
    c = 100 + 10 * np.sin(np.arange(n) / 15) + np.cumsum(rng.normal(0, 0.6, n))
    o = np.concatenate([[c[0]], c[:-1]])
    return [{"time": 1_500_000_000 + i * 86400, "open": float(o[i]), "high": float(max(o[i], c[i]) + 0.3),
             "low": float(min(o[i], c[i]) - 0.3), "close": float(c[i]), "volume": 1000.0} for i in range(n)]


def trade(t, profit, dd=0.0):
    return Trade("L", LONG, 10.0, t, 0, "x", 11.0, t + 1, 1, 1.0, profit, 0.0, max(profit, 0.0), dd)


# ------------------------------------------------------------------------------------- metrics
def test_window_metrics_split_partitions_trades():
    ts = [trade(100, 50), trade(200, -20, -30), trade(300, 40), trade(400, -10)]
    a, b = O.window_metrics(ts, 1000, 2, None, 250), O.window_metrics(ts, 1000, 2, 250, None)
    assert a["trades"] + b["trades"] == 4
    assert a["net_profit"] + b["net_profit"] == pytest.approx(60)
    assert b["return_pct"] == pytest.approx(30 / 1030)                  # equity at the split includes earlier trades
    assert a["profit_factor"] == pytest.approx(50 / 20) and a["win_rate"] == 0.5
    assert O.window_metrics([trade(1, 5)], 1000, 2)["profit_factor"] == O.PF_CAP   # no losses: capped, not inf


def test_combine_means_metrics_and_sums_trades():
    m = O.combine([{"trades": 3, "net_profit": 10.0}, {"trades": 5, "net_profit": 30.0}])
    assert m == {"trades": 8, "net_profit": 20.0}


# ------------------------------------------------------------------------------------- search space
def test_suggest_space_ranges_and_choices():
    specs = [InputSpec(0, "Len", "int", 12), InputSpec(1, "Mult", "float", 2.0, None, 0.001, 50),
             InputSpec(2, "Dir", "int", 0, None, -1, 1), InputSpec(3, "EMA", "bool", True),
             InputSpec(4, "Src", "source", "close"), InputSpec(5, "Style", "string", "ATR", ["ATR", "Range"]),
             InputSpec(6, "Note", "string", "free text"), InputSpec(7, "F", "float", 0.02, None, None, None, 0.001)]
    sp = {r["title"]: r for r in O.suggest_space(specs)}
    assert (sp["Len"]["low"], sp["Len"]["high"], sp["Len"]["step"]) == (6, 24, 1)
    assert (sp["Mult"]["low"], sp["Mult"]["high"], sp["Mult"]["step"]) == (1.0, 4.0, 0.2)
    assert (sp["Dir"]["low"], sp["Dir"]["high"]) == (-1, 1)                 # small declared range used as is
    assert sp["EMA"]["choices"] == [True, False] and not sp["EMA"]["enabled"]
    assert sp["Src"]["choices"][3] == "close" and sp["Style"]["choices"] == ["ATR", "Range"]
    assert "Note" not in sp and sp["F"]["step"] == 0.001                    # declared step kept


def test_space_validation():
    with pytest.raises(O.OptimizeError, match="at least one"):
        O._validate_space([{"title": "a", "enabled": False}])
    with pytest.raises(O.OptimizeError, match="low <= high"):
        O._validate_space([{"title": "a", "enabled": True, "kind": "range", "low": 5, "high": 1, "step": 1}])


# ------------------------------------------------------------------------------------- export
def test_export_rewrites_defaults_positional_and_defval():
    src = """//@version=6
strategy("t, with (comma)")
// input(99, "commented out") is not an input
a = input.int(defval = 5, title = "A, (x)", minval = 1)
b = input(20, "B")
c = input.float(2.0, "C", step = 0.5)
s = input.source(close, "S")
on = input.bool(true, "On")
plot(a + b + c)
"""
    res = Runtime(src, wave(5)).run()
    out = O.export_source(src, {"A, (x)": 7, "B": 33, "C": 2.5, "S": "hl2", "On": False}, res.inputs)
    assert 'input.int(defval = 7, title = "A, (x)", minval = 1)' in out
    assert 'input(33, "B")' in out and 'input.float(2.5, "C", step = 0.5)' in out
    assert 'input.source(hl2, "S")' in out and 'input.bool(false, "On")' in out
    assert '// input(99, "commented out")' in out


def test_export_leaves_unlisted_inputs_alone():
    res = Runtime(CROSS, wave(5)).run()
    out = O.export_source(CROSS, {"Slow": 30}, res.inputs)
    assert 'input.int(5, "Fast", minval = 1)' in out and 'input(30, "Slow")' in out


# ------------------------------------------------------------------------------------- jobs
def _wait(job, timeout=120):
    t = time.time()
    while job.status == "running" and time.time() - t < timeout:
        time.sleep(0.2)
    return job


SPACE = [{"title": "Fast", "type": "int", "default": 5, "enabled": True, "kind": "range", "low": 2, "high": 10, "step": 1},
         {"title": "Slow", "type": "int", "default": 20, "enabled": True, "kind": "range", "low": 15, "high": 40, "step": 5}]


def test_optimize_in_and_out_of_sample():
    ds = [{"symbol": "X", "bars": wave(), "mintick": 0.01, "qty_step": 1, "tz": "UTC"}]
    job = _wait(O.start(CROSS, ds, SPACE, objective="net_profit", trials=12, min_trades=3, oos_pct=30, workers=2))
    assert job.status == "done", job.error
    assert job.done == 12 and job.baseline["oos"] is not None
    lb = job.leaderboard
    assert lb and all(r["is"]["trades"] >= 3 and "oos" in r for r in lb)
    assert [r["value"] for r in lb] == sorted((r["value"] for r in lb), reverse=True)
    split = job.split_time[0]
    assert split == ds[0]["bars"][int(600 * 0.7)]["time"]
    # in-sample = a run that never saw the out-of-sample bars
    best = lb[0]["params"]
    res = Runtime(CROSS, ds[0]["bars"][:420], inputs=best).run()
    assert sum(t.profit for t in res.trades) == pytest.approx(lb[0]["is"]["net_profit"])


def test_optimize_walk_forward_and_cancel():
    ds = [{"symbol": "X", "bars": wave(seed=2), "mintick": 0.01, "qty_step": 1, "tz": "UTC"}]
    job = _wait(O.start(CROSS, ds, SPACE, objective="sharpe", trials=6, min_trades=1, folds=2, workers=2))
    assert job.status == "done", job.error
    wf = job.walk_forward
    assert [f["fold"] for f in wf["folds"]] == [1, 2] and job.total == 12
    oos = [f["oos"]["return_pct"] for f in wf["folds"] if f["oos"]]
    assert wf["total"]["return_pct"] == pytest.approx(math.prod(1 + r for r in oos) - 1)
    job2 = O.start(CROSS, ds, SPACE, trials=400, min_trades=1, workers=1)
    assert O.cancel(job2.id)
    assert _wait(job2).status == "cancelled" and job2.done < 400


def test_optimize_rejects_bad_requests():
    ds = [{"symbol": "X", "bars": wave(30), "mintick": 0.01, "qty_step": 1, "tz": "UTC"}]
    with pytest.raises(O.OptimizeError, match="50 bars"):
        O.start(CROSS, ds, SPACE)
    with pytest.raises(O.OptimizeError, match="objective"):
        O.start(CROSS, ds, SPACE, objective="vibes")


# ------------------------------------------------------------------------------------- HTTP
@pytest.fixture
def wave_feed(monkeypatch):
    b = wave()
    frame = pd.DataFrame(b)
    monkeypatch.setattr(data, "get_bars", lambda *a, **k: (frame.copy(), "local"))
    monkeypatch.setattr(tradingview, "symbol_info", lambda s: (_ for _ in ()).throw(tradingview.SidecarError(503, "down", "offline")))
    return b


def test_strategy_run_endpoint(client, wave_feed):
    r = client.post("/api/strategy/run", json={"symbol": "NASDAQ:X", "timeframe": "D", "script": {"source": CROSS}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meta"]["kind"] == "pine" and body["meta"]["name"] == "SMA cross"
    assert body["key_stats"]["closed_trades"] > 0 and [s["title"] for s in body["space"]] == ["Fast", "Slow"]
    assert body["trades"][0]["entry_label"] == "L" and body["trades"][0]["side"] == "long"
    bad = client.post("/api/strategy/run", json={"symbol": "NASDAQ:X", "script": {"source": "//@version=6\nstrategy(\"t\")\nx = (\n"}})
    assert bad.status_code == 422


def test_user_scripts_crud_and_run(client, wave_feed):
    assert client.post("/api/strategies/scripts", json={"source": '//@version=6\nindicator("x")\n'}).status_code == 400
    s = client.post("/api/strategies/scripts", json={"source": CROSS}).json()
    assert s["name"] == "SMA cross"
    assert client.get("/api/strategies/source", params={"id": f"user:{s['id']}"}).json()["source"] == CROSS
    r = client.post("/api/strategy/run", json={"symbol": "NASDAQ:X", "script": {"id": f"user:{s['id']}"}, "inputs": {"Fast": 3}})
    assert r.status_code == 200 and r.json()["inputs"][0]["title"] == "Fast"
    client.delete(f"/api/strategies/scripts/{s['id']}")
    assert client.get("/api/strategies/source", params={"id": f"user:{s['id']}"}).status_code == 404


def test_optimize_and_export_endpoints(client, wave_feed):
    j = client.post("/api/strategy/optimize", json={"script": {"source": CROSS}, "symbols": ["NASDAQ:X"], "space": SPACE,
                                                    "trials": 8, "min_trades": 2, "oos_pct": 25}).json()
    t = time.time()
    while j["status"] == "running" and time.time() - t < 120:
        time.sleep(0.3)
        j = client.get(f"/api/strategy/optimize/{j['id']}").json()
    assert j["status"] == "done", j["error"]
    assert j["leaderboard"] and j["leaderboard"][0]["oos"]["trades"] >= 0
    assert client.post("/api/strategy/optimize", json={"script": {"source": CROSS}, "symbols": []}).status_code == 400
    assert client.get("/api/strategy/optimize/nope").status_code == 404
    best = j["leaderboard"][0]["params"]
    ex = client.post("/api/strategy/export", json={"script": {"source": CROSS}, "values": best}).json()
    assert f'input.int({best["Fast"]}, "Fast", minval = 1)' in ex["source"] and ex["name"] == "SMA cross"
