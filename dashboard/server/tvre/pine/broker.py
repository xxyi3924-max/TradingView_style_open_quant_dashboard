"""Strategy broker emulator, following TradingView's documented rules (Pine "Strategies" manual) and the
behavior measured on its own Strategy Tester reports (re/raw/strategy_reports, see re/STRATEGY_PARITY.md):

* Orders created on a bar's close are active from the next bar. Market orders fill at that bar's open.
* Intrabar path: if the open is closer to the high, price moves open → high → low → close, else
  open → low → high → close. Stop/limit orders fill when the path reaches them; an order the open
  already gapped past fills at the open.
* Fill prices are rounded to the symbol's tick; slippage adds ticks in the unfavorable direction.
* Default size (percent_of_equity): floor((capital + net profit + open profit at the order bar's
  close) × pct / close), floored to the symbol's quantity step.
* strategy.entry reverses an opposite position (closes it and opens the new size); entries in the
  position's direction are limited by `pyramiding`. strategy.order nets against the position.
* Margin (default 100% long and short): at each path vertex, if Available Funds = Equity − |Position
  value| × margin ratio < 0, a margin call liquidates 4 × TRUNC(|Loss| / price) units, where
  Loss = Available Funds / margin ratio.
* OCA groups cancel or reduce sibling orders; risk rules: allow_entry_in, max_intraday_loss,
  max_intraday_filled_orders.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

LONG, SHORT = 1, -1


@dataclass
class Order:
    id: str
    kind: str                  # "entry" | "order" | "close"
    dir: int
    qty: float
    limit: float | None
    stop: float | None
    oca_name: str
    oca_type: str              # "none" | "cancel" | "reduce"
    comment: str
    seq: int
    bar: int
    equity: float = 0.0        # equity when the order was placed (what its size was based on)
    ref: float = 0.0           # close (tick-rounded) when the order was placed

    @property
    def label(self) -> str:
        return self.comment or self.id


@dataclass
class Lot:
    entry_id: str
    label: str
    dir: int
    qty: float
    price: float
    time: int
    bar: int
    commission: float          # entry commission still attributed to this lot
    best: float = 0.0          # most favorable / adverse price seen while open
    worst: float = 0.0


@dataclass
class Trade:
    entry_label: str
    dir: int
    entry_price: float
    entry_time: int
    entry_bar: int
    exit_label: str
    exit_price: float
    exit_time: int
    exit_bar: int
    qty: float
    profit: float
    commission: float
    runup: float
    drawdown: float
    open: bool = False


@dataclass
class Props:
    initial_capital: float = 100_000.0
    default_qty_type: str = "percent_of_equity"      # fixed | cash_per_order | percent_of_equity
    default_qty_value: float = 100.0
    pyramiding: int = 1
    commission_type: str = "percent"                 # percent | cash_per_contract | cash_per_order
    commission_value: float = 0.0
    slippage: int = 0
    margin_long: float = 100.0
    margin_short: float = 100.0
    process_orders_on_close: bool = False
    close_entries_rule: str = "FIFO"
    risk_free_rate: float = 2.0

    @classmethod
    def from_dict(cls, d: dict) -> "Props":
        p = cls()
        for k, v in d.items():
            if hasattr(p, k) and v is not None:
                cur = getattr(p, k)
                setattr(p, k, type(cur)(v) if not isinstance(cur, bool) else bool(v))
        return p


class Broker:
    def __init__(self, props: Props, mintick: float, qty_step: float, tz: str = "UTC"):
        self.p = props
        self.tick = mintick
        self.step = qty_step
        self.tz = ZoneInfo(tz)
        self.realized = 0.0
        self.lots: list[Lot] = []
        self.orders: dict[str, Order] = {}
        self.trades: list[Trade] = []
        self.seq = 0
        self.margin_calls = 0
        self.commission_paid = 0.0
        self.allow_dir = 0                     # 0 = all, 1 = long only, -1 = short only
        self.max_intraday_loss: tuple[float, str] | None = None
        self.max_intraday_fills: int | None = None
        self._day = None
        self._day_equity = 0.0
        self._day_fills = 0
        self._halted_day = None
        self.bar = -1
        self.time = 0
        self.close = None
        self.max_contracts = 0.0

    # ---------------------------------------------------------------- numbers
    def rt(self, price: float) -> float:
        """Round a price to the symbol's tick, halves away from zero (0.125 -> 0.13 at tick 0.01)."""
        n = math.floor(abs(price) / self.tick + 0.5)              # plain float rounding, like TradingView
        return math.copysign(round(n * self.tick, 10), price)

    def rt_order(self, price: float, direction: int, kind: str) -> float:
        """Order price on the tick grid, rounded against the trader: buy stops and sell limits up, sell stops and
        buy limits down (TradingView fills a buy stop at 2.563 for a raw level of 2.5621)."""
        x = price / self.tick
        up = (kind == "stop") == (direction == LONG)
        n = math.ceil(x - 1e-9) if up else math.floor(x + 1e-9)
        return round(n * self.tick, 10)

    def floor_qty(self, q: float) -> float:
        n = math.floor(q / self.step)
        return round(n * self.step, 10)

    @property
    def position(self) -> float:
        return sum(l.dir * l.qty for l in self.lots)

    @property
    def avg_price(self) -> float | None:
        q = sum(l.qty for l in self.lots)
        return sum(l.qty * l.price for l in self.lots) / q if q else None

    def open_profit(self, price: float) -> float:
        return sum(l.dir * l.qty * (price - l.price) for l in self.lots)

    def equity(self, price: float | None = None) -> float:
        price = self.close if price is None else price
        return self.p.initial_capital + self.realized + (self.open_profit(price) if price is not None else 0.0)

    def _commission(self, qty: float, price: float) -> float:
        v = self.p.commission_value
        if not v:
            return 0.0
        if self.p.commission_type == "percent":
            return qty * price * v / 100.0
        if self.p.commission_type == "cash_per_contract":
            return qty * v
        return v

    def default_qty(self, price: float) -> float:
        t, v = self.p.default_qty_type, self.p.default_qty_value
        px = self.rt(price)
        if t == "fixed":
            return float(v)
        if t == "cash_per_order":
            return self.floor_qty(v / px)
        eq = round(self.equity(self.rt(self.close)), 8)            # equity at the bar's close; money at 1e-8 like TradingView
        return self.floor_qty(eq * v / 100.0 / px)

    # ---------------------------------------------------------------- script API (called on bar close)
    def entry(self, oid, direction, qty=None, limit=None, stop=None, oca_name="", oca_type="none", comment=""):
        if self._halted():
            return
        pos = self.position
        if pos * direction > 0 and len(self.lots) >= max(self.p.pyramiding, 1):
            self.orders.pop(oid, None)                     # pyramiding limit reached: the entry is ignored
            return
        q = qty if qty is not None else self.default_qty(self._sizing_price(direction, limit, stop))
        self._place(Order(oid, "entry", direction, q, limit, stop, oca_name or "", oca_type or "none", comment or "", 0, self.bar,
                          self.equity(self.rt(self.close)), self.rt(self.close)))

    def _sizing_price(self, direction: int, limit, stop) -> float:
        """Price a default-size order is sized at: the worse of the close and the order's own price."""
        px = self.rt(self.close)
        lvl = stop if stop is not None else limit
        if lvl is None:
            return px
        lvl = self.rt_order(lvl, direction, "stop" if stop is not None else "limit")
        return max(px, lvl) if direction == LONG else min(px, lvl)

    def order(self, oid, direction, qty=None, limit=None, stop=None, oca_name="", oca_type="none", comment=""):
        if self._halted():
            return
        q = qty if qty is not None else self.default_qty(self._sizing_price(direction, limit, stop))
        if not q or q <= 0:
            return
        self._place(Order(oid, "order", direction, q, limit, stop, oca_name or "", oca_type or "none", comment or "", 0, self.bar))

    def close_entry(self, entry_id: str, comment: str = "", qty=None):
        lots = [l for l in self.lots if l.entry_id == entry_id]
        if not lots:
            return
        q = sum(l.qty for l in lots) if qty is None else qty
        self._place(Order(f"__close_{entry_id}", "close", -lots[0].dir, q, None, None, "", "none", comment or f"Close entry(s) order {entry_id}", 0, self.bar))

    def close_all(self, comment: str = ""):
        if self.lots:
            self._place(Order("__close_all", "close", -self.lots[0].dir, sum(l.qty for l in self.lots), None, None, "", "none",
                              comment or "Close position order", 0, self.bar))

    def cancel(self, oid: str):
        self.orders.pop(oid, None)

    def cancel_all(self):
        self.orders.clear()

    def _place(self, o: Order):
        prev = self.orders.get(o.id)
        self.seq += 1
        o.seq = prev.seq if prev else self.seq                    # modifying an order keeps its queue position
        self.orders[o.id] = o
        if not prev:
            # keep dict order = placement order
            self.orders = dict(sorted(self.orders.items(), key=lambda kv: kv[1].seq))

    # ---------------------------------------------------------------- bar processing
    def _halted(self) -> bool:
        return self._halted_day is not None and self._halted_day == self._day

    def start_bar(self, bar: int, t: int, o: float, h: float, l: float, c: float):
        """Process pending orders over the bar's emulated path, then set up for the script's close run."""
        self.bar, self.time = bar, t
        self._bar_high, self._bar_low = h, l
        day = datetime.fromtimestamp(t, self.tz).date()
        if day != self._day:
            self._day = day
            self._day_equity = self.equity(o) if self.lots else self.p.initial_capital + self.realized
            self._day_fills = 0
        path = [o, h, l, c] if (h - o) < (o - l) else [o, l, h, c]
        for lot in self.lots:
            lot.best = lot.best if lot.best else lot.price
            lot.worst = lot.worst if lot.worst else lot.price
        # opening tick: market orders, and price orders the open already satisfies (gap fills).
        # TradingView fills at most one order per historical bar (margin calls aside): later orders wait.
        self._filled_bar = False
        self._fill_at_open(o)
        self._after_tick(o)
        for a, b in zip(path, path[1:]):
            self._run_segment(a, b)
            self._after_tick(b)
        self.close = c

    def _after_tick(self, price: float):
        for lot in self.lots:
            if lot.dir == LONG:
                lot.best, lot.worst = max(lot.best, price), min(lot.worst, price)
            else:
                lot.best, lot.worst = min(lot.best, price), max(lot.worst, price)
        self._margin_check(price)
        self._risk_check(price)

    def _fill_at_open(self, o: float):
        for oid in list(self.orders):
            if self._filled_bar:
                return
            od = self.orders.get(oid)
            if od is None or od.bar >= self.bar:
                continue
            if od.limit is None and od.stop is None:
                self._fill(od, o, True)
            elif self._crossed_at(od, o):
                self._fill(od, o, True)

    def _crossed_at(self, od: Order, px: float) -> bool:
        """Is a price order already marketable at price `px` (stop reached / limit at or better)? Prices are
        compared on the tick grid: an AAPL 1980 open of 0.118861 reaches a buy stop at 0.12 (re/STRATEGY_PARITY.md)."""
        px = self.rt(px)
        if od.stop is not None:
            s = self.rt_order(od.stop, od.dir, "stop")
            if (od.dir == LONG and px >= s) or (od.dir == SHORT and px <= s):
                if od.limit is None:
                    return True
                lim = self.rt_order(od.limit, od.dir, "limit")
                return (od.dir == LONG and px <= lim) or (od.dir == SHORT and px >= lim)
            return False
        lim = self.rt_order(od.limit, od.dir, "limit")
        return (od.dir == LONG and px <= lim) or (od.dir == SHORT and px >= lim)

    def _run_segment(self, a: float, b: float):
        """Fill price orders whose level lies on the move a -> b, in the order the price reaches them."""
        while not self._filled_bar:
            best = None
            for od in self.orders.values():
                if od.bar >= self.bar or (od.limit is None and od.stop is None):
                    continue
                lvl = self._trigger_level(od, a, b)
                if lvl is None:
                    continue
                key = (abs(lvl - a), od.seq)
                if best is None or key < best[0]:
                    best = (key, od, lvl)
            if best is None:
                return
            _, od, lvl = best
            self._fill(od, lvl)
            a = lvl

    def _trigger_level(self, od: Order, a: float, b: float):
        a, b = self.rt(a), self.rt(b)                  # the move on the tick grid, like the order levels
        up = b > a
        lo, hi = (a, b) if up else (b, a)
        if od.stop is not None:
            s = self.rt_order(od.stop, od.dir, "stop")
            hit = (od.dir == LONG and up and a < s <= b) or (od.dir == SHORT and not up and b <= s < a)
            if not hit:
                return None
            if od.limit is None:
                return s
            lim = self.rt_order(od.limit, od.dir, "limit")   # stop-limit: becomes a limit order once triggered
            return s if (od.dir == LONG and s <= lim) or (od.dir == SHORT and s >= lim) else None
        lim = self.rt_order(od.limit, od.dir, "limit")
        if od.dir == LONG and not up and b <= lim < a:
            return lim
        if od.dir == SHORT and up and a < lim <= b:
            return lim
        return None

    # ---------------------------------------------------------------- fills
    def _px(self, price: float, direction: int) -> float:
        return self.rt(price) + direction * self.p.slippage * self.tick

    def _fill(self, od: Order, price: float, at_open: bool = False):
        self.orders.pop(od.id, None)
        px = self._px(price, od.dir)
        filled = 0.0
        if od.kind == "entry":
            pos = self.position
            if self.allow_dir and od.dir != self.allow_dir:
                if pos * od.dir < 0:
                    filled = self._close_qty(abs(pos), px, od.label)
            elif pos * od.dir > 0:
                if len(self.lots) >= max(self.p.pyramiding, 1):
                    return
                if self._funding(od, px, held=abs(pos)) != "ok":
                    return                                  # adding needs funds beyond the open position's value
                self._open(od, od.qty, px)
                filled = od.qty
            else:
                verdict = self._funding(od, px)
                if verdict == "reject":
                    return                                  # the whole order is rejected; the position stays
                if verdict == "close_only":
                    if pos:                                 # the opposite position is closed, the new entry dropped
                        filled += self._close_qty(abs(pos), px, od.label)
                        self._day_fills += 1
                        self._filled_bar = True
                    return
                if pos:
                    filled += self._close_qty(abs(pos), px, od.label)
                self._open(od, od.qty, px)
                filled += od.qty
        elif od.kind == "order":
            pos = self.position
            q = od.qty
            if pos * od.dir < 0:
                c = min(q, abs(pos))
                self._close_qty(c, px, od.label)
                q -= c
                filled += c
            if q > 1e-12:
                self._open(od, q, px)
                filled += q
        else:  # close
            pos = self.position
            if pos * od.dir < 0:
                filled = self._close_qty(min(od.qty, abs(pos)), px, od.label)
        if filled:
            self._filled_bar = True
            self._day_fills += 1
            self.max_contracts = max(self.max_contracts, abs(self.position))
            self._apply_oca(od, filled)

    def _funding(self, od: Order, px: float, held: float = 0.0) -> str:
        """TradingView's funding checks for an entry (measured, see re/STRATEGY_PARITY.md), with strict float
        comparisons against the equity the order was sized with:
        * value at the fill price above it -> the whole order is rejected (205/205 MACD signals: every market
          entry filled above its signal close);
        * otherwise, value at the close when the order was placed above it -> only the opposite position is
          closed (sell stops below the market, sized at the stop; whole-share ties);
        * otherwise -> filled."""
        pct = self.p.margin_long if od.dir == LONG else self.p.margin_short
        if not pct:
            return "ok"
        r = pct / 100.0
        if (od.qty + held) * px * r > od.equity:        # `held`: units already open in the same direction
            return "reject"
        if (od.qty + held) * od.ref * r > od.equity:
            return "close_only"
        return "ok"

    def _apply_oca(self, od: Order, filled: float):
        if not od.oca_name or od.oca_type == "none":
            return
        for oid, other in list(self.orders.items()):
            if other.oca_name != od.oca_name:
                continue
            if od.oca_type == "cancel":
                self.orders.pop(oid, None)
            elif od.oca_type == "reduce":
                other.qty = round(other.qty - filled, 10)
                if other.qty <= 1e-12:
                    self.orders.pop(oid, None)

    def _open(self, od: Order, qty: float, px: float):
        if qty <= 0:
            return
        com = self._commission(qty, px)
        self.commission_paid += com
        self.realized -= com
        self.lots.append(Lot(od.id, od.label, od.dir, qty, px, self.time, self.bar, com, px, px))

    def _close_qty(self, qty: float, px: float, label: str) -> float:
        """Close `qty` units FIFO at `px`; each closed (part of a) lot becomes a trade."""
        left = qty
        closed = 0.0
        while left > 1e-12 and self.lots:
            lot = self.lots[0]
            q = min(lot.qty, left)
            frac = q / lot.qty
            entry_com = lot.commission * frac
            exit_com = self._commission(q, px)
            self.commission_paid += exit_com
            gross = lot.dir * q * (px - lot.price)
            self.realized += gross - exit_com
            runup = max(0.0, lot.dir * (lot.best - lot.price)) * q
            dd = min(0.0, lot.dir * (lot.worst - lot.price)) * q
            self.trades.append(Trade(lot.label, lot.dir, lot.price, lot.time, lot.bar, label, px, self.time, self.bar,
                                     q, gross - entry_com - exit_com, entry_com + exit_com, runup, dd))
            lot.qty = round(lot.qty - q, 10)
            lot.commission -= entry_com
            if lot.qty <= 1e-12:
                self.lots.pop(0)
            left = round(left - q, 10)
            closed += q
        return closed

    # ---------------------------------------------------------------- margin & risk
    def _margin_check(self, price: float):
        """Margin call, computed in the order of TradingView's documented algorithm (the float path matters
        for whole-unit edge cases): Money Spent, MVS, Open Profit, Equity, Margin, Available Funds, Loss,
        Cover Amount = TRUNCATE(Loss / Current Price), Margin Call Size = Cover Amount x 4."""
        if not self.lots:
            return
        d = self.lots[0].dir
        pct = self.p.margin_long if d == LONG else self.p.margin_short
        if not pct:
            return
        price = self.rt(price)
        qty = sum(l.qty for l in self.lots)
        money_spent = sum(l.qty * l.price for l in self.lots)
        mvs = qty * price
        open_profit = (mvs - money_spent) * d
        equity = self.p.initial_capital + self.realized + open_profit
        ratio = pct / 100.0
        margin = mvs * ratio
        available = equity - margin
        if available >= -1e-6:                                  # float noise is not a margin call
            return
        # money carries 8 decimals (as in sizing): without this, P&L dust accumulated over many trades makes
        # TRUNCATE(Loss / Price) land one unit short of TradingView's (e.g. 24765.99999999991 vs 24766)
        available = round(available, 8)
        loss = available / ratio
        cover = math.floor(abs(loss / price) / self.step) * self.step
        size = min(round(cover * 4, 10), qty) if cover > 0 else min(1.0, qty)   # at least one unit
        self.margin_calls += 1
        self._close_qty(size, price, "Margin call")

    def _risk_check(self, price: float):
        if self._halted():
            return
        if self.max_intraday_loss is not None:
            value, kind = self.max_intraday_loss
            limit = self._day_equity * value / 100.0 if kind == "percent_of_equity" else value
            if self.equity(self.rt(price)) - self._day_equity <= -limit:
                self._halt(price, "Close Position (Max intraday Loss)")
                return
        if self.max_intraday_fills is not None and self._day_fills >= self.max_intraday_fills:
            self._halt(price, "Close Position (Max number of filled orders in one day)")

    def _halt(self, price: float, label: str):
        self.orders.clear()
        if self.lots:
            self._close_qty(abs(self.position), self._px(price, -self.lots[0].dir), label)
        self._halted_day = self._day

    # ---------------------------------------------------------------- results
    def open_trades(self, price: float) -> list[Trade]:
        out = []
        for lot in self.lots:
            gross = lot.dir * lot.qty * (price - lot.price)
            out.append(Trade(lot.label, lot.dir, lot.price, lot.time, lot.bar, "", price, self.time, self.bar, lot.qty,
                             gross - lot.commission, lot.commission, max(0.0, lot.dir * (lot.best - lot.price)) * lot.qty,
                             min(0.0, lot.dir * (lot.worst - lot.price)) * lot.qty, open=True))
        return out
