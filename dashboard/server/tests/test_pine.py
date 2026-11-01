"""tvre.pine: parser, series semantics, streaming ta.* (== tvre.indicators), broker rules, and the
TradingView strategy-parity regression (runs only where the captured reports exist, re/raw is gitignored)."""
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from tvre import indicators
from tvre.pine.broker import LONG, SHORT, Broker, Order, Props
from tvre.pine.parser import PineSyntaxError, parse
from tvre.pine.runtime import Runtime

ROOT = Path(__file__).resolve().parents[2]


def bars(closes, spread=0.5):
    out = []
    for i, c in enumerate(closes):
        o = closes[i - 1] if i else c
        out.append({"time": 1_600_000_000 + i * 86400, "open": o, "high": max(o, c) + spread, "low": min(o, c) - spread,
                    "close": c, "volume": 1000})
    return out


def run(src, data, **kw):
    kw.setdefault("mintick", 0.01)
    return Runtime(src, data, **kw).run()


# ------------------------------------------------------------------------------------- parser
def test_parser_blocks_continuations_functions_tuples():
    s = parse("""//@version=6
strategy("t")
f(a, b) =>
    x = a + b
    x * 2
[p, q] = [1, 2]
y = f(p, q) +
  1
if y > 3
    z = 1
else if y > 1
    z = 2
else
    z = 3
""")
    assert s.version == 6 and len(s.body) == 5


def test_parser_reports_library_imports():
    with pytest.raises(PineSyntaxError, match="import"):
        parse('//@version=6\nstrategy("t")\nimport TradingView/ta/7 as t\n')


# ------------------------------------------------------------------------------------- series semantics
def test_history_var_and_reassignment():
    src = """//@version=6
strategy("t")
var cnt = 0
cnt += 1
up = 0.0
up := close > close[1] ? nz(up[1]) + 1 : 0
plot(cnt, "cnt")
plot(up, "up")
plot(close[2], "c2")
"""
    data = bars([1, 2, 3, 2, 3, 4, 5])
    r = run(src, data)
    assert r.plots["cnt"] == [1, 2, 3, 4, 5, 6, 7]
    assert r.plots["up"] == [0, 1, 2, 0, 1, 2, 3]
    assert r.plots["c2"][:3] == [None, None, 1]


def test_user_function_call_sites_keep_separate_state():
    src = """//@version=6
strategy("t")
mom(s, n) => s - s[n]
a = mom(close, 1)
b = mom(a, 1)
plot(a, "a")
plot(b, "b")
"""
    r = run(src, bars([1, 3, 6, 10, 15]))
    assert r.plots["a"] == [None, 2, 3, 4, 5]
    assert r.plots["b"] == [None, None, 1, 1, 1]


def test_float_noise_compares_equal():
    # (3.52-3.523) - (3.539-3.542) is -4.4e-16 in floats; Pine treats it as 0 (Momentum strategy parity)
    src = """//@version=6
strategy("t")
d = (3.52 - 3.523) - (3.539 - 3.542)
plot(d < 0 ? 1 : 0, "neg")
plot(d == 0 ? 1 : 0, "zero")
"""
    r = run(src, bars([1, 2]))
    assert r.plots["neg"] == [0, 0] and r.plots["zero"] == [1, 1]


# ------------------------------------------------------------------------------------- ta == tvre.indicators
@pytest.mark.parametrize("fn,kw,key", [
    ("ta.ema(close, 10)", None, "ema"), ("ta.sma(close, 10)", None, "sma"), ("ta.rsi(close, 14)", None, "rsi"),
    ("ta.atr(14)", None, "atr"),
])
def test_streaming_ta_matches_reference(fn, kw, key):
    rng = np.random.default_rng(3)
    closes = list(100 + np.cumsum(rng.normal(0, 1, 300)))
    data = bars(closes)
    r = run(f'//@version=6\nstrategy("t")\nplot({fn}, "v")\n', data)
    df = pd.DataFrame(data)
    ref = {"ema": lambda: indicators.ema(df["close"], 10), "sma": lambda: indicators.sma(df["close"], 10),
           "rsi": lambda: indicators.rsi(df["close"], 14), "atr": lambda: indicators.atr(df["high"], df["low"], df["close"], 14)}[key]()
    ref = np.asarray(ref, dtype=float)
    got = np.array([np.nan if v is None else v for v in r.plots["v"]])
    mask = ~np.isnan(ref)
    assert np.array_equal(mask, ~np.isnan(got))
    assert np.allclose(got[mask], ref[mask], rtol=0, atol=1e-9)


def test_pivots_tie_rule():
    # at least as high as the left bars, strictly higher than the right bars
    src = '//@version=6\nstrategy("t")\nplot(ta.pivothigh(high, 2, 2), "ph")\n'
    data = bars([1, 1, 1, 1, 1, 1, 1], spread=0)
    for b, h in zip(data, [1, 3, 3, 2, 1, 1, 1]):
        b["high"] = h
    r = run(src, data)
    assert r.plots["ph"][4] == 3      # bar 2 (=3) >= bar 1 (=3) on the left, > bars 3-4 on the right
    assert r.plots["ph"][3] is None   # bar 1 (=3) is not strictly above bar 2 (=3) on its right


