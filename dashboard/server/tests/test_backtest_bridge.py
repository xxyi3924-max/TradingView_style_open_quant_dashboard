"""The qlib bridge must reproduce the engine's native path exactly (run with -m slow; ~30 s).

Native path = what `python -m etf_rotation.research.qlib_backtest` does in main(): ensure_qlib() then
run_backtest(BacktestConfig(...)). It runs in its own interpreter, into its own namespace, so no
existing run directory is touched.
"""
import json
import os
import subprocess

import numpy as np
import pandas as pd
import pytest

from tvre import backtest, config

from .conftest import qlib_engine

pytestmark = [pytest.mark.slow, qlib_engine]

PARAMS = {"pool": "momentum53", "signal": "MOM_12_1", "topk": 5, "rebalance_days": 5, "start": "2022-01-04",
          "open_cost": 0.0006, "close_cost": 0.0006}
NATIVE = """
import json, sys
from etf_rotation.research.qlib_backtest import BacktestConfig, ensure_qlib, run_backtest
ensure_qlib()
print("NATIVE " + json.dumps(run_backtest(BacktestConfig(**json.loads(sys.argv[1]))), default=str))
"""


@pytest.fixture(scope="module")
def bridge_run():
    job = backtest.start(PARAMS, wait=True)
    assert job["status"] == "done", job.get("error")
    return job


def test_bridge_matches_native_engine(bridge_run):
    env = {**os.environ, "PYTHONPATH": str(config.WORK_QUANT)}
    out = subprocess.run([str(config.VENV_PYTHON), "-c", NATIVE, json.dumps({**PARAMS, "output_namespace": "tvre_native"})],
                         cwd=config.WORK_QUANT, env=env, capture_output=True, text=True, timeout=1800)
    assert out.returncode == 0, out.stderr[-2000:]
    native = json.loads(next(l for l in out.stdout.splitlines() if l.startswith("NATIVE "))[7:])
    for k in ("annual_return", "sharpe", "max_drawdown", "total_cost", "n_days", "excess_annual_return"):
        assert bridge_run["summary"][k] == pytest.approx(native[k], rel=1e-12, abs=1e-15), k
    a = pd.read_csv(config.ETF_POOLS_ROOT / bridge_run["run_id"] / "report.csv", index_col=0)
    b = pd.read_csv(native["output_dir"] + "/report.csv", index_col=0)
    np.testing.assert_array_equal(a.account.to_numpy(), b.account.to_numpy())


def test_api_view_of_run_equals_engine_files(client, bridge_run):
    run = client.get(f"/api/backtest/runs/{bridge_run['run_id']}").json()
    d = config.ETF_POOLS_ROOT / bridge_run["run_id"]
    rep = pd.read_csv(d / "report.csv", index_col=0)
    np.testing.assert_allclose(run["series"]["nav"], (rep.account / rep.account.iloc[0]).to_numpy(), rtol=1e-12)
    summary = json.loads((d / "summary.json").read_text())
    assert run["summary"]["sharpe"] == pytest.approx(summary["sharpe"])
    # every trade marker corresponds to a holdings change
    h = pd.read_csv(d / "holdings.csv", encoding="utf-8-sig")
    held = h[h.amount > 0].groupby("date").instrument.apply(set)
    dates = list(held.index)
    for t in run["trades"]:
        i = dates.index(t["date"])
        assert (t["instrument"] in held.iloc[i]) == (t["side"] == "buy")
        if i:
            assert (t["instrument"] in held.iloc[i - 1]) == (t["side"] == "sell")


def test_bridge_is_deterministic(bridge_run):
    again = backtest.start(PARAMS, wait=True)
    assert again["summary"]["sharpe"] == bridge_run["summary"]["sharpe"]
