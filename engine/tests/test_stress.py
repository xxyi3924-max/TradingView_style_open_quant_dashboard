import math

from tools import backtest as bt
from tools import stress


def test_the_grid_covers_every_stop_and_includes_the_website():
    grid = stress.scenarios()
    assert len(grid) == 6 * 5 * 2
    assert bt.Stress(0, 1.0, 0) in grid
    assert bt.Stress(math.inf, 0.1, 1) in grid


def cell(h, s, d, pnl):
    return {"half_life": h, "share": s, "delay": d, "label": bt.Stress(math.inf if h is None else h, s, d).label(),
            "pnl": pnl, "max_drawdown": 0.0, "sharpe": None, "fills": 1, "volume": 1, "taken_volume": 1, "push_cost": 0.0}


def test_markdown_tables_show_pnl_and_share_of_the_website_pnl():
    grid = {"label": "x.py", "website": {"pnl": 200.0}, "lambda": {"X": 0.1},
            "axes": {"half_life": [0, None], "share": [1.0, 0.5], "delay": [0]},
            "cells": [cell(0, 1.0, 0, 200.0), cell(None, 1.0, 0, 100.0), cell(0, 0.5, 0, 150.0), cell(None, 0.5, 0, -50.0)]}
    md = stress.markdown(grid)
    assert "| liquidity share | h 0 | h ∞ |" in md
    assert "| 100% | 200 (100%) | 100 (50%) |" in md
    assert "| 50% | 150 (75%) | −50 (−25%) |" in md


def test_the_old_k_ln_q_charge_is_recomputed_from_a_runs_taken_fills():
    fills = [(-2, 100, "X", 3, "take"), (-2, 100, "X", 2, "take"),      # one tick, one side: Q = 5
             (-2, 200, "X", -1, "take"),                                 # a 1-lot take pays nothing (ln 1 = 0)
             (-2, 300, "X", 4, "passive")]                               # resting fills paid nothing
    assert math.isclose(stress.klnq_cost(fills, {"X": 2.0}), 2.0 * 5 * math.log(5))


def test_the_summary_compares_website_old_model_and_reference_scenarios():
    grid = {"label": "x.py", "website": {"pnl": 200.0}, "lambda": {},
            "cells": [cell(10, 0.75, 0, 150.0), cell(100, 0.5, 0, 50.0), cell(1000, 0.25, 1, -100.0), cell(0, 1.0, 0, 200.0)]}
    md = stress.summary([(grid, 120.0)])
    assert "| x.py | 200 | 120 (60%) | 150 (75%) | 50 (25%) | −100 (−50%) | 3 of 4 | −100 |" in md
