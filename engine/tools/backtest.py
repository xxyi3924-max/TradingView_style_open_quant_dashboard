"""Replay a Trader file over the training days with the website's fill rules, or under a slippage stress scenario.

Fill rules (QuantiFi wiki):
  * A product's orders are all cancelled for the tick if its buys alone or its sells alone could take the position
    past the limit.
  * An order that crosses the book fills against the displayed levels at their prices, best first.
  * What is left rests for the tick only: a buy fills at its own price on a market trade (trades_day_*.csv, same
    timestamp) printed at or below it, a sell on one at or above it; each printed lot fills one order.
Stress scenarios (--stress h=100,share=0.5,delay=0) add slippage beyond walking the displayed book, with linear
transient impact and order-book resilience (Obizhaeva & Wang 2013; a propagator in the sense of Bouchaud, Gefen,
Potters & Wyart 2004; exponential decay is only arbitrage-free with linear impact, Gatheral 2010):
  * The push is the liquidity our takes ate: each unit bought moves that product's asks up by lambda / share coins,
    each unit sold moves its bids down, and the gap refills with a half-life of h ticks (h=0: refilled by the next
    tick, as on the website; h=inf: not within the day). The other side of the book is untouched, so the strategy can
    never sell into the push its own buying made: buying then selling back costs more than on the website, never less.
    Resting fills do not push: they are other traders' market orders, whose impact is already in the recorded
    prices, and those trades keep their recorded prices (a resting order cannot sell our push to them either).
  * Only `share` of each displayed volume (floored) and of each market trade (with a fractional carry) is ours.
  * delay=1 matches the orders sent at a tick against the next tick's book and trades (Moallemi & Saglam 2013).
  * The trader is shown the stressed book (each side moved by its push rounded to whole coins) and reacts to it; taken
    fills settle at the shown price plus the fractional rest of the push. lambda per product is the OLS slope of
    distance from mid on units filled over the displayed books (the book density in Obizhaeva-Wang).
  * Positions are still marked at the recorded mid, so a strategy gets no credit for its own push.
Positions are marked at mid. Each day starts flat with a fresh Trader, as the website runs one day at a time.

Indicators for the chart: every number in traderData (JSON; a list counts as its last element) and in an optional
`self.plots` dict on the Trader (charted, never sent to the website), plus the strategy's own quotes (highest buy and
lowest sell price it sent per product), recorded whenever they change.

Usage: python3 tools/backtest.py submission/example_trader.py [--out runs/example_trader/<stamp>] [--days -2 -1 0] [--stress h=100,share=0.5,delay=0]
Writes meta.json, fills.csv, equity.csv (every tick), greeks.csv (every 10 ticks) and indicators.csv (changes) to --out.
"""
import argparse
import csv
import importlib.util
import json
import math
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from multiprocessing import Pool
from typing import Dict, List, Optional, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "Data")
RUNS = os.path.join(ROOT, "runs")
for _p in (ROOT, os.path.join(ROOT, "submission")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from datamodel import Observation, Order, OrderDepth, Trade, TradingState  # noqa: E402

LIMITS = {
    "AMETHYST": 50, "TOFFEE_CAKE": 50, "PAPER_LANTERNS": 50, "JELLY": 50, "PEANUT_BUTTER": 50,
    "TELLURIUM": 40, "DRAGONFRUIT": 40, "GRANADILLA": 40, "MANGOSTEEN": 40, "FRUIT_BASKET": 40,
    "LYCHEE": 200, "WHITE_PEARLS": 20, "BLACK_PEARLS": 20, "GOLDEN_PEARLS": 20, "PINK_PEARLS": 20, "BLUE_PEARLS": 20,
}
VOUCHER_LIMIT = 50
UNDERLYING = "LYCHEE"
TTE = {-2: 8.0, -1: 7.0, 0: 6.0}      # days to expiry at the start of each training day (wiki: 8 on day -2)
GREEK_EVERY = 10                       # greeks sampled every 10 ticks
LAMBDA_SAMPLE = 10                     # push calibration reads every 10th book
STRESS_STOPS = {"half_life": [0, 1, 10, 100, 1000, math.inf], "share": [1.0, 0.75, 0.5, 0.25, 0.1], "delay": [0, 1]}
SKIP_NUMBERS = {"day", "last_ts", "ts", "timestamp", "time"}   # bookkeeping, not indicators
MAX_INDICATORS = 80
STRATEGY_CONSTANTS = ("VEGA_CAP_PER_PCT", "DELTA_BAND", "OPT_DELTA_CAP", "VOUCHER_LIMIT", "LYCHEE_LIMIT", "TREND_LIMIT")


def limit_for(product: str) -> int:
    return VOUCHER_LIMIT if product.startswith("VOUCHER_") else LIMITS.get(product, 50)


# ------------------------------------------------------------------ fills
@dataclass
class Fill:
    price: float        # settlement price (whole coins on the website; a stressed take adds the fractional push)
    qty: int            # signed: + bought, - sold
    kind: str           # "take" (crossed the book) or "passive" (rested and matched a market trade)
    timestamp: int = 0
    product: str = ""
    day: int = 0
    push: float = 0.0   # units taken x the push on the side they took from: coins paid over the recorded book (stress)


def match_product(orders: List[Order], depth: OrderDepth, tape: List[Trade], position: int,
                  limit: int) -> Tuple[List[Fill], bool]:
    """One product's orders for one tick. Returns (fills, rejected)."""
    buys = sum(o.quantity for o in orders if o.quantity > 0)
    sells = -sum(o.quantity for o in orders if o.quantity < 0)
    if position + buys > limit or position - sells < -limit:
        return [], True
    asks = {p: -v for p, v in depth.sell_orders.items()}
    bids = dict(depth.buy_orders)
    left = [[t.price, t.quantity] for t in tape]
    fills: List[Fill] = []
    for o in orders:
        q = abs(o.quantity)
        sign = 1 if o.quantity > 0 else -1
        if q == 0:
            continue
        book = asks if sign > 0 else bids
        for px in sorted(book, reverse=sign < 0):
            if q == 0 or (sign > 0 and px > o.price) or (sign < 0 and px < o.price):
                break
            f = min(q, book[px])
            if f > 0:
                book[px] -= f
                q -= f
                fills.append(Fill(px, sign * f, "take"))
        for tr in left:
            if q == 0:
                break
            if tr[1] > 0 and ((sign > 0 and tr[0] <= o.price) or (sign < 0 and tr[0] >= o.price)):
                f = min(q, tr[1])
                tr[1] -= f
                q -= f
                fills.append(Fill(o.price, sign * f, "passive"))
    return fills, False


# ------------------------------------------------------------------ stress scenarios (Obizhaeva-Wang)
@dataclass(frozen=True)
class Stress:
    half_life: float = 0.0     # ticks; math.inf = the push never decays within the day
    share: float = 1.0         # fraction of displayed volume and of market trades available to us
    delay: int = 0             # ticks between sending an order and it reaching the book

    def label(self) -> str:
        h = "inf" if math.isinf(self.half_life) else f"{self.half_life:g}"
        return f"h{h}_s{round(self.share * 100)}_d{self.delay}"

    def decay(self) -> float:
        if self.half_life <= 0:
            return 0.0
        return 1.0 if math.isinf(self.half_life) else 0.5 ** (1.0 / self.half_life)

    @staticmethod
    def parse(text: str) -> "Stress":
        kv = dict(part.split("=", 1) for part in text.replace(" ", "").split(",") if part)
        h = kv.get("h", kv.get("half_life", "0"))
        return Stress(math.inf if h in ("inf", "∞") else float(h), float(kv.get("share", 1.0)), int(kv.get("delay", 0)))


def _whole(x: float) -> int:
    """Nearest whole coin, halves away from zero."""
    return int(math.copysign(math.floor(abs(x) + 0.5), x))


def walk_points(depth: OrderDepth) -> List[Tuple[int, float]]:
    """(Q, distance from mid of the worst level needed to fill Q units) for every Q the displayed book can fill."""
    if not depth.buy_orders or not depth.sell_orders:
        return []
    mid = 0.5 * (max(depth.buy_orders) + min(depth.sell_orders))
    pts: List[Tuple[int, float]] = []
    for levels in (sorted((p, -v) for p, v in depth.sell_orders.items()),
                   sorted(depth.buy_orders.items(), reverse=True)):
        cum = 0
        for px, vol in levels:
            for q in range(cum + 1, cum + vol + 1):
                pts.append((q, abs(px - mid)))
            cum += vol
    return pts


def fit_slope(points: List[Tuple[int, float]]) -> float:
    """OLS slope of distance-from-mid on Q (with intercept), floored at 0: coins per unit taken."""
    n = len(points)
    if n < 2:
        return 0.0
    xs = [float(q) for q, _ in points]
    ys = [d for _, d in points]
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return 0.0
    k = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    return max(0.0, k)


def stressed_book(depth: OrderDepth, ask_shift: int, bid_shift: int, share: float) -> OrderDepth:
    """The displayed book with its asks `ask_shift` coins higher, its bids `bid_shift` lower, and `share` of every level
    (floored; empty levels dropped)."""
    if ask_shift == 0 and bid_shift == 0 and share >= 1.0:
        return depth
    out = OrderDepth()
    for p, v in depth.buy_orders.items():
        if math.floor(v * share + 1e-9) > 0:
            out.buy_orders[p - bid_shift] = math.floor(v * share + 1e-9)
    for p, v in depth.sell_orders.items():
        if math.floor(-v * share + 1e-9) > 0:
            out.sell_orders[p + ask_shift] = -math.floor(-v * share + 1e-9)
    return out


def scale_tape(trades: List[Trade], share: float, carry: Dict[str, float]) -> List[Trade]:
    """Market trades at their recorded prices; with share < 1 only that fraction of their quantity is ours,
    accumulated in `carry` so small trades are not all rounded away."""
    if share >= 1.0:
        return list(trades)
    out = []
    for t in trades:
        q = t.quantity
        if share < 1.0:
            carry[t.symbol] = carry.get(t.symbol, 0.0) + share * t.quantity
            q = math.floor(carry[t.symbol] + 1e-9)
            carry[t.symbol] -= q
        if q > 0:
            out.append(Trade(t.symbol, t.price, q, t.buyer, t.seller, t.timestamp))
    return out


# ------------------------------------------------------------------ Black-Scholes (T in days, vol per sqrt(day))
def _ncdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _npdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def bs_call(s: float, k: float, t: float, vol: float) -> float:
    if t <= 0 or vol <= 0:
        return max(0.0, s - k)
    sd = vol * math.sqrt(t)
    d1 = (math.log(s / k) + 0.5 * sd * sd) / sd
    return s * _ncdf(d1) - k * _ncdf(d1 - sd)


def implied_vol(price: float, s: float, k: float, t: float) -> Optional[float]:
    if t <= 0 or price <= max(0.0, s - k) + 1e-9 or price >= s:
        return None
    lo, hi = 1e-5, 1.0
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        if bs_call(s, k, t, mid) > price:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


@dataclass
class Greeks:
    delta: float
    gamma: float        # delta change per 1 coin of spot
    vega: float         # coins per 1% relative move in implied vol
    theta: float        # coins per day


def call_greeks(s: float, k: float, t: float, vol: float) -> Greeks:
    sd = vol * math.sqrt(t)
    d1 = (math.log(s / k) + 0.5 * sd * sd) / sd
    pdf = _npdf(d1)
    return Greeks(_ncdf(d1), pdf / (s * sd), s * pdf * math.sqrt(t) * vol * 0.01, -s * pdf * vol / (2.0 * math.sqrt(t)))


def book_greeks(positions: Dict[str, int], mids: Dict[str, float], tte: float) -> Optional[dict]:
    """Net Black-Scholes exposure of the voucher book (each strike at its own implied vol) plus the LYCHEE hedge."""
    s = mids.get(UNDERLYING)
    if s is None or tte <= 0:
        return None
    held = {p: q for p, q in positions.items() if q and p.startswith("VOUCHER_")}
    ivs: Dict[str, Optional[float]] = {p: implied_vol(mids[p], s, int(p.split("_")[1]), tte) for p in held if p in mids}
    known = sorted(v for v in ivs.values() if v)
    fallback = known[len(known) // 2] if known else None
    out = {"spot": s, "opt_delta": 0.0, "lychee": float(positions.get(UNDERLYING, 0)), "gamma": 0.0, "vega": 0.0, "theta": 0.0}
    for p, q in held.items():
        strike = int(p.split("_")[1])
        vol = ivs.get(p) or fallback
        if vol is None:                       # priced at intrinsic: all delta, no optionality
            out["opt_delta"] += q * (1.0 if s > strike else 0.0)
            continue
        g = call_greeks(s, strike, tte, vol)
        out["opt_delta"] += q * g.delta
        out["gamma"] += q * g.gamma
        out["vega"] += q * g.vega
        out["theta"] += q * g.theta
    out["net_delta"] = out["opt_delta"] + out["lychee"]
    return out


# ------------------------------------------------------------------ indicators
def flatten_numbers(obj, prefix: str = "") -> Dict[str, float]:
    """Numeric leaves of nested dicts as dotted keys; a list of numbers counts as its last element."""
    out: Dict[str, float] = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            if str(k) in SKIP_NUMBERS:
                continue
            out.update(flatten_numbers(v, f"{prefix}{k}."))
    elif isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[-1], (int, float)) and not isinstance(obj[-1], bool):
            out[prefix[:-1]] = obj[-1]
    elif isinstance(obj, (int, float)) and not isinstance(obj, bool) and prefix:
        if math.isfinite(obj):
            out[prefix[:-1]] = obj
    return out


def quotes(orders: Dict[str, List[Order]]) -> Dict[str, float]:
    """The strategy's own quotes this tick: highest buy and lowest sell price per product."""
    out: Dict[str, float] = {}
    for product, olist in (orders or {}).items():
        buys = [o.price for o in olist or [] if o.quantity > 0]
        sells = [o.price for o in olist or [] if o.quantity < 0]
        if buys:
            out[f"quote.bid.{product}"] = max(buys)
        if sells:
            out[f"quote.ask.{product}"] = min(sells)
    return out


# ------------------------------------------------------------------ replay
@dataclass
class DayResult:
    day: int
    fills: List[Fill] = field(default_factory=list)
    equity: List[Tuple[int, float]] = field(default_factory=list)   # (timestamp, pnl marked at the recorded mid)
    greeks: List[dict] = field(default_factory=list)
    indicators: List[Tuple[int, str, Optional[float]]] = field(default_factory=list)   # (timestamp, key, value or None) on change
    errors: int = 0
    first_error: str = ""
    rejected: int = 0
    seconds: float = 0.0


def _mid(d: OrderDepth) -> Optional[float]:
    if d.buy_orders and d.sell_orders:
        return 0.5 * (max(d.buy_orders) + min(d.sell_orders))
    return None


def replay(trader, books: Dict[int, Dict[str, OrderDepth]], tape: Dict[int, List[Trade]], day: int,
           tte0: Optional[float] = None, stress: Optional[Stress] = None, lam: Optional[Dict[str, float]] = None) -> DayResult:
    """One day under the website's rules, or under a stress scenario (see the module docstring)."""
    st = stress or Stress()
    lam = lam or {}
    decay = st.decay()
    res = DayResult(day)
    pos: Dict[str, int] = {}
    cash = 0.0
    data = ""
    mids: Dict[str, float] = {}
    push: Dict[Tuple[str, int], float] = {}   # (product, +1 asks / -1 bids) -> coins our takes moved that side, not yet refilled
    carry: Dict[str, float] = {}         # our fractional share of market trades, per product
    pending: Dict[str, List[Order]] = {}  # orders still on their way to the book (delay)
    own_prev: Dict[str, List[Trade]] = {}
    mkt_prev: Dict[str, List[Trade]] = {}
    shown: Dict[str, Optional[float]] = {}
    parsed_src, parsed = None, {}
    t0 = time.perf_counter()
    for i, ts in enumerate(sorted(books)):
        raw = books[ts]
        shift = {k: _whole(v) for k, v in push.items()}
        book = {p: stressed_book(d, shift.get((p, 1), 0), shift.get((p, -1), 0), st.share) for p, d in raw.items()}
        state = TradingState(data, ts, {}, book, own_prev, mkt_prev, dict(pos), Observation({}, {}))
        try:
            out = trader.run(state)
            orders, data = out[0] or {}, out[2] if len(out) > 2 else data
        except Exception as e:  # the website would log it and move on with no orders
            res.errors += 1
            res.first_error = res.first_error or f"t={ts}: {type(e).__name__}: {e}"
            orders = {}
        if data != parsed_src:
            parsed_src = data
            try:
                parsed = flatten_numbers(json.loads(data)) if data else {}
            except (ValueError, TypeError):
                parsed = {}
        now = dict(parsed)
        plots = getattr(trader, "plots", None)
        if isinstance(plots, dict):
            now.update(flatten_numbers(plots))
        now.update(quotes(orders))
        for key in list(shown) + [k for k in now if k not in shown]:
            v = now.get(key)
            if key not in shown and len(shown) >= MAX_INDICATORS:
                continue
            if shown.get(key, "unset") != v:
                if key in shown or v is not None:
                    res.indicators.append((ts, key, v))
                shown[key] = v
        if st.delay:
            orders, pending = pending, orders
        here = scale_tape(tape.get(ts, []), st.share, carry)
        own_now: Dict[str, List[Trade]] = {}
        taken: Dict[str, int] = {}
        for product, olist in orders.items():
            if not olist or product not in book:
                continue
            fills, rejected = match_product(olist, book[product], [t for t in here if t.symbol == product],
                                            pos.get(product, 0), limit_for(product))
            res.rejected += rejected
            if not fills:
                continue
            for f in fills:
                f.timestamp, f.product, f.day = ts, product, day
                shown_px = f.price
                if f.kind == "take":
                    side = 1 if f.qty > 0 else -1
                    taken[(product, side)] = taken.get((product, side), 0) + abs(f.qty)
                    gap = push.get((product, side), 0.0)
                    if gap:
                        f.price = shown_px + side * (gap - shift.get((product, side), 0))
                        f.push = abs(f.qty) * gap
                pos[product] = pos.get(product, 0) + f.qty
                cash -= f.qty * f.price
                own_now.setdefault(product, []).append(
                    Trade(product, shown_px, abs(f.qty), "SUBMISSION" if f.qty > 0 else "", "SUBMISSION" if f.qty < 0 else "", ts))
            res.fills.extend(fills)
        if decay or push:
            for key in set(push) | set(taken):
                v = (push.get(key, 0.0) + lam.get(key[0], 0.0) / st.share * taken.get(key, 0)) * decay
                if v > 1e-9:
                    push[key] = v
                else:
                    push.pop(key, None)
        for p, d in raw.items():
            m = _mid(d)
            if m is not None:
                mids[p] = m
        res.equity.append((ts, cash + sum(q * mids.get(p, 0.0) for p, q in pos.items())))
        if tte0 is not None and i % GREEK_EVERY == 0:
            g = book_greeks(pos, mids, tte0 - ts / 1_000_000)
            if g is not None:
                res.greeks.append({"timestamp": ts, **g})
        own_prev = own_now
        mkt_prev = {}
        for t in here:
            mkt_prev.setdefault(t.symbol, []).append(t)
    res.seconds = time.perf_counter() - t0
    return res


# ------------------------------------------------------------------ data
def load_trades(day: int) -> Dict[int, List[Trade]]:
    out: Dict[int, List[Trade]] = {}
    with open(os.path.join(DATA, f"trades_day_{day}.csv"), newline="") as f:
        for r in csv.DictReader(f, delimiter=";"):
            ts = int(r["timestamp"])
            out.setdefault(ts, []).append(Trade(r["symbol"], int(float(r["price"])), int(r["quantity"]),
                                                r["buyer"] or None, r["seller"] or None, ts))
    return out


def _data_stamp(days) -> str:
    parts = []
    for d in days:
        st = os.stat(os.path.join(DATA, f"prices_day_{d}.csv"))
        parts.append(f"{d}:{st.st_size}:{int(st.st_mtime)}")
    return "|".join(parts)


def calibrate_lambda(days=(-2, -1, 0)) -> Dict[str, float]:
    """Push per unit taken (coins) per product: OLS slope of distance from mid on units filled, over every
    LAMBDA_SAMPLE-th displayed book of the given days (cached in runs/push_lambda.json)."""
    from tools.marketdata import load_books
    cache = os.path.join(RUNS, "push_lambda.json")
    stamp = _data_stamp(days)
    try:
        with open(cache) as f:
            c = json.load(f)
        if c.get("stamp") == stamp:
            return c["lambda"]
    except (OSError, ValueError):
        pass
    pts: Dict[str, List[Tuple[int, float]]] = {}
    for d in days:
        books = load_books(d)
        for ts in sorted(books)[::LAMBDA_SAMPLE]:
            for p, depth in books[ts].items():
                pts.setdefault(p, []).extend(walk_points(depth))
    lam = {p: round(fit_slope(v), 6) for p, v in sorted(pts.items())}
    os.makedirs(RUNS, exist_ok=True)
    with open(cache, "w") as f:
        json.dump({"stamp": stamp, "lambda": lam, "method": "OLS of distance-from-mid on units filled over displayed books"}, f, indent=1)
    return lam


def load_strategy(path: str, name: str = "strategy"):
    folder = os.path.dirname(os.path.abspath(path))
    if folder not in sys.path:
        sys.path.insert(1, folder)
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _replay_day(args) -> DayResult:
    path, day, stress, lam = args
    from tools.marketdata import load_books
    mod = load_strategy(path, f"strategy_day{day + 10}")
    if hasattr(mod, "TTE_FIRST_DAY"):
        mod.TTE_FIRST_DAY = TTE[day]
    return replay(mod.Trader(), load_books(day), load_trades(day), day, TTE[day], stress, lam)


# ------------------------------------------------------------------ run + summary
def summarize(equity: List[Tuple[int, int, float]], fills: List[Fill]) -> dict:
    """equity rows: (day, timestamp, pnl), cumulative across days."""
    def dd(vals):
        peak, worst = float("-inf"), 0.0
        for v in vals:
            peak = max(peak, v)
            worst = max(worst, peak - v)
        return worst

    def sharpe(vals, block=100):
        steps = [vals[i] - vals[i - block] for i in range(block, len(vals), block)]
        if len(steps) < 2:
            return None
        m = sum(steps) / len(steps)
        sd = math.sqrt(sum((x - m) ** 2 for x in steps) / (len(steps) - 1))
        return m / sd * math.sqrt(10_000 / block) if sd else None

    vals = [r[2] for r in equity]
    taken = [f for f in fills if f.kind == "take"]
    return {"pnl": vals[-1] if vals else 0.0, "max_drawdown": dd(vals), "sharpe": sharpe(vals),
            "fills": len(fills), "volume": sum(abs(f.qty) for f in fills),
            "taken_volume": sum(abs(f.qty) for f in taken), "push_cost": sum(f.push for f in fills),
            "products": sorted({f.product for f in fills})}


def _stitch(results: List[DayResult]) -> List[Tuple[int, int, float]]:
    """Day results into one equity curve, each day's PnL added to the days before it."""
    equity, carry = [], 0.0
    for r in results:
        for ts, pnl in r.equity:
            equity.append((r.day, ts, carry + pnl))
        if r.equity:
            carry += r.equity[-1][1]
    return equity


RULES = ("website: cross the displayed book, rest vs same-tick market trades at own price, limit breach cancels the "
         "product's orders. Stress (Obizhaeva & Wang 2013): each taken unit moves the side of the book it took from by "
         "lambda/share, refilling with half-life h ticks; share of displayed volume and market trades is ours; delay ticks before orders "
         "reach the book; marked at the recorded mid.")


def run(path: str, out: str, days=(-2, -1, 0), label: str = "", stress: Optional[Stress] = None) -> dict:
    t0 = time.time()
    path = os.path.abspath(path)
    lam = calibrate_lambda(tuple(sorted(TTE)))
    with Pool(min(len(days), os.cpu_count() or 1)) as pool:
        results: List[DayResult] = pool.map(_replay_day, [(path, d, stress, lam) for d in days])
    mod = load_strategy(path, "strategy_meta")
    os.makedirs(out, exist_ok=True)
    fills: List[Fill] = [f for r in results for f in r.fills]
    equity = _stitch(results)
    with open(os.path.join(out, "greeks.csv"), "w", newline="") as fg:
        gw = csv.writer(fg)
        gw.writerow(["day", "timestamp", "spot", "opt_delta", "lychee", "net_delta", "gamma", "vega", "theta"])
        for r in results:
            for g in r.greeks:
                gw.writerow([r.day, g["timestamp"], g["spot"], *(round(g[c], 6) for c in
                                                                  ("opt_delta", "lychee", "net_delta", "gamma", "vega", "theta"))])
    with open(os.path.join(out, "fills.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["day", "timestamp", "product", "qty", "price", "kind", "push"])
        for x in fills:
            w.writerow([x.day, x.timestamp, x.product, x.qty, x.price if isinstance(x.price, int) else round(x.price, 6),
                        x.kind, round(x.push, 6)])
    with open(os.path.join(out, "indicators.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["day", "timestamp", "key", "value"])
        for r in results:
            for ts, key, v in r.indicators:
                w.writerow([r.day, ts, key, "" if v is None else round(v, 6)])
    with open(os.path.join(out, "equity.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["day", "timestamp", "pnl"])
        for row in equity:
            w.writerow([row[0], row[1], round(row[2], 4)])
    s = summarize(equity, fills)
    traded = sorted({f.product for f in fills})
    meta = {
        "strategy": os.path.splitext(os.path.basename(path))[0], "label": label or os.path.basename(path),
        "path": os.path.relpath(path, ROOT), "days": list(days), "tte": {str(d): TTE[d] for d in days},
        "created": time.strftime("%Y-%m-%d %H:%M:%S"), "seconds": round(time.time() - t0, 1),
        "stress": None if stress is None else {"half_life": None if math.isinf(stress.half_life) else stress.half_life,
                                               "share": stress.share, "delay": stress.delay, "label": stress.label()},
        "lambda": {p: lam.get(p) for p in traded}, "limits": {p: limit_for(p) for p in traded},
        "errors": sum(r.errors for r in results), "first_error": next((r.first_error for r in results if r.first_error), ""),
        "rejected": sum(r.rejected for r in results),
        "day_pnl": {str(r.day): (r.equity[-1][1] if r.equity else 0.0) for r in results},
        "has_greeks": any(f.product.startswith("VOUCHER_") for f in fills),
        "constants": {c: getattr(mod, c) for c in STRATEGY_CONSTANTS if isinstance(getattr(mod, c, None), (int, float))},
        "rules": RULES,
        "summary": s,
    }
    with open(os.path.join(out, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    return meta


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("strategy", help="path to a file defining class Trader")
    ap.add_argument("--out", help="output folder (default runs/<strategy>/<timestamp>)")
    ap.add_argument("--days", type=int, nargs="+", default=[-2, -1, 0], choices=(-2, -1, 0))
    ap.add_argument("--label", default="")
    ap.add_argument("--stress", type=Stress.parse, help="scenario, e.g. h=100,share=0.5,delay=0 (h=inf: no decay)")
    a = ap.parse_args()
    name = os.path.splitext(os.path.basename(a.strategy))[0]
    out = a.out or os.path.join(RUNS, name, time.strftime("%Y%m%d-%H%M%S"))
    meta = run(a.strategy, out, tuple(a.days), a.label, a.stress)
    s = meta["summary"]
    scenario = f" [stress {a.stress.label()}, push cost {s['push_cost']:,.0f}]" if a.stress else ""
    print(f"{meta['label']}{scenario}: PnL {s['pnl']:,.0f}, max DD {s['max_drawdown']:,.0f}, "
          f"Sharpe {s['sharpe'] if s['sharpe'] is None else round(s['sharpe'], 2)}, fills {s['fills']}, "
          f"rejected batches {meta['rejected']}, errors {meta['errors']}, {meta['seconds']}s")
    print("TVRE_RESULT " + json.dumps({"output_dir": os.path.abspath(out)}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
