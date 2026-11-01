"""QuantiFi runs (tools/backtest.py output) as Strategy Reports, and the hackathon books as chart bars.

Synthetic root: one product X over two days of 4 ticks.
  day -2 mids 100, 102, 104, 103: buy 5 @ 101 at t0 (taken), sell 5 @ 104 at t200 (taken) -> +15
  day -1 mids 50, 51, 49, 50:     sell 2 @ 51 at t100 (resting), still short at the end, marked at 50 -> +2
Equity per tick (carried across days): -5, 5, 15, 15 | 15, 15, 19, 17.
A stress scenario of it (h 10, 50% liquidity) sits in stress/h10_s50_d0/: the buy settles at 101.5 (push 0.5) -> +14.5.
"""
import json
import subprocess
from pathlib import Path

import pytest

from tvre import config, quantifi

PRICES_HEAD = "day;timestamp;product;bid_price_1;bid_volume_1;bid_price_2;bid_volume_2;bid_price_3;bid_volume_3;" \
              "ask_price_1;ask_volume_1;ask_price_2;ask_volume_2;ask_price_3;ask_volume_3;mid_price;profit_and_loss"
MIDS = {-2: [100, 102, 104, 103], -1: [50, 51, 49, 50]}
RUN = "quantifi:x/20260101-000000"
SCENARIO = RUN + "/stress/h10_s50_d0"


def write_run(run, stress, fills, equity, summary):
    run.mkdir(parents=True)
    (run / "meta.json").write_text(json.dumps({
        "strategy": "x", "label": "x.py", "path": "submission/x.py", "days": [-2, -1], "tte": {"-2": 8.0, "-1": 7.0},
        "created": "2026-01-01 00:00:00", "seconds": 1.0, "stress": stress, "lambda": {"X": 0.1}, "limits": {"X": 50},
        "errors": 0, "first_error": "", "rejected": 0, "day_pnl": {}, "has_greeks": False, "constants": {}, "rules": "",
        "summary": {**summary, "push_cost": sum(f[5] for f in fills)}}))
    (run / "fills.csv").write_text("day,timestamp,product,qty,price,kind,push\n"
                                   + "".join(f"{d},{t},X,{q},{p},{k},{u}\n" for d, t, q, p, k, u in fills))
    days = [(-2, t) for t in (0, 100, 200, 300)] + [(-1, t) for t in (0, 100, 200, 300)]
    (run / "equity.csv").write_text("day,timestamp,pnl\n" + "".join(f"{d},{t},{v}\n" for (d, t), v in zip(days, equity)))
    (run / "greeks.csv").write_text("day,timestamp,spot,opt_delta,lychee,net_delta,gamma,vega,theta\n")
    (run / "indicators.csv").write_text("day,timestamp,key,value\n-2,0,x.ema,100.5\n-2,100,x.ema,101.5\n-2,0,sig,0\n-2,200,sig,1\n"
                                        "-2,0,quote.bid.X,99\n-2,100,quote.bid.X,\n")


