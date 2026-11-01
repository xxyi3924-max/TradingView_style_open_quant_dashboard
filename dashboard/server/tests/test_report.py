"""Strategy-report metrics: exact on a synthetic run, reconciling on a real qlib run."""
import json

import numpy as np
import pandas as pd
import pytest

from tvre import config, report

from .conftest import qlib_engine


def write_bins(root, closes: dict[str, list[float]], dates: list[str]):
    (root / "calendars").mkdir(parents=True)
    (root / "calendars" / "day.txt").write_text("\n".join(dates) + "\n")
    for inst, px in closes.items():
        d = root / "features" / inst.lower()
        d.mkdir(parents=True)
        np.array([0, *px], dtype="<f4").tofile(d / "close.day.bin")


@pytest.fixture
def synthetic_run(tmp_path):
    """Two instruments, 6 days. A: held d0-d1, sold d2 (+1/unit/day). B: bought d2, held to the end (open)."""
    dates = [f"2024-01-0{i}" for i in range(1, 7)]
    a = [10, 11, 12, 13, 14, 15]
    b = [20, 19, 18, 19, 20, 22]
    write_bins(tmp_path / "qlib", {"SH000001": a, "SH000002": b}, dates)
    run = tmp_path / "run"
    run.mkdir()
    rows = [(d, "SH000001", 100, a[i]) for i, d in enumerate(dates[:2])] + \
           [(d, "SH000002", 50, b[i]) for i, d in enumerate(dates[2:], start=2)]
    pd.DataFrame(rows, columns=["date", "instrument", "amount", "price"]).assign(name="x").to_csv(run / "holdings.csv", index=False)
    initial = 10_000.0
    cost = 5.0
    # equity: cash + positions; A pnl d1 +100, d2 +100 (sold at 12); B pnl from d3: 50*(19-18), (20-19), (22-20)
    pnl_daily = [0, 100, 100, 50, 50, 100]
    equity = initial - cost + np.cumsum(pnl_daily)
    bench = [0.0, 0.01, -0.01, 0.0, 0.02, 0.0]
    pd.DataFrame({"account": equity, "bench": bench, "total_cost": cost}, index=dates).rename_axis("datetime").to_csv(run / "report.csv")
    (run / "config.json").write_text(json.dumps({"account": initial, "provider_uri": str(tmp_path / "qlib"), "pool": "p", "signal": "S"}))
    return run


def test_round_trips_exact(synthetic_run):
    r = report.build(synthetic_run)
    t = r["trades"]
    assert [(x["instrument"], x["entry_date"], x["exit_date"], x["open"]) for x in t] == [
        ("SH000001", "2024-01-01", "2024-01-03", False), ("SH000002", "2024-01-03", "2024-01-06", True)]
    assert t[0]["exit_price"] == 12 and t[0]["pnl"] == pytest.approx(200)       # 100 x (12 - 10)
    assert t[1]["pnl"] == pytest.approx(50 * (22 - 18))                           # open, marked at last close
    assert t[0]["return_pct"] == pytest.approx(0.2)


def test_key_stats_and_reconciliation(synthetic_run):
    r = report.build(synthetic_run)
    k, b = r["key_stats"], r["breakdown"]
    assert k["total_pnl"] == pytest.approx(400 - 5)
    assert b["gross_profit"] - b["gross_loss"] - b["commission"] == pytest.approx(k["total_pnl"])
    assert k["closed_trades"] == 1 and k["wins"] == 1 and k["profitable_pct"] == 1.0
    assert k["profit_factor"] is None                                             # no losing trade
    assert r["benchmarking"]["buy_hold_return"] == pytest.approx(np.prod([1, 1.01, 0.99, 1, 1.02, 1]) - 1)


def test_episodes():
    eq = pd.Series([100, 110, 99, 105, 120, 108, 118], index=pd.bdate_range("2024-01-01", periods=7).strftime("%Y-%m-%d"))
    ups, dds = report._episodes(eq)
    assert [round(x["pct"], 4) for x in dds] == [round(99 / 110 - 1, 4), round(108 / 120 - 1, 4)]
    assert dds[0]["recovered"] is not None and dds[1]["recovered"] is None          # last one still open
    assert [round(x["pct"], 4) for x in ups] == [0.1, round(120 / 99 - 1, 4), round(118 / 108 - 1, 4)]


