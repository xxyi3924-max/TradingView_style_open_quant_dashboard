import json
import math

from datamodel import Order, OrderDepth, Trade

from tools import backtest as bt


def depth(bids, asks):
    return OrderDepth(buy_orders=dict(bids), sell_orders={p: -v for p, v in asks.items()})


# ------------------------------------------------------------------ website fill rules
def test_crossing_buy_walks_the_ask_levels_up_to_its_price():
    fills, rejected = bt.match_product([Order("X", 102, 8)], depth({99: 5}, {101: 3, 102: 4, 103: 9}), [], 0, 50)
    assert not rejected
    assert [(f.price, f.qty, f.kind) for f in fills] == [(101, 3, "take"), (102, 4, "take")]


def test_crossing_sell_walks_the_bid_levels_down_to_its_price():
    fills, _ = bt.match_product([Order("X", 98, -6)], depth({99: 2, 98: 3, 97: 9}, {101: 5}), [], 0, 50)
    assert [(f.price, f.qty) for f in fills] == [(99, -2), (98, -3)]


def test_resting_buy_fills_at_its_own_price_on_a_trade_at_or_below_it():
    tape = [Trade("X", 99, 2), Trade("X", 100, 5)]
    fills, _ = bt.match_product([Order("X", 100, 4)], depth({99: 5}, {101: 3}), tape, 0, 50)
    assert [(f.price, f.qty, f.kind) for f in fills] == [(100, 2, "passive"), (100, 2, "passive")]


def test_resting_buy_does_not_fill_on_a_trade_above_it():
    fills, _ = bt.match_product([Order("X", 100, 4)], depth({99: 5}, {101: 3}), [Trade("X", 101, 5)], 0, 50)
    assert fills == []


def test_resting_sell_fills_on_a_trade_at_or_above_it():
    fills, _ = bt.match_product([Order("X", 101, -4)], depth({99: 5}, {102: 3}), [Trade("X", 101, 1), Trade("X", 99, 5)], 0, 50)
    assert [(f.price, f.qty, f.kind) for f in fills] == [(101, -1, "passive")]


def test_a_trade_on_the_tape_is_shared_between_orders():
    tape = [Trade("X", 99, 3)]
    fills, _ = bt.match_product([Order("X", 100, 2), Order("X", 100, 2)], depth({98: 5}, {101: 3}), tape, 0, 50)
    assert sum(f.qty for f in fills) == 3


def test_orders_that_could_breach_the_limit_are_all_cancelled():
    orders = [Order("X", 101, 30), Order("X", 99, -5)]
    fills, rejected = bt.match_product(orders, depth({99: 50}, {101: 50}), [], 25, 50)
    assert rejected and fills == []


def test_buys_and_sells_are_checked_against_the_limit_separately():
    orders = [Order("X", 101, 25), Order("X", 99, -75)]
    fills, rejected = bt.match_product(orders, depth({99: 80}, {101: 80}), [], 25, 50)
    assert not rejected and sum(f.qty for f in fills) == 25 - 75


def test_position_limits_follow_the_wiki():
    assert bt.limit_for("LYCHEE") == 200
    assert bt.limit_for("VOUCHER_7400") == 50
    assert bt.limit_for("TELLURIUM") == 40
    assert bt.limit_for("PINK_PEARLS") == 20


# ------------------------------------------------------------------ push calibration (Obizhaeva-Wang book density)
def test_fit_slope_recovers_a_linear_slope():
    points = [(q, 1.5 + 0.08 * q) for q in range(1, 40)]
    assert math.isclose(bt.fit_slope(points), 0.08, rel_tol=1e-9)


def test_fit_slope_is_never_negative():
    assert bt.fit_slope([(1, 5.0), (2, 4.0), (3, 3.0)]) == 0.0


def test_walk_points_measure_distance_from_mid_for_each_size():
    # mid 100; asks 101 x2, 103 x1 -> sizes 1,2 at distance 1 and size 3 at distance 3 (bids likewise)
    pts = bt.walk_points(depth({99: 2, 97: 1}, {101: 2, 103: 1}))
    assert sorted(pts) == [(1, 1.0), (1, 1.0), (2, 1.0), (2, 1.0), (3, 3.0), (3, 3.0)]


def test_calibrate_lambda_reads_its_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(bt, "RUNS", str(tmp_path))
    monkeypatch.setattr(bt, "DATA", str(tmp_path))
    days = (-2, -1, 0)
    for d in days:
        (tmp_path / f"prices_day_{d}.csv").write_text("day;timestamp;product\n")
    (tmp_path / "push_lambda.json").write_text(json.dumps({"stamp": bt._data_stamp(days), "lambda": {"X": 0.25}}))
    assert bt.calibrate_lambda(days) == {"X": 0.25}