@pytest.fixture
def root(tmp_path, monkeypatch):
    data = tmp_path / "Data"
    data.mkdir()
    for day, mids in MIDS.items():
        rows = [PRICES_HEAD] + [f"{day};{i * 100};X;{m - 1};5;;;;;{m + 1};5;;;;;{m}.0;0.0" for i, m in enumerate(mids)]
        (data / f"prices_day_{day}.csv").write_text("\n".join(rows) + "\n")
        (data / f"trades_day_{day}.csv").write_text("timestamp;buyer;seller;symbol;currency;price;quantity\n"
                                                    f"100;;;X;COINS;{mids[1] + 1};3\n")
    sub = tmp_path / "submission"
    sub.mkdir()
    (sub / "x.py").write_text("class Trader:\n    def run(self, state):\n        return {}, 0, ''\n")
    (sub / "datamodel.py").write_text("class Order: pass\n")
    run = tmp_path / "runs" / "x" / "20260101-000000"
    write_run(run, stress=None, fills=[(-2, 0, 5, 101, "take", 0.0), (-2, 200, -5, 104, "take", 0.0), (-1, 100, -2, 51, "passive", 0.0)],
              equity=[-5, 5, 15, 15, 15, 15, 19, 17], summary={"pnl": 17.0, "sharpe": None, "max_drawdown": 5.0, "fills": 3})
    write_run(run / "stress" / "h10_s50_d0", stress={"half_life": 10, "share": 0.5, "delay": 0, "label": "h10_s50_d0"},
              fills=[(-2, 0, 5, 101.5, "take", 2.5), (-2, 200, -5, 104, "take", 0.0), (-1, 100, -2, 51, "passive", 0.0)],
              equity=[-7.5, 2.5, 12.5, 12.5, 12.5, 12.5, 16.5, 14.5], summary={"pnl": 14.5, "sharpe": None, "max_drawdown": 7.5, "fills": 3})
    monkeypatch.setattr(config, "QUANTIFI_ROOT", tmp_path)
    quantifi.clear_caches()
    return tmp_path


def test_bars_are_mid_ohlc_with_one_tick_per_second_and_a_day_per_date(root):
    df = quantifi.get_bars("QUANTIFI:X", "1S", 100)
    assert df["close"].tolist() == [100, 102, 104, 103, 50, 51, 49, 50]
    assert df["time"].iloc[1] - df["time"].iloc[0] == 1
    assert df["time"].iloc[4] - df["time"].iloc[0] == 86400
    assert df["volume"].tolist() == [0, 3, 0, 0, 0, 3, 0, 0]


def test_bars_aggregate_ticks_into_longer_buckets(root):
    df = quantifi.get_bars("QUANTIFI:X", "5S", 100)
    assert df[["open", "high", "low", "close"]].values.tolist() == [[100, 104, 100, 103], [50, 51, 49, 50]]


def test_search_finds_products(root):
    assert [r["id"] for r in quantifi.search("x")] == ["QUANTIFI:X"]


def test_strategies_are_files_defining_a_trader(root):
    assert [s["path"] for s in quantifi.strategies()] == ["submission/x.py"]


def test_runs_are_listed_with_their_summary(root):
    runs = quantifi.list_runs()
    assert [(r["id"], r["market"], r["pnl"]) for r in runs] == [(RUN, "quantifi", 17.0)]     # scenarios stay out of the list


def test_report_reconciles_trips_products_and_equity(root):
    r = quantifi.report(RUN)
    assert r["meta"]["kind"] == "quantifi"
    assert r["key_stats"]["total_pnl"] == 17
    assert r["key_stats"]["max_drawdown"] == 5          # from the flat start down to -5
    trips = r["trades"]
    assert [(t["side"], t["pnl"], t["open"]) for t in trips] == [("long", 15, False), ("short", 2, True)]
    assert trips[0]["runup"] == 15 and trips[0]["drawdown"] == -5
    assert sum(t["pnl"] for t in trips) == r["key_stats"]["total_pnl"]
    assert r["breakdown"]["profits_by_instrument"][0]["pnl"] == 17
    assert r["quantifi"]["stress"] is None and r["quantifi"]["lambda"] == {"X": 0.1}
    assert [d["pnl"] for d in r["quantifi"]["by_day"]] == [15, 2]


def test_a_scenario_run_reports_its_stress_and_the_website_run_beside_it(root):
    r = quantifi.report(SCENARIO)
    q = r["quantifi"]
    assert q["stress"]["label"] == "h10_s50_d0" and q["push_cost"] == 2.5
    assert r["key_stats"]["total_pnl"] == 14.5
    assert [t["pnl"] for t in r["trades"]] == [12.5, 2]          # the pushed buy price flows into the holding period
    assert q["website"]["run"] == RUN and q["website"]["total_pnl"] == 17 and q["website"]["max_drawdown"] == 5