def test_streaks():
    assert report._streaks([True, True, False, True, False, False, False]) == {
        "max_win": 2, "max_loss": 3, "avg_win": 1.5, "avg_loss": 2.0}


def _runs(client, q):
    return client.get("/api/backtest/runs", params={"pool": "momentum53", "q": q}).json()


def test_clean_run_reconciles_exactly(client):
    """No backfilled/suspended instruments: trade P&L - commissions == account P&L, to the cent."""
    runs = [r for r in _runs(client, "mom_12_1_top5_h5_open6bp") if "/tvre/" in r["id"] or "/tvre_native/" in r["id"]]
    if not runs:
        pytest.skip("run tests/test_backtest_bridge.py (-m slow) first to create the clean run")
    r = client.get(f"/api/backtest/report/{runs[0]['id']}").json()
    assert abs(r["breakdown"]["unattributed"]) < 1.0
    assert r["breakdown"]["stale_trades"] == 0


@qlib_engine
def test_stale_priced_run_reports_unattributed(client):
    """The masked run holds QDII proxies the engine sometimes prices stale; the gap is reported, not hidden."""
    run = _runs(client, "mom_12_1_(masked)")[0]
    r = client.get(f"/api/backtest/report/{run['id']}").json()
    k, b = r["key_stats"], r["breakdown"]
    assert b["unattributed"] == pytest.approx(k["total_pnl"] - (b["gross_profit"] - b["gross_loss"] - b["commission"]))
    assert b["stale_trades"] > 0 and abs(b["unattributed"]) / k["total_pnl"] < 0.1
    s = json.loads((config.ETF_POOLS_ROOT / run["id"] / "summary.json").read_text())
    assert k["max_drawdown_pct"] == pytest.approx(-s["max_drawdown"], rel=1e-6)
    assert k["closed_trades"] > 50 and len(r["periodical"]["yearly"]) >= 8


def test_trade_excursions(tmp_path):
    """C: 10 units at 10, 9, 12, exit at 11 -> path 0, -10, +20, +10: run-up 20, drawdown -10."""
    dates = [f"2024-02-0{i}" for i in range(1, 6)]
    c = [10, 9, 12, 11, 11]
    write_bins(tmp_path / "qlib", {"SH000003": c}, dates)
    run = tmp_path / "run"
    run.mkdir()
    pd.DataFrame([(d, "SH000003", 10, c[i]) for i, d in enumerate(dates[:3])], columns=["date", "instrument", "amount", "price"]) \
        .assign(name="c").to_csv(run / "holdings.csv", index=False)
    eq = 1000 + np.array([0, -10, 20, 10, 10])
    pd.DataFrame({"account": eq, "bench": 0.0, "total_cost": 0.0}, index=dates).rename_axis("datetime").to_csv(run / "report.csv")
    (run / "config.json").write_text(json.dumps({"account": 1000, "provider_uri": str(tmp_path / "qlib")}))
    t = report.build(run)["trades"][0]
    assert (t["pnl"], t["runup"], t["drawdown"]) == (pytest.approx(10), pytest.approx(20), pytest.approx(-10))


def test_instrument_detail_reconciles(synthetic_run):
    rep = report.build(synthetic_run)
    for row in rep["breakdown"]["profits_by_instrument"]:
        d = report.instrument_detail(synthetic_run, row["instrument"])
        assert d["summary"]["pnl"] == pytest.approx(row["pnl"], abs=1e-6)           # same P&L as the breakdown
        assert d["operations"][-1]["cum_pnl"] == pytest.approx(d["summary"]["pnl"], abs=1e-6)
        qty = sum(o["qty"] for o in d["operations"])
        assert qty == pytest.approx(d["summary"]["open_qty"], abs=1e-6)             # buys - sells = position now
        assert d["operations"][0]["action"] == "buy"
    with pytest.raises(KeyError):
        report.instrument_detail(synthetic_run, "SH999999")