# ------------------------------------------------------------------ stress scenarios
def test_stress_labels_and_parsing():
    assert bt.Stress(100, 0.5, 0).label() == "h100_s50_d0"
    assert bt.Stress(math.inf, 1.0, 1).label() == "hinf_s100_d1"
    assert bt.Stress.parse("h=100,share=0.5,delay=1") == bt.Stress(100, 0.5, 1)
    assert bt.Stress.parse("h=inf,share=0.25,delay=0") == bt.Stress(math.inf, 0.25, 0)


def test_stressed_book_moves_each_side_away_and_floors_volumes():
    d = bt.stressed_book(depth({99: 5, 98: 1}, {101: 3, 102: 10}), ask_shift=2, bid_shift=1, share=0.5)
    assert d.sell_orders == {103: -1, 104: -5}           # our buys ate the asks: they sit 2 higher
    assert d.buy_orders == {98: 2}                       # our sells ate the bids: 1 lower; 98 x1 floors to 0 and is dropped


def test_scaled_tape_keeps_a_fractional_carry_and_the_recorded_prices():
    carry = {}
    got = [bt.scale_tape([Trade("X", 99, 1)], 0.5, carry) for _ in range(4)]
    assert [[(t.price, t.quantity) for t in g] for g in got] == [[], [(99, 1)], [], [(99, 1)]]


# ------------------------------------------------------------------ greeks
def test_call_delta_matches_a_finite_difference():
    s, k, t, v = 7450.0, 7400, 6.0, 0.02
    g = bt.call_greeks(s, k, t, v)
    fd = (bt.bs_call(s + 0.5, k, t, v) - bt.bs_call(s - 0.5, k, t, v)) / 1.0
    assert math.isclose(g.delta, fd, rel_tol=1e-4)
    gd = (bt.call_greeks(s + 0.5, k, t, v).delta - bt.call_greeks(s - 0.5, k, t, v).delta) / 1.0
    assert math.isclose(g.gamma, gd, rel_tol=1e-3)


def test_vega_is_per_one_percent_relative_move_in_vol_and_theta_per_day():
    s, k, t, v = 7450.0, 7400, 6.0, 0.02
    g = bt.call_greeks(s, k, t, v)
    up = bt.bs_call(s, k, t, v * 1.01) - bt.bs_call(s, k, t, v)
    assert math.isclose(g.vega, up, rel_tol=1e-2)
    decay = bt.bs_call(s, k, t - 0.01, v) - bt.bs_call(s, k, t, v)
    assert math.isclose(g.theta, decay / 0.01, rel_tol=1e-2)


def test_implied_vol_inverts_the_price():
    p = bt.bs_call(7450.0, 7500, 7.0, 0.021)
    assert math.isclose(bt.implied_vol(p, 7450.0, 7500, 7.0), 0.021, rel_tol=1e-6)


# ------------------------------------------------------------------ replay
class BuyOnceThenHold:
    def run(self, state):
        orders = {}
        if state.timestamp == 0:
            orders["X"] = [Order("X", 101, 5)]
        return orders, 0, "seen"


def test_replay_marks_positions_at_mid():
    books = {0: {"X": depth({99: 10}, {101: 10})}, 100: {"X": depth({103: 10}, {105: 10})}}
    res = bt.replay(BuyOnceThenHold(), books, {}, day=0)
    assert [(f.timestamp, f.qty, f.price) for f in res.fills] == [(0, 5, 101)]
    # bought 5 @ 101; mid moves 100 -> 104
    assert res.equity == [(0, -5.0), (100, 15.0)]


class EchoState:
    def __init__(self):
        self.seen = []

    def run(self, state):
        self.seen.append((state.traderData, dict(state.position), {k: [(t.price, t.quantity) for t in v] for k, v in state.own_trades.items()},
                          {k: [(t.price, t.quantity) for t in v] for k, v in state.market_trades.items()}))
        return ({"X": [Order("X", 101, 1)]} if state.timestamp == 0 else {}), 0, f"t{state.timestamp}"


def test_replay_passes_trader_data_positions_and_last_ticks_trades():
    books = {0: {"X": depth({99: 10}, {101: 10})}, 100: {"X": depth({99: 10}, {101: 10})}}
    tape = {0: [Trade("X", 99, 2, timestamp=0)]}
    tr = EchoState()
    bt.replay(tr, books, tape, day=0)
    assert tr.seen[0] == ("", {}, {}, {})
    assert tr.seen[1] == ("t0", {"X": 1}, {"X": [(101, 1)]}, {"X": [(99, 2)]})