def test_scenarios_reuse_a_finished_run_and_start_a_job_otherwise(root, monkeypatch):
    assert quantifi.scenario(RUN, 10, 0.5, 0) == {"status": "done", "run_id": SCENARIO}
    calls = []

    def fake(cmd, **kw):
        calls.append(cmd)
        write_run(Path(cmd[cmd.index("--out") + 1]), stress={"half_life": None, "share": 0.25, "delay": 1, "label": "hinf_s25_d1"},
                  fills=[], equity=[0] * 8, summary={"pnl": 0.0, "sharpe": None, "max_drawdown": 0.0, "fills": 0})
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(quantifi.subprocess, "run", fake)
    job = quantifi.scenario(RUN, None, 0.25, 1, wait=True)
    assert job["status"] == "done" and job["run_id"] == RUN + "/stress/hinf_s25_d1"
    assert calls[0][calls[0].index("--stress") + 1] == "h=inf,share=0.25,delay=1"
    with pytest.raises(ValueError):
        quantifi.scenario(RUN, 7, 0.5, 0)                           # not one of the stops


def test_instrument_detail_lists_every_fill_with_its_action(root):
    d = quantifi.instrument_detail(RUN, "X")
    assert [(o["action"], o["qty"], o["position"]) for o in d["operations"]] == \
           [("buy", 5, 5), ("sell", -5, 0), ("short", -2, -2), ("open", 0, -2)]
    assert d["operations"][1]["trip_pnl"] == 15
    assert d["summary"]["pnl"] == 17
    assert d["pnl_series"]["value"][-1] == 17


def test_api_routes_serve_quantifi_runs(client, root):
    assert client.get("/api/bars", params={"symbol": "QUANTIFI:X", "timeframe": "1S"}).json()["source"] == "quantifi"
    assert client.get(f"/api/backtest/report/{SCENARIO}").json()["key_stats"]["total_pnl"] == 14.5
    assert client.get("/api/backtest/instrument", params={"run": RUN, "instrument": "X"}).json()["summary"]["pnl"] == 17
    assert RUN in [r["id"] for r in client.get("/api/backtest/runs").json()]
    assert client.get("/api/quantifi/strategies").json()[0]["path"] == "submission/x.py"


def test_scenario_routes(client, root):
    stops = client.get("/api/quantifi/stress-stops").json()
    assert stops["half_life"][0] == 0 and stops["half_life"][-1] is None and stops["share"][0] == 1.0
    r = client.post("/api/quantifi/scenario", json={"run": RUN, "half_life": 10, "share": 0.5, "delay": 0}).json()
    assert r == {"status": "done", "run_id": SCENARIO}
    assert client.post("/api/quantifi/scenario", json={"run": RUN, "half_life": 7, "share": 0.5, "delay": 0}).status_code == 400


def test_overlay_puts_strategy_numbers_on_the_product_chart(root):
    o = quantifi.overlay(RUN, "X")
    lines = {(l["group"], l["label"]): l for l in o["lines"]}
    assert lines[("ema", "ema")]["pane"] == "price"               # x.ema belongs to X and tracks its price
    assert lines[("sig", "sig")]["pane"] == "sig"                 # a global number that is not a price gets its own pane
    assert lines[("Your quotes", "bid")]["value"] == [99, None]
    assert lines[("Book", "bid")]["value"][0] == 99
    pos = lines[("Position", "position")]
    t = quantifi.time_of
    assert list(zip(pos["time"], pos["value"])) == [(t(-2, 0), 5), (t(-2, 200), 0), (t(-1, 0), 0), (t(-1, 100), -2)]


def test_overlay_route(client, root):
    r = client.get("/api/backtest/overlay", params={"run": RUN, "product": "X"}).json()
    assert r["symbol"] == "QUANTIFI:X" and r["lines"]
