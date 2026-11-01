"""Streaming `ta.*` functions for the Pine interpreter.

Pine evaluates a script once per bar; every *call site* of a `ta.*` function keeps its own state
(its own history of the argument values). Each class here is that state: `step(...)` is called once per
bar with the current argument values and returns the current output. `None` is Pine's `na`.
Formulas follow Pine's documented reference implementations and match `tvre.indicators` (which is
checked against TradingView to 1e-8 in re/PARITY.md).
"""
from __future__ import annotations

import math
from collections import deque


def _na(x) -> bool:
    return x is None or (isinstance(x, float) and math.isnan(x))


class Hist:
    """History of one argument at one call site (value per call, oldest first)."""
    __slots__ = ("vals",)

    def __init__(self):
        self.vals: list = []

    def push(self, v):
        self.vals.append(v)

    def get(self, k: int):
        i = len(self.vals) - 1 - k
        return self.vals[i] if 0 <= i < len(self.vals) else None


class SMA:
    def __init__(self):
        self.win: deque = deque()

    def step(self, src, length):
        length = int(length)
        self.win.append(src)
        while len(self.win) > length:
            self.win.popleft()
        if len(self.win) < length or any(_na(x) for x in self.win):
            return None
        return math.fsum(self.win) / length


class EMA:
    """alpha = 2/(length+1); seeded with the SMA of the first `length` values (TradingView's ta.ema)."""
    def __init__(self, alpha_fn=lambda n: 2.0 / (n + 1)):
        self.alpha_fn = alpha_fn
        self.seed: list = []
        self.value = None

    def step(self, src, length):
        length = int(length)
        if self.value is None:
            if _na(src):
                return None
            self.seed.append(src)
            if len(self.seed) < length:
                return None
            self.value = math.fsum(self.seed[-length:]) / length
            return self.value
        if not _na(src):
            a = self.alpha_fn(length)
            self.value = a * src + (1 - a) * self.value
        return self.value


class RMA(EMA):
    def __init__(self):
        super().__init__(lambda n: 1.0 / n)


class Stdev:
    """Population standard deviation over `length` values (ta.stdev, biased=true)."""
    def __init__(self):
        self.win: deque = deque()

    def step(self, src, length):
        length = int(length)
        self.win.append(src)
        while len(self.win) > length:
            self.win.popleft()
        if len(self.win) < length or any(_na(x) for x in self.win):
            return None
        m = math.fsum(self.win) / length
        return math.sqrt(math.fsum((x - m) ** 2 for x in self.win) / length)


class Extreme:
    """ta.highest / ta.lowest over the last `length` values (na until `length` values exist)."""
    def __init__(self, fn):
        self.fn = fn
        self.win: deque = deque()

    def step(self, src, length):
        length = int(length)
        self.win.append(src)
        while len(self.win) > length:
            self.win.popleft()
        vals = [x for x in self.win if not _na(x)]
        if len(self.win) < length or not vals:
            return None
        return self.fn(vals)


class Cross:
    """ta.crossover / crossunder / cross: compare this bar with the previous bar at this call site."""
    def __init__(self, kind: str):
        self.kind = kind
        self.prev = (None, None)

    def step(self, a, b):
        pa, pb = self.prev
        self.prev = (a, b)
        if any(_na(x) for x in (a, b, pa, pb)):
            return False
        eps = lambda x, y: abs(x - y) <= 1e-10 * max(1.0, abs(x), abs(y))
        up = a > b and not eps(a, b) and (pa <= pb or eps(pa, pb))
        dn = a < b and not eps(a, b) and (pa >= pb or eps(pa, pb))
        return up if self.kind == "over" else dn if self.kind == "under" else (up or dn)


class Change:
    def __init__(self):
        self.h = Hist()

    def step(self, src, length=1):
        self.h.push(src)
        prev = self.h.get(int(length))
        return None if _na(src) or _na(prev) else src - prev