# ------------------------------------------------------------------ strategy indicators for the chart
def test_numbers_are_flattened_from_trader_data():
    data = {"tel": {"ema": 1.5, "target": -40}, "day": 0, "last_ts": 500, "xs": [1, 2, 3], "name": "a", "on": True, "empty": []}
    assert bt.flatten_numbers(data) == {"tel.ema": 1.5, "tel.target": -40, "xs": 3}


class Plotting:
    def __init__(self):
        self.plots = {}

    def run(self, state):
        self.plots = {"fair": 100.0 + state.timestamp / 100}
        orders = {"X": [Order("X", 98, 1), Order("X", 99, 1), Order("X", 103, -1)]} if state.timestamp < 200 else {}
        return orders, 0, json_dumps({"sig": 1 if state.timestamp >= 100 else 0, "last_ts": state.timestamp})


def json_dumps(x):
    import json
    return json.dumps(x)


def test_replay_records_indicator_changes_and_quotes():
    books = {ts: {"X": depth({97: 10}, {104: 10})} for ts in (0, 100, 200)}
    res = bt.replay(Plotting(), books, {}, day=0)
    got = [(ts, k, v) for ts, k, v in res.indicators]
    assert (0, "sig", 0) in got and (100, "sig", 1) in got
    assert [x for x in got if x[1] == "sig"] == [(0, "sig", 0), (100, "sig", 1)]          # changes only
    assert [x[2] for x in got if x[1] == "fair"] == [100.0, 101.0, 102.0]                   # trader.plots
    assert [x for x in got if x[1] == "quote.bid.X"] == [(0, "quote.bid.X", 99), (200, "quote.bid.X", None)]
    assert [x for x in got if x[1] == "quote.ask.X"] == [(0, "quote.ask.X", 103), (200, "quote.ask.X", None)]
    assert not any(k == "last_ts" for _, k, _ in got)


# ------------------------------------------------------------------ stressed replay (push, share, delay)
class Taker:
    """Buys `plan[ts]` units at a price that crosses anything, and records the best ask it was shown."""
    def __init__(self, plan, limit=200):
        self.plan, self.limit, self.seen = plan, limit, []

    def run(self, state):
        d = state.order_depths["X"]
        self.seen.append(min(d.sell_orders) if d.sell_orders else None)
        q = self.plan.get(state.timestamp, 0)
        return ({"X": [Order("X", 10_000, q)]} if q else {}), 0, ""


def flat_books(n, bid=99, ask=101, vol=10):
    return {i * 100: {"X": depth({bid: vol}, {ask: vol})} for i in range(n)}


def test_unstressed_scenario_matches_the_website():
    books = flat_books(4)
    tape = {100: [Trade("X", 99, 2, timestamp=100)]}
    plan = {0: 5, 200: 3}
    web = bt.replay(Taker(plan), books, tape, day=0)
    st = bt.replay(Taker(plan), books, tape, day=0, stress=bt.Stress(0, 1.0, 0), lam={"X": 1.0})
    assert [(f.timestamp, f.qty, f.price) for f in st.fills] == [(f.timestamp, f.qty, f.price) for f in web.fills]
    assert st.equity == web.equity


def test_a_taken_buy_pushes_the_book_the_trader_sees_and_the_push_decays():
    tr = Taker({0: 8})
    bt.replay(tr, flat_books(4), {}, day=0, stress=bt.Stress(1, 1.0, 0), lam={"X": 1.0})
    assert tr.seen == [101, 105, 103, 102]               # push 8 halves every tick: 4, 2, 1
    tr = Taker({0: 8})
    bt.replay(tr, flat_books(3), {}, day=0, stress=bt.Stress(math.inf, 1.0, 0), lam={"X": 1.0})
    assert tr.seen == [101, 109, 109]


def test_a_smaller_liquidity_share_thins_the_book_and_strengthens_the_push():
    tr = Taker({0: 4})
    res = bt.replay(tr, flat_books(2), {}, day=0, stress=bt.Stress(math.inf, 0.5, 0), lam={"X": 1.0})
    assert sum(f.qty for f in res.fills) == 4            # 5 of the 10 displayed lots are ours to take
    assert tr.seen == [101, 109]                         # push 4 x lambda / share = 8