# ------------------------------------------------------------------------------------- broker
def broker(**props):
    b = Broker(Props.from_dict({"initial_capital": 100_000, **props}), mintick=0.001, qty_step=1)
    b.close = 2.386
    return b


def test_default_size_floor_at_signal_close():
    assert broker().default_qty(2.386) == math.floor(100_000 / 2.386)


def test_stop_prices_round_against_the_trader():
    b = broker()
    assert b.rt_order(2.5621, LONG, "stop") == 2.563
    assert b.rt_order(2.5409, SHORT, "stop") == 2.540
    cents = Broker(Props(), mintick=0.01, qty_step=1)
    assert cents.rt(145.265) == 145.26                               # 145.265/0.01 = 14526.4999... in floats
    assert cents.rt(0.125) == 0.13                                   # halves round up


def test_margin_call_liquidates_four_times_the_cover():
    # TradingView MACD 510300 2012-08-20: short 41964 @2.333, equity 97904.45 -> call at 2.343 of 1428
    b = broker()
    b.realized = 97_904.45 - 100_000
    b._open(Order("MacdSE", "entry", SHORT, 41964, None, None, "", "none", "MacdSE", 0, 0), 41964, 2.333)
    b._margin_check(2.343)
    assert b.margin_calls == 1 and b.trades[-1].qty == 1428 and b.trades[-1].exit_label == "Margin call"


def test_margin_call_cover_ignores_float_dust():
    # TradingView AAPL MACD 1984-08-03: cover 2971.92 / 0.12 = 24766 exactly; with P&L dust in the realized
    # balance the float quotient is 24765.99999999991 and must not truncate to 24765 (call 99064, not 99060)
    b = Broker(Props.from_dict({"initial_capital": 100_000}), mintick=0.01, qty_step=1)
    b._open(Order("MacdSE", "entry", SHORT, 148596, None, None, "", "none", "MacdSE", 0, 0), 148596, 0.11)
    b.realized = -83654.44 + 1e-11
    avail = 100_000 + b.realized - 148596 * (0.12 - 0.11) - 148596 * 0.12
    assert math.floor(abs(avail) / 0.12) == 24765                    # the dust is there
    b._margin_check(0.122768)
    assert b.trades[-1].qty == 99064


def test_price_orders_trigger_on_the_tick_grid():
    # TradingView AAPL Greedy 1980-12-18: a buy stop at high[1] = 0.112723 (0.12 on a 0.01 tick) is filled at
    # the open 0.118861 -> 0.12; comparing the raw open with the rounded stop would miss it
    src = """//@version=6
strategy("t")
if bar_index == 1
    strategy.entry("L", strategy.long, stop = 0.112723)
"""
    data = [{"time": 1_600_000_000 + i * 86400, "open": c, "high": c, "low": c, "close": c, "volume": 1} for i, c in
            enumerate([0.115513, 0.112723, 0.118861, 0.126116])]
    r = run(src, data)
    t = (r.trades + r.open_trades)[0]
    assert t.entry_time == data[2]["time"] and t.entry_price == 0.12


def test_funding_verdicts():
    b = broker()
    od = Order("x", "entry", LONG, 41_911, None, None, "", "none", "", 0, 0, equity=100_000, ref=2.386)
    assert b._funding(od, 2.383) == "ok"
    assert b._funding(od, 2.390) == "reject"                         # filled above the signal close
    sell_stop = Order("s", "entry", SHORT, 39_400, None, 2.540, "", "none", "", 0, 0, equity=100_078.032, ref=2.565)
    assert b._funding(sell_stop, 2.540) == "close_only"              # sized at the stop, valued at the close


# ------------------------------------------------------------------------------------- TradingView parity regression
EXACT = json.loads((Path(__file__).with_name("strategy_parity_exact.json")).read_text())
HAVE_FIXTURES = (ROOT / "re" / "raw" / "strategy_reports").exists()


@pytest.mark.skipif(not HAVE_FIXTURES, reason="TradingView strategy reports not captured (re/raw is gitignored)")
@pytest.mark.parametrize("name", EXACT)
def test_strategy_matches_tradingview_trade_for_trade(name):
    sys.path.insert(0, str(ROOT / "server" / "scripts"))
    import strategy_parity as sp
    o = sp.compare(json.loads((sp.RAW / "strategy_reports" / name).read_text()))
    assert o.matched == o.tv_trades == o.our_trades, o.first_diff


RATIOS_EXACT = json.loads((Path(__file__).with_name("strategy_ratios_exact.json")).read_text())


@pytest.mark.skipif(not HAVE_FIXTURES, reason="TradingView strategy reports not captured (re/raw is gitignored)")
@pytest.mark.parametrize("name", RATIOS_EXACT)
def test_sharpe_sortino_match_tradingview(name):
    sys.path.insert(0, str(ROOT / "server" / "scripts"))
    import strategy_parity as sp
    o = sp.compare(json.loads((sp.RAW / "strategy_reports" / name).read_text()))
    assert o.ratios_exact, (o.sharpe_ours, o.sharpe_tv, o.sortino_ours, o.sortino_tv)
