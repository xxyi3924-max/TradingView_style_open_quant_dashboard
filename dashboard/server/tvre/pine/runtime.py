"""Pine interpreter: runs a parsed script bar by bar with Pine's series semantics, driving the broker.

Execution model (as in TradingView): for each bar, the broker first processes pending orders over the
bar's emulated price path, then the script runs once on the bar's close. Every variable is a series:
`x[n]` reads its value at the end of the bar n bars ago. Each call site of a `ta.*` function, and each
call site of a user function (with everything inside it), keeps its own state.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from . import ta
from .broker import LONG, SHORT, Broker, Props, Trade
from .parser import (Assign, BinOp, Bool, Call, Decl, ExprStmt, For, FuncDef, IfExpr, Index, Na, Name, Num, Script,
                     Str, Ternary, TupleDecl, Unary, parse)


FLOAT_EPS = 1e-10


class PineRuntimeError(RuntimeError):
    pass


def na(x) -> bool:
    return x is None or (isinstance(x, float) and math.isnan(x))


def truthy(x) -> bool:
    if na(x):
        return False
    return bool(x)


class SeriesVar:
    __slots__ = ("hist", "cur", "initialized")

    def __init__(self):
        self.hist: dict[int, object] = {}
        self.cur = None
        self.initialized = False

    def get(self, bar: int, k: int):
        return self.cur if k == 0 else self.hist.get(bar - k)


class Scope:
    __slots__ = ("vars", "parent")

    def __init__(self, parent=None):
        self.vars: dict[str, SeriesVar] = {}
        self.parent = parent

    def find(self, name: str):
        s = self
        while s is not None:
            v = s.vars.get(name)
            if v is not None:
                return v
            s = s.parent
        return None


@dataclass
class InputSpec:
    index: int
    title: str
    type: str
    default: object
    options: list | None = None
    minval: float | None = None
    maxval: float | None = None
    step: float | None = None


@dataclass
class RunResult:
    title: str
    props: Props
    inputs: list[InputSpec]
    trades: list[Trade]
    open_trades: list[Trade]
    equity: list[float]            # equity at each bar's close
    plots: dict[str, list]
    broker: Broker
    bars: list[dict]


BAR_SERIES = {"open", "high", "low", "close", "volume", "time", "hl2", "hlc3", "ohlc4", "hlcc4", "bar_index", "time_close"}
TA_CLASSES = {
    "sma": ta.SMA, "ema": ta.EMA, "rma": ta.RMA, "stdev": ta.Stdev, "rsi": ta.RSI, "change": ta.Change,
    "highest": lambda: ta.Extreme(max), "lowest": lambda: ta.Extreme(min),
    "crossover": lambda: ta.Cross("over"), "crossunder": lambda: ta.Cross("under"), "cross": lambda: ta.Cross("any"),
    "stoch": ta.Stoch, "atr": ta.ATR, "tr": ta.TR, "pivothigh": lambda: ta.Pivot("high"), "pivotlow": lambda: ta.Pivot("low"),
    "supertrend": ta.Supertrend,
}
LEGACY_TA = {"sma", "ema", "rma", "stdev", "rsi", "change", "highest", "lowest", "crossover", "crossunder", "cross",
             "stoch", "atr", "tr", "pivothigh", "pivotlow"}
COLORS = {"black", "white", "red", "green", "blue", "orange", "purple", "yellow", "gray", "aqua", "lime", "maroon",
          "navy", "olive", "silver", "teal", "fuchsia"}


class Runtime:
    def __init__(self, script: Script | str, bars: list[dict], *, inputs: dict | None = None, props: dict | None = None,
                 mintick: float = 0.01, qty_step: float = 1.0, tz: str = "UTC", symbol: str = "", timeframe: str = "D"):
        self.script = parse(script) if isinstance(script, str) else script
        self.bars = bars
        self.n = len(bars)
        self.input_overrides = inputs or {}
        self.prop_overrides = props or {}
        self.mintick = mintick
        self.qty_step = qty_step
        self.tz = tz
        self.symbol = symbol
        self.timeframe = timeframe
        self.registry: dict[tuple, SeriesVar] = {}
        self.ta_state: dict[tuple, object] = {}
        self.funcs: dict[str, FuncDef] = {}
        self.inputs: dict[int, InputSpec] = {}
        self.input_seq = 0
        self.plots: dict[str, list] = {}
        self.title = ""
        self.bar = 0
        self.broker: Broker | None = None
        self.props = Props()

    # ---------------------------------------------------------------- driver
    def run(self) -> RunResult:
        self._declare()
        b = self.broker
        equity = []
        for i, bar in enumerate(self.bars):
            self.bar = i
            self.input_seq = 0
            if i > 0 or True:
                b.start_bar(i, int(bar["time"]), bar["open"], bar["high"], bar["low"], bar["close"])
            scope = Scope()
            self._exec_block(self.script.body, scope, ())
            for sv in self.registry.values():
                sv.hist[i] = sv.cur
            for vals in self.plots.values():
                if len(vals) < i + 1:
                    vals.append(None)
            equity.append(b.equity(bar["close"]))
        last = self.bars[-1]["close"] if self.bars else 0.0
        return RunResult(self.title, self.props, [self.inputs[k] for k in sorted(self.inputs)], b.trades,
                         b.open_trades(b.rt(last)), equity, self.plots, b, self.bars)

    def _declare(self):
        """Read the strategy(...) declaration (constant arguments) before the first bar."""
        decl = None
        for st in self.script.body:
            if isinstance(st, ExprStmt) and isinstance(st.expr, Call) and st.expr.func in ("strategy", "study", "indicator"):
                decl = st.expr
                break
        if decl is None or decl.func != "strategy":
            raise PineRuntimeError("not a strategy: the script has no strategy(...) declaration")
        args = self._bind_args(decl, ["title", "shorttitle", "overlay", "format", "precision", "scale", "pyramiding",
                                      "calc_on_order_fills", "calc_on_every_tick", "max_bars_back", "backtest_fill_limits_assumption",
                                      "default_qty_type", "default_qty_value", "initial_capital", "currency", "slippage",
                                      "commission_type", "commission_value", "process_orders_on_close", "close_entries_rule",
                                      "margin_long", "margin_short"], (), Scope())
        self.title = str(args.get("title") or "")
        d = {k: v for k, v in args.items() if k in Props.__dataclass_fields__ and v is not None}
        if "default_qty_type" in d:
            d["default_qty_type"] = {"fixed": "fixed", "cash": "cash_per_order", "percent_of_equity": "percent_of_equity"}.get(
                str(d["default_qty_type"]).replace("strategy.", ""), "percent_of_equity")
        if "commission_type" in d:
            d["commission_type"] = {"percent": "percent", "cash_per_contract": "cash_per_contract", "cash_per_order": "cash_per_order"}.get(
                str(d["commission_type"]).replace("strategy.commission.", ""), "percent")
        d.update({k: v for k, v in self.prop_overrides.items() if v is not None})
        self.props = Props.from_dict(d)
        self.broker = Broker(self.props, self.mintick, self.qty_step, self.tz)

    # ---------------------------------------------------------------- statements
    def _exec_block(self, body: list, scope: Scope, ctx: tuple):
        val = None
        for st in body:
            val = self._exec(st, scope, ctx)
        return val

    def _var(self, ctx: tuple, key) -> SeriesVar:
        k = (ctx, key)
        sv = self.registry.get(k)
        if sv is None:
            sv = self.registry[k] = SeriesVar()
        return sv

    def _exec(self, st, scope: Scope, ctx: tuple):
        if isinstance(st, Decl):
            sv = self._var(ctx, st.id)
            scope.vars[st.name] = sv
            if st.mode and sv.initialized:
                return sv.cur
            v = self._eval(st.expr, scope, ctx)
            if st.typ == "int" and not na(v) and not isinstance(v, bool):
                v = int(v)
            sv.cur, sv.initialized = v, True
            return v
        if isinstance(st, TupleDecl):
            vals = self._eval(st.expr, scope, ctx)
            if not isinstance(vals, (list, tuple)):
                raise PineRuntimeError("tuple declaration needs a tuple value")
            for j, name in enumerate(st.names):
                sv = self._var(ctx, (st.id, j))
                scope.vars[name] = sv
                sv.cur = vals[j] if j < len(vals) else None
            return vals
        if isinstance(st, Assign):
            sv = scope.find(st.name)
            if sv is None:
                raise PineRuntimeError(f"undeclared variable {st.name!r}")
            v = self._eval(st.expr, scope, ctx)
            if st.op != ":=":
                v = self._binop(st.op[0], sv.cur, v)
            sv.cur = v
            return v
        if isinstance(st, IfExpr):
            return self._if(st, scope, ctx)
        if isinstance(st, For):
            start, end = self._eval(st.start, scope, ctx), self._eval(st.end, scope, ctx)
            step = self._eval(st.step, scope, ctx) if st.step else (1 if end >= start else -1)
            val = None
            i = start
            while (step > 0 and i <= end) or (step < 0 and i >= end):
                inner = Scope(scope)
                sv = SeriesVar(); sv.cur = i
                inner.vars[st.var] = sv
                val = self._exec_block(st.body, inner, ctx)
                i += step
            return val
        if isinstance(st, FuncDef):
            self.funcs[st.name] = st
            return None
        if isinstance(st, ExprStmt):
            return self._eval(st.expr, scope, ctx)
        raise PineRuntimeError(f"unsupported statement {type(st).__name__}")

    def _if(self, st: IfExpr, scope: Scope, ctx: tuple):
        if truthy(self._eval(st.cond, scope, ctx)):
            return self._exec_block(st.body, Scope(scope), ctx)
        if st.orelse:
            return self._exec_block(st.orelse, Scope(scope), ctx)
        return None

    # ---------------------------------------------------------------- expressions
    def _eval(self, e, scope: Scope, ctx: tuple):
        if isinstance(e, Num):
            return e.value
        if isinstance(e, Name):
            return self._name(e.name, scope, ctx, e)
        if isinstance(e, BinOp):
            if e.op == "and":
                return truthy(self._eval(e.left, scope, ctx)) and truthy(self._eval(e.right, scope, ctx))
            if e.op == "or":
                return truthy(self._eval(e.left, scope, ctx)) or truthy(self._eval(e.right, scope, ctx))
            return self._binop(e.op, self._eval(e.left, scope, ctx), self._eval(e.right, scope, ctx))
        if isinstance(e, Call):
            return self._call(e, scope, ctx)
        if isinstance(e, Ternary):
            return self._eval(e.then if truthy(self._eval(e.cond, scope, ctx)) else e.other, scope, ctx)
        if isinstance(e, Index):
            return self._index(e, scope, ctx)
        if isinstance(e, Unary):
            v = self._eval(e.expr, scope, ctx)
            if e.op == "not":
                return not truthy(v)
            if na(v):
                return None
            return -v if e.op == "-" else v
        if isinstance(e, Bool):
            return e.value
        if isinstance(e, Str):
            return e.value
        if isinstance(e, Na):
            return None
        if isinstance(e, IfExpr):
            return self._if(e, scope, ctx)
        raise PineRuntimeError(f"unsupported expression {type(e).__name__}")

    def _binop(self, op: str, a, b):
        if op in ("==", "!="):
            if na(a) or na(b):
                return False
            if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
                same = abs(a - b) <= FLOAT_EPS * max(1.0, abs(a), abs(b))
            else:
                same = a == b
            return same if op == "==" else not same
        if na(a) or na(b):
            return False if op in ("<", ">", "<=", ">=") else None
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op == "/":
            return None if b == 0 else a / b
        if op == "%":
            return None if b == 0 else math.fmod(a, b)
        if op in ("<", ">", "<=", ">="):
            # Pine compares floats with a tolerance: differences at the level of float noise count as equal
            # (TradingView treats close-close[12] differing by 4e-16 as equal; re/STRATEGY_PARITY.md)
            eq = abs(a - b) <= FLOAT_EPS * max(1.0, abs(a), abs(b))
            if op == "<":
                return a < b and not eq
            if op == ">":
                return a > b and not eq
            if op == "<=":
                return a <= b or eq
            return a >= b or eq
        raise PineRuntimeError(f"unknown operator {op}")

    def _bar_value(self, name: str, i: int):
        if i < 0 or i >= self.n:
            return None
        b = self.bars[i]
        if name == "bar_index":
            return i
        if name == "time":
            return int(b["time"]) * 1000
        if name == "hl2":
            return (b["high"] + b["low"]) / 2
        if name == "hlc3":
            return (b["high"] + b["low"] + b["close"]) / 3
        if name == "ohlc4":
            return (b["open"] + b["high"] + b["low"] + b["close"]) / 4
        if name == "hlcc4":
            return (b["high"] + b["low"] + 2 * b["close"]) / 4
        if name == "time_close":
            return None
        return b[name]

    def _index(self, e: Index, scope: Scope, ctx: tuple):
        k = self._eval(e.offset, scope, ctx)
        if na(k):
            return None
        k = int(k)
        t = e.target
        if isinstance(t, Name):
            sv = scope.find(t.name)
            if sv is not None:
                return sv.get(self.bar, k)
            if t.name in BAR_SERIES:
                return self._bar_value(t.name, self.bar - k)
        # any other expression: keep a hidden series of its values at this site
        sv = self._var(ctx, ("idx", e.id))
        sv.cur = self._eval(t, scope, ctx)
        return sv.get(self.bar, k)

    def _name(self, name: str, scope: Scope, ctx: tuple, node):
        sv = scope.find(name)
        if sv is not None:
            return sv.cur
        if name in BAR_SERIES:
            return self._bar_value(name, self.bar)
        b = self.broker
        consts = {
            "strategy.long": LONG, "strategy.short": SHORT, "true": True, "false": False,
            "strategy.percent_of_equity": "percent_of_equity", "strategy.fixed": "fixed", "strategy.cash": "cash",
            "strategy.oca.cancel": "cancel", "strategy.oca.reduce": "reduce", "strategy.oca.none": "none",
            "strategy.direction.all": 0, "strategy.direction.long": LONG, "strategy.direction.short": SHORT,
            "strategy.commission.percent": "percent", "strategy.commission.cash_per_contract": "cash_per_contract",
            "strategy.commission.cash_per_order": "cash_per_order",
        }
        if name in consts:
            return consts[name]
        if name == "strategy.position_size":
            return b.position
        if name == "strategy.position_avg_price":
            return b.avg_price
        if name == "strategy.opentrades":
            return len(b.lots)
        if name == "strategy.closedtrades":
            return len(b.trades)
        if name == "strategy.equity":
            return b.equity()
        if name == "strategy.netprofit":
            return b.realized
        if name == "strategy.openprofit":
            return b.open_profit(b.close) if b.close is not None else 0.0
        if name == "strategy.initial_capital":
            return self.props.initial_capital
        if name == "syminfo.mintick":
            return self.mintick
        if name in ("syminfo.tickerid", "syminfo.ticker"):
            return self.symbol
        if name == "timeframe.period":
            return self.timeframe
        if name == "barstate.isconfirmed" or name == "barstate.ishistory":
            return True
        if name == "barstate.isrealtime":
            return False
        if name == "barstate.islast":
            return self.bar == self.n - 1
        if name == "barstate.isfirst":
            return self.bar == 0
        if name in ("ta.tr", "tr"):
            return self._ta("tr", (ctx, node.id), self._bar_value("high", self.bar), self._bar_value("low", self.bar),
                            self._bar_value("close", self.bar), False)
        if name in COLORS or name.startswith("color.") or name.startswith("plot.") or name.startswith("display.") \
                or name.startswith("shape.") or name.startswith("location.") or name.startswith("size."):
            return name
        raise PineRuntimeError(f"unknown name {name!r}")

    # ---------------------------------------------------------------- calls
    def _bind_args(self, call: Call, params: list[str], ctx: tuple, scope: Scope) -> dict:
        out = {}
        for i, a in enumerate(call.args):
            if i < len(params):
                out[params[i]] = self._eval(a, scope, ctx)
        for k, a in call.kwargs.items():
            out[k] = self._eval(a, scope, ctx)
        return out

    def _ta(self, fname: str, key: tuple, *args):
        st = self.ta_state.get(key)
        if st is None:
            st = self.ta_state[key] = TA_CLASSES[fname]()
        return st.step(*args)

    def _call(self, c: Call, scope: Scope, ctx: tuple):
        f = c.func
        if f == "__tuple__":
            return [self._eval(a, scope, ctx) for a in c.args]
        if f in self.funcs:
            return self._call_user(self.funcs[f], c, scope, ctx)
        if f in ("strategy", "study", "indicator"):
            return None
        ev = lambda a: self._eval(a, scope, ctx)
        key = (ctx, c.id)
        name = f[3:] if f.startswith("ta.") else f if f in LEGACY_TA else None
        if name is not None and name in TA_CLASSES:
            return self._call_ta(name, c, scope, ctx, key)
        if f in ("na",):
            return na(ev(c.args[0]))
        if f in ("nz",):
            v = ev(c.args[0])
            return (ev(c.args[1]) if len(c.args) > 1 else 0) if na(v) else v
        if f == "fixnan":
            v = ev(c.args[0])
            sv = self._var(ctx, ("fixnan", c.id))
            if not na(v):
                sv.cur = v
            return sv.cur
        if f.startswith("math.") or f in ("max", "min", "abs", "round", "floor", "ceil", "sqrt", "log", "pow", "sign", "exp"):
            return self._math(f.replace("math.", ""), [ev(a) for a in c.args])
        if f == "input" or f.startswith("input."):
            return self._input(c, scope, ctx)
        if f.startswith("strategy."):
            return self._strategy_call(c, scope, ctx)
        if f in ("plot", "plotshape", "plotchar", "plotarrow"):
            args = self._bind_args(c, ["series", "title"], ctx, scope)
            title = str(args.get("title") or f"Plot {len(self.plots) + 1}")
            vals = self.plots.setdefault(title, [None] * self.bar)
            v = args.get("series")
            vals.append(v if isinstance(v, (int, float)) and not isinstance(v, bool) else None)
            return None
        if f in ("bgcolor", "barcolor", "hline", "fill", "alert", "alertcondition", "label.new", "line.new", "box.new") \
                or f.startswith("color.") or f.startswith("table."):
            return None
        if f in ("str.tostring", "tostring"):
            return str(ev(c.args[0]))
        raise PineRuntimeError(f"unsupported function {f}()")

    def _call_ta(self, name: str, c: Call, scope: Scope, ctx: tuple, key: tuple):
        ev = lambda a: self._eval(a, scope, ctx)
        bv = lambda s: self._bar_value(s, self.bar)
        a = [ev(x) for x in c.args]
        kw = {k: ev(v) for k, v in c.kwargs.items()}
        if name in ("sma", "ema", "rma", "stdev", "rsi", "highest", "lowest", "change"):
            if name in ("highest", "lowest") and len(a) == 1:      # ta.highest(length) uses high/low
                a = [bv("high" if name == "highest" else "low"), a[0]]
            if name == "change" and len(a) == 1:
                a.append(kw.get("length", 1))
            src = a[0] if a else kw.get("source")
            length = a[1] if len(a) > 1 else kw.get("length")
            return self._ta(name, key, src, length)
        if name in ("crossover", "crossunder", "cross"):
            return self._ta(name, key, a[0], a[1])
        if name == "stoch":
            return self._ta(name, key, a[0], a[1], a[2], a[3])
        if name == "atr":
            return self._ta(name, key, bv("high"), bv("low"), bv("close"), a[0] if a else kw.get("length"))
        if name == "tr":
            handle = a[0] if a else kw.get("handle_na", False)
            return self._ta(name, key, bv("high"), bv("low"), bv("close"), truthy(handle))
        if name in ("pivothigh", "pivotlow"):
            if len(a) == 2:
                a = [bv("high" if name == "pivothigh" else "low")] + a
            return self._ta(name, key, a[0], a[1], a[2])
        if name == "supertrend":
            st, d = self._ta(name, key, bv("high"), bv("low"), bv("close"), a[0] if a else kw["factor"], a[1] if len(a) > 1 else kw["atrPeriod"])
            return [st, d]
        raise PineRuntimeError(f"unsupported function ta.{name}()")

    def _call_user(self, fd: FuncDef, c: Call, scope: Scope, ctx: tuple):
        sub = ctx + (c.id,)
        fscope = Scope(self._global_scope(scope))
        vals = [self._eval(a, scope, ctx) for a in c.args]
        named = {k: self._eval(v, scope, ctx) for k, v in c.kwargs.items()}
        for j, (pname, default) in enumerate(fd.params):
            v = vals[j] if j < len(vals) else named.get(pname, self._eval(default, scope, ctx) if default is not None else None)
            sv = self._var(sub, ("param", pname))
            sv.cur = v
            fscope.vars[pname] = sv
        return self._exec_block(fd.body, fscope, sub)

    @staticmethod
    def _global_scope(scope: Scope) -> Scope:
        while scope.parent is not None:
            scope = scope.parent
        return scope

    def _math(self, f: str, a: list):
        if any(na(x) for x in a):
            return None
        if f == "max":
            return max(a)
        if f == "min":
            return min(a)
        if f == "abs":
            return abs(a[0])
        if f == "round":
            if len(a) > 1:
                return round(a[0], int(a[1]))
            return math.floor(a[0] + 0.5)
        if f == "round_to_mintick":
            return round(round(a[0] / self.mintick) * self.mintick, 10)
        if f == "floor":
            return math.floor(a[0])
        if f == "ceil":
            return math.ceil(a[0])
        if f == "sqrt":
            return math.sqrt(a[0]) if a[0] >= 0 else None
        if f == "log":
            return math.log(a[0]) if a[0] > 0 else None
        if f == "exp":
            return math.exp(a[0])
        if f == "pow":
            return a[0] ** a[1]
        if f == "sign":
            return (a[0] > 0) - (a[0] < 0)
        raise PineRuntimeError(f"unsupported function math.{f}()")

    # ---------------------------------------------------------------- inputs
    def _input(self, c: Call, scope: Scope, ctx: tuple):
        idx = self.input_seq
        self.input_seq += 1
        args = self._bind_args(c, ["defval", "title"], ctx, scope)
        default = args.get("defval")
        title = str(args.get("title") or f"Input {idx + 1}")
        kind = c.func.split(".", 1)[1] if "." in c.func else ("source" if isinstance(c.args[0] if c.args else None, Name)
                                                                 and c.args[0].name in BAR_SERIES else
                                                                 "bool" if isinstance(default, bool) else
                                                                 "int" if isinstance(default, int) else
                                                                 "float" if isinstance(default, float) else "string")
        if idx not in self.inputs:
            src_name = c.args[0].name if c.args and isinstance(c.args[0], Name) else None
            self.inputs[idx] = InputSpec(idx, title, kind, src_name if kind == "source" else default,
                                         args.get("options"), args.get("minval"), args.get("maxval"), args.get("step"))
        for k in (title, f"#{idx}"):
            if k in self.input_overrides:
                v = self.input_overrides[k]
                if kind == "source" and isinstance(v, str):
                    return self._bar_value(v, self.bar)
                return v
        return default

    # ---------------------------------------------------------------- strategy.*
    def _strategy_call(self, c: Call, scope: Scope, ctx: tuple):
        f, b = c.func, self.broker
        when = c.kwargs.get("when")
        if when is not None and not truthy(self._eval(when, scope, ctx)):
            return None
        num = lambda v: None if na(v) else float(v)
        if f == "strategy.entry":
            a = self._bind_args(c, ["id", "direction", "qty", "limit", "stop", "oca_name", "oca_type", "comment"], ctx, scope)
            b.entry(str(a["id"]), self._dir(a["direction"]), num(a.get("qty")), num(a.get("limit")), num(a.get("stop")),
                    a.get("oca_name") or "", a.get("oca_type") or "none", a.get("comment") or "")
        elif f == "strategy.order":
            a = self._bind_args(c, ["id", "direction", "qty", "limit", "stop", "oca_name", "oca_type", "comment"], ctx, scope)
            b.order(str(a["id"]), self._dir(a["direction"]), num(a.get("qty")), num(a.get("limit")), num(a.get("stop")),
                    a.get("oca_name") or "", a.get("oca_type") or "none", a.get("comment") or "")
        elif f == "strategy.cancel":
            a = self._bind_args(c, ["id"], ctx, scope)
            b.cancel(str(a["id"]))
        elif f == "strategy.cancel_all":
            b.cancel_all()
        elif f == "strategy.close":
            a = self._bind_args(c, ["id", "comment", "qty"], ctx, scope)
            b.close_entry(str(a["id"]), a.get("comment") or "", num(a.get("qty")))
        elif f == "strategy.close_all":
            a = self._bind_args(c, ["comment"], ctx, scope)
            b.close_all(a.get("comment") or "")
        elif f == "strategy.exit":
            self._exit(c, scope, ctx)
        elif f == "strategy.risk.allow_entry_in":
            a = self._bind_args(c, ["value"], ctx, scope)
            b.allow_dir = int(a["value"] or 0)
        elif f == "strategy.risk.max_intraday_loss":
            a = self._bind_args(c, ["value", "type"], ctx, scope)
            b.max_intraday_loss = (float(a["value"]), str(a.get("type") or "cash"))
        elif f == "strategy.risk.max_intraday_filled_orders":
            a = self._bind_args(c, ["count"], ctx, scope)
            b.max_intraday_fills = int(a["count"])
        elif f.startswith("strategy.risk."):
            pass                                   # other risk rules: not emulated
        else:
            raise PineRuntimeError(f"unsupported function {f}()")
        return None

    @staticmethod
    def _dir(v) -> int:
        if isinstance(v, bool):
            return LONG if v else SHORT
        return LONG if v == LONG or v == "long" else SHORT

    def _exit(self, c: Call, scope: Scope, ctx: tuple):
        """strategy.exit with absolute stop/limit prices or tick offsets (profit/loss) from the entry price.
        Trailing stops are approximated by their fixed `loss` component."""
        a = self._bind_args(c, ["id", "from_entry", "qty", "qty_percent", "profit", "limit", "loss", "stop"], ctx, scope)
        b = self.broker
        frm = a.get("from_entry") or ""
        lots = [l for l in b.lots if not frm or l.entry_id == frm]
        if not lots:
            return
        d = lots[0].dir
        qty = sum(l.qty for l in lots)
        entry = sum(l.qty * l.price for l in lots) / qty
        limit, stop = a.get("limit"), a.get("stop")
        if na(limit) and not na(a.get("profit")):
            limit = entry + d * a["profit"] * self.mintick
        if na(stop) and not na(a.get("loss")):
            stop = entry - d * a["loss"] * self.mintick
        oca = f"__exit_{a['id']}"
        comment = a.get("comment") or str(a["id"])
        if not na(limit):
            b.order(f"{a['id']}__tp", -d, qty, float(limit), None, oca, "reduce", comment)
        if not na(stop):
            b.order(f"{a['id']}__sl", -d, qty, None, float(stop), oca, "reduce", comment)