def test_taken_fills_pay_the_fractional_push_and_positions_mark_at_the_recorded_mid():
    tr = Taker({0: 5, 100: 1})
    res = bt.replay(tr, flat_books(2), {}, day=0, stress=bt.Stress(math.inf, 1.0, 0), lam={"X": 0.3})
    # push 1.5 after the first buy: shown as +2 (103), settled at 102.5
    assert tr.seen == [101, 103]
    assert [(f.qty, f.price) for f in res.fills] == [(5, 101), (1, 102.5)]
    assert math.isclose(res.fills[1].push, 1.5)
    assert res.equity[-1] == (100, -505.0 - 102.5 + 6 * 100.0)          # marked at the recorded mid 100


class RestingBuyer:
    def __init__(self):
        self.seen = []

    def run(self, state):
        self.seen.append(min(state.order_depths["X"].sell_orders))
        return ({"X": [Order("X", 100, 3)]} if state.timestamp == 0 else {}), 0, ""


def test_resting_fills_do_not_push():
    tr = RestingBuyer()
    res = bt.replay(tr, flat_books(2), {0: [Trade("X", 99, 3, timestamp=0)]}, day=0,
                    stress=bt.Stress(math.inf, 1.0, 0), lam={"X": 1.0})
    assert [(f.kind, f.qty, f.price) for f in res.fills] == [("passive", 3, 100)]
    assert all(f.push == 0 for f in res.fills)
    assert tr.seen == [101, 101]


def test_a_one_tick_delay_fills_orders_against_the_next_ticks_book():
    books = {0: {"X": depth({99: 10}, {101: 10})}, 100: {"X": depth({100: 10}, {102: 10})}}
    late = bt.replay(Taker({0: 3}), books, {}, day=0, stress=bt.Stress(0, 1.0, 1), lam={"X": 1.0})
    assert [(f.timestamp, f.qty, f.price) for f in late.fills] == [(100, 3, 102)]
    now = bt.replay(Taker({0: 3}), books, {}, day=0)
    assert [(f.timestamp, f.qty, f.price) for f in now.fills] == [(0, 3, 101)]


class PumpThenSell:
    """Buys 5 by crossing, then rests a sell at the (pushed) best ask it is shown."""
    def run(self, state):
        d = state.order_depths["X"]
        if state.timestamp == 0:
            return {"X": [Order("X", 10_000, 5)]}, 0, ""
        return {"X": [Order("X", min(d.sell_orders), -5)]}, 0, ""


def test_a_strategy_cannot_sell_its_own_push_to_market_trades():
    books = flat_books(2)
    tape = {100: [Trade("X", 101, 5, timestamp=100)]}           # a market buy printed at the recorded ask
    res = bt.replay(PumpThenSell(), books, tape, day=0, stress=bt.Stress(math.inf, 1.0, 0), lam={"X": 1.0})
    assert [(f.timestamp, f.qty) for f in res.fills] == [(0, 5)]  # the sell at the pushed 106 never meets the 101 print
    web = bt.replay(PumpThenSell(), books, tape, day=0)
    assert [(f.timestamp, f.qty, f.price) for f in web.fills] == [(0, 5, 101), (100, -5, 101)]


class BuyThenSellBack:
    def run(self, state):
        q = {0: 5, 100: -5}.get(state.timestamp, 0)
        return ({"X": [Order("X", 10_000 if q > 0 else 0, q)]} if q else {}), 0, ""


def test_a_round_trip_through_the_book_cannot_profit_from_its_own_push():
    books = flat_books(2)
    web = bt.replay(BuyThenSellBack(), books, {}, day=0)
    st = bt.replay(BuyThenSellBack(), books, {}, day=0, stress=bt.Stress(math.inf, 1.0, 0), lam={"X": 1.0})
    assert [(f.qty, f.price) for f in st.fills] == [(5, 101), (-5, 99)]  # buying ate the asks; the bids it sells to are untouched
    assert st.equity[-1][1] <= web.equity[-1][1]


def test_push_cost_is_never_negative():
    books = flat_books(4)
    tape = {t: [Trade("X", 101, 5, timestamp=t), Trade("X", 99, 5, timestamp=t)] for t in (100, 200, 300)}
    for tr in (BuyThenSellBack(), PumpThenSell(), Taker({0: 8, 100: -3, 200: 6})):
        for st in (bt.Stress(1, 1.0, 0), bt.Stress(math.inf, 0.5, 1)):
            res = bt.replay(tr, books, tape, day=0, stress=st, lam={"X": 1.0})
            assert all(f.push >= 0 for f in res.fills)
