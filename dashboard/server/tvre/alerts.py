"""Alert conditions evaluated on bar series.

Condition JSON:
  {"left": OPERAND, "op": OP, "right": OPERAND}                        comparison / crossing
  {"left": OPERAND, "op": "entering_channel", "upper": OPERAND, "lower": OPERAND}
OPERAND: {"kind": "price", "field": "close"} | {"kind": "value", "value": 4.5}
       | {"kind": "indicator", "type": "RSI", "inputs": {...}, "output": "rsi"}
OP: crossing, crossing_up, crossing_down, greater_than, less_than,
    entering_channel, exiting_channel, inside_channel, outside_channel
Crossing semantics follow Pine: crossover = a > b and a[1] <= b[1]; crossunder = a < b and a[1] >= b[1].
Triggers: "once" (fire then deactivate), "once_per_bar" (forming bar included),
          "once_per_bar_close" (closed bars only).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import indicators

OPS = {"crossing", "crossing_up", "crossing_down", "greater_than", "less_than",
       "entering_channel", "exiting_channel", "inside_channel", "outside_channel"}
TRIGGERS = {"once", "once_per_bar", "once_per_bar_close"}


def operand(spec: dict, bars: pd.DataFrame) -> np.ndarray:
    kind = spec.get("kind")
    if kind == "price":
        return bars[spec.get("field", "close")].to_numpy(dtype="float64")
    if kind == "value":
        return np.full(len(bars), float(spec["value"]))
    if kind == "indicator":
        out = indicators.compute(spec["type"], bars, spec.get("inputs"))
        key = spec.get("output") or next(iter(out))
        return np.asarray(out[key], dtype="float64")
    raise ValueError(f"bad operand {spec!r}")


def validate(cond: dict) -> None:
    op = cond.get("op")
    if op not in OPS:
        raise ValueError(f"unknown op {op!r}")
    need = ("upper", "lower") if "channel" in op else ("right",)
    for k in ("left", *need):
        if not isinstance(cond.get(k), dict):
            raise ValueError(f"condition needs {k!r}")


def signal(cond: dict, bars: pd.DataFrame) -> np.ndarray:
    """Boolean array: condition true on bar i (NaN inputs -> False)."""
    validate(cond)
    a = operand(cond["left"], bars)
    a1 = np.roll(a, 1)
    op = cond["op"]
    if "channel" in op:
        up, lo = operand(cond["upper"], bars), operand(cond["lower"], bars)
        inside = (a >= lo) & (a <= up)
        inside1 = np.roll(inside, 1)
        res = {"inside_channel": inside, "outside_channel": ~inside,
               "entering_channel": inside & ~inside1, "exiting_channel": ~inside & inside1}[op]
        bad = np.isnan(a) | np.isnan(up) | np.isnan(lo)
        if op in ("entering_channel", "exiting_channel"):
            bad |= np.roll(bad, 1)
            bad[:1] = True
    else:
        b = operand(cond["right"], bars)
        b1 = np.roll(b, 1)
        over = (a > b) & (a1 <= b1)
        under = (a < b) & (a1 >= b1)
        res = {"crossing": over | under, "crossing_up": over, "crossing_down": under,
               "greater_than": a > b, "less_than": a < b}[op]
        bad = np.isnan(a) | np.isnan(b)
        if op.startswith("crossing"):
            bad |= np.isnan(a1) | np.isnan(b1)
            bad[:1] = True
    return np.where(bad, False, res)


def evaluate(alert: dict, bars: pd.DataFrame, bar_closed_last: bool = False) -> list[dict]:
    """Fires for bars newer than alert['last_bar']; respects the trigger mode."""
    if bars.empty:
        return []
    sig = signal(alert["condition"], bars)
    left = operand(alert["condition"]["left"], bars)
    times = bars["time"].to_numpy()
    last_bar = alert.get("last_bar")
    trigger = alert.get("trigger", "once")
    n = len(bars)
    end = n if (trigger != "once_per_bar_close" or bar_closed_last) else n - 1
    fires = []
    for i in range(n):
        if i >= end or not sig[i] or (last_bar is not None and times[i] <= last_bar):
            continue
        fires.append({"bar_time": int(times[i]), "value": float(left[i])})
        if trigger == "once":
            break
    return fires


def describe(alert: dict) -> str:
    c = alert["condition"]

    def name(o):
        if o["kind"] == "price":
            return o.get("field", "close").title()
        if o["kind"] == "value":
            return f"{o['value']:g}"
        args = ",".join(str(v) for v in (o.get("inputs") or {}).values())
        return f"{o['type']}({args})" + (f".{o['output']}" if o.get("output") else "")

    if "channel" in c["op"]:
        rhs = f"[{name(c['lower'])}, {name(c['upper'])}]"
    else:
        rhs = name(c["right"])
    return f"{alert['symbol']} {name(c['left'])} {c['op'].replace('_', ' ')} {rhs}"