class RSI:
    def __init__(self):
        self.prev = None
        self.up, self.dn = RMA(), RMA()

    def step(self, src, length):
        ch = None if _na(src) or _na(self.prev) else src - self.prev
        self.prev = src
        u = self.up.step(None if ch is None else max(ch, 0.0), length)
        d = self.dn.step(None if ch is None else -min(ch, 0.0), length)
        if _na(u) or _na(d):
            return None
        if d == 0:
            return 100.0
        if u == 0:
            return 0.0
        return 100.0 - 100.0 / (1.0 + u / d)


class TR:
    """ta.tr(handle_na): max(high-low, |high-close[1]|, |low-close[1]|); first bar na unless handle_na."""
    def __init__(self):
        self.prev_close = None

    def step(self, high, low, close, handle_na=False):
        pc, self.prev_close = self.prev_close, close
        if _na(pc):
            return high - low if handle_na else None
        return max(high - low, abs(high - pc), abs(low - pc))


class ATR:
    def __init__(self):
        self.tr, self.rma = TR(), RMA()

    def step(self, high, low, close, length):
        return self.rma.step(self.tr.step(high, low, close, True), length)


class Stoch:
    def __init__(self):
        self.hi, self.lo = Extreme(max), Extreme(min)

    def step(self, src, high, low, length):
        hh, ll = self.hi.step(high, length), self.lo.step(low, length)
        if any(_na(x) for x in (src, hh, ll)) or hh == ll:
            return None
        return 100.0 * (src - ll) / (hh - ll)


class Pivot:
    """ta.pivothigh / pivotlow(source, left, right): the value `right` bars back if it is at least as extreme
    as the `left` bars before it and strictly more extreme than the `right` bars after it (TradingView's tie
    rule, measured on the pivot strategies: re/STRATEGY_PARITY.md); na otherwise."""
    def __init__(self, kind: str):
        self.kind = kind
        self.h = Hist()

    def step(self, src, left, right):
        left, right = int(left), int(right)
        self.h.push(src)
        if len(self.h.vals) < left + right + 1:
            return None
        center = self.h.get(right)
        if _na(center):
            return None
        before = [self.h.get(right + k) for k in range(1, left + 1)]
        after = [self.h.get(k) for k in range(0, right)]
        if any(_na(x) for x in before + after):
            return None
        if self.kind == "high":
            ok = all(center >= x for x in before) and all(center > x for x in after)
        else:
            ok = all(center <= x for x in before) and all(center < x for x in after)
        return center if ok else None


class Supertrend:
    """Pine's documented ta.supertrend reference implementation; returns (supertrend, direction)."""
    def __init__(self):
        self.atr = ATR()
        self.prev_atr = None
        self.prev_upper = self.prev_lower = self.prev_st = None
        self.prev_close = None

    def step(self, high, low, close, factor, period):
        src = (high + low) / 2
        atr = self.atr.step(high, low, close, period)
        upper = None if _na(atr) else src + factor * atr
        lower = None if _na(atr) else src - factor * atr
        pl = 0.0 if _na(self.prev_lower) else self.prev_lower
        pu = 0.0 if _na(self.prev_upper) else self.prev_upper
        pc = self.prev_close
        if lower is not None:
            lower = lower if (lower > pl or (not _na(pc) and pc < pl)) else pl
        if upper is not None:
            upper = upper if (upper < pu or (not _na(pc) and pc > pu)) else pu
        if _na(self.prev_atr):
            direction = 1
        elif not _na(self.prev_st) and self.prev_st == self.prev_upper:
            direction = -1 if (upper is not None and close > upper) else 1
        else:
            direction = 1 if (lower is not None and close < lower) else -1
        st = lower if direction == -1 else upper
        self.prev_atr, self.prev_upper, self.prev_lower, self.prev_st, self.prev_close = atr, upper, lower, st, close
        return st, direction
