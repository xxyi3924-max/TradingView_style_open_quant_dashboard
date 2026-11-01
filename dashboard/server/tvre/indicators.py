"""Reference indicator implementations (numpy), matching Pine Script v5 `ta.*` semantics.

These are the server-side source of truth: the alert engine evaluates them, the web client's
TypeScript ports are tested against them, and they are compared with TradingView's own study
output in the parity check. Values before the warm-up window are NaN.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np

Array = np.ndarray


def _f(x) -> Array:
    return np.asarray(x, dtype="float64")


def sma(src, length: int) -> Array:
    src = _f(src)
    out = np.full_like(src, np.nan)
    if length <= 0 or len(src) < length:
        return out
    c = np.cumsum(np.insert(np.nan_to_num(src), 0, 0.0))
    out[length - 1:] = (c[length:] - c[:-length]) / length
    # any NaN inside the window makes the value NaN
    nan_c = np.cumsum(np.insert(np.isnan(src).astype(int), 0, 0))
    out[length - 1:][(nan_c[length:] - nan_c[:-length]) > 0] = np.nan
    return out


def _seeded_ma(src, length: int, alpha: float) -> Array:
    """Pine ta.ema / ta.rma recursion: seeded with the SMA of the first `length` valid values."""
    src = _f(src)
    out = np.full_like(src, np.nan)
    valid = np.flatnonzero(~np.isnan(src))
    if len(valid) < length:
        return out
    start = valid[0]
    seed_end = start + length - 1
    if np.isnan(src[start:seed_end + 1]).any():
        return out
    prev = src[start:seed_end + 1].mean()
    out[seed_end] = prev
    for i in range(seed_end + 1, len(src)):
        x = src[i]
        if not np.isnan(x):
            prev = alpha * x + (1 - alpha) * prev
        out[i] = prev
    return out


def ema(src, length: int) -> Array:
    return _seeded_ma(src, length, 2.0 / (length + 1))


def rma(src, length: int) -> Array:
    return _seeded_ma(src, length, 1.0 / length)


def wma(src, length: int) -> Array:
    src = _f(src)
    out = np.full_like(src, np.nan)
    w = np.arange(1, length + 1, dtype="float64")
    for i in range(length - 1, len(src)):
        out[i] = np.dot(src[i - length + 1:i + 1], w) / w.sum()
    return out


def stdev(src, length: int) -> Array:
    """Population standard deviation (Pine ta.stdev, biased=true)."""
    src = _f(src)
    out = np.full_like(src, np.nan)
    for i in range(length - 1, len(src)):
        out[i] = np.std(src[i - length + 1:i + 1])
    return out


def rsi(src, length: int = 14) -> Array:
    src = _f(src)
    ch = np.diff(src, prepend=np.nan)
    up = rma(np.where(np.isnan(ch), np.nan, np.maximum(ch, 0.0)), length)
    dn = rma(np.where(np.isnan(ch), np.nan, -np.minimum(ch, 0.0)), length)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = 100.0 - 100.0 / (1.0 + up / dn)
    out = np.where(dn == 0, 100.0, out)
    out = np.where((up == 0) & (dn != 0), 0.0, out)
    out[np.isnan(up) | np.isnan(dn)] = np.nan
    return out


def macd(src, fast: int = 12, slow: int = 26, signal: int = 9) -> dict[str, Array]:
    line = ema(src, fast) - ema(src, slow)
    sig = ema(line, signal)
    return {"macd": line, "signal": sig, "hist": line - sig}


def bollinger(src, length: int = 20, mult: float = 2.0) -> dict[str, Array]:
    basis = sma(src, length)
    dev = mult * stdev(src, length)
    return {"basis": basis, "upper": basis + dev, "lower": basis - dev}


def true_range(high, low, close) -> Array:
    high, low, close = _f(high), _f(low), _f(close)
    prev = np.roll(close, 1)
    tr = np.maximum(high - low, np.maximum(np.abs(high - prev), np.abs(low - prev)))
    if len(tr):
        tr[0] = high[0] - low[0]
    return tr


def atr(high, low, close, length: int = 14) -> Array:
    return rma(true_range(high, low, close), length)


def _rolling(src: Array, length: int, fn) -> Array:
    out = np.full_like(src, np.nan)
    for i in range(length - 1, len(src)):
        out[i] = fn(src[i - length + 1:i + 1])
    return out


def stoch(close, high, low, k_length: int = 14, k_smooth: int = 1, d_smooth: int = 3) -> dict[str, Array]:
    close, high, low = _f(close), _f(high), _f(low)
    hh, ll = _rolling(high, k_length, np.max), _rolling(low, k_length, np.min)
    with np.errstate(divide="ignore", invalid="ignore"):
        raw = 100.0 * (close - ll) / (hh - ll)
    k = sma(raw, k_smooth)
    return {"k": k, "d": sma(k, d_smooth)}


def obv(close, volume) -> Array:
    close, volume = _f(close), _f(volume)
    sign = np.sign(np.diff(close, prepend=np.nan))
    return np.cumsum(np.nan_to_num(sign * volume))


def vwap(high, low, close, volume, session_keys) -> Array:
    """Session-anchored VWAP of hlc3; `session_keys` groups bars into sessions (e.g. local date)."""
    tp = (_f(high) + _f(low) + _f(close)) / 3.0
    v = _f(volume)
    out = np.empty_like(tp)
    keys = np.asarray(session_keys)
    pv = vv = 0.0
    for i in range(len(tp)):
        if i == 0 or keys[i] != keys[i - 1]:
            pv = vv = 0.0
        pv += tp[i] * v[i]
        vv += v[i]
        out[i] = pv / vv if vv else tp[i]
    return out


@dataclass(frozen=True)
class Spec:
    """Registry entry: how to compute an indicator from a bar frame and its default inputs."""
    name: str
    pane: str                                   # "overlay" or "separate"
    inputs: dict = field(default_factory=dict)
    fn: Callable = None
    tv_builtin: str | None = None               # anonymous TradingView study usable as parity oracle
    tv_plot: dict | None = None                 # our output key -> TradingView plot key
    cumulative: bool = False                    # level depends on the accumulation start: compare increments


def _rsi_with_ma(src, length: int, ma_length: int) -> dict[str, Array]:
    r = rsi(src, length)
    return {"rsi": r, "rsi_ma": sma(r, ma_length)}


def _src(bars, inputs):
    return bars[inputs.get("source", "close")].to_numpy()


REGISTRY: dict[str, Spec] = {
    "SMA": Spec("Moving Average Simple", "overlay", {"length": 9, "source": "close"},
                lambda b, p: {"ma": sma(_src(b, p), p["length"])}, "MASimple@tv-basicstudies-241", {"ma": "plot_0"}),
    "EMA": Spec("Moving Average Exponential", "overlay", {"length": 9, "source": "close"},
                lambda b, p: {"ma": ema(_src(b, p), p["length"])}, "MAExp@tv-basicstudies-241", {"ma": "plot_0"}),
    "WMA": Spec("Moving Average Weighted", "overlay", {"length": 9, "source": "close"},
                lambda b, p: {"ma": wma(_src(b, p), p["length"])}),
    "BB": Spec("Bollinger Bands", "overlay", {"length": 20, "mult": 2.0, "source": "close"},
               lambda b, p: bollinger(_src(b, p), p["length"], p["mult"]), "BB@tv-basicstudies-241",
               {"basis": "plot_0", "upper": "plot_1", "lower": "plot_2"}),
    "VWAP": Spec("VWAP", "overlay", {},
                 lambda b, p: {"vwap": vwap(b.high, b.low, b.close, b.volume, (b.time // 86400).to_numpy())}),
    # TradingView's RSI (STD;RSI v47) also plots an "RSI-based MA" (SMA 14 of RSI) by default
    "RSI": Spec("Relative Strength Index", "separate", {"length": 14, "source": "close", "ma_length": 14},
                lambda b, p: _rsi_with_ma(_src(b, p), p["length"], p["ma_length"]), "RSI@tv-basicstudies-241",
                {"rsi": "plot_0"}),
    "MACD": Spec("MACD", "separate", {"fast": 12, "slow": 26, "signal": 9, "source": "close"},
                 lambda b, p: macd(_src(b, p), p["fast"], p["slow"], p["signal"]), "MACD@tv-basicstudies-241",
                 {"hist": "plot_0", "macd": "plot_1", "signal": "plot_2"}),
    "ATR": Spec("Average True Range", "separate", {"length": 14},
                lambda b, p: {"atr": atr(b.high, b.low, b.close, p["length"])}, "ATR@tv-basicstudies-241",
                {"atr": "plot_0"}),
    "STOCH": Spec("Stochastic", "separate", {"k": 14, "k_smooth": 3, "d": 3},   # TradingView default 14/3/3
                  lambda b, p: stoch(b.close, b.high, b.low, p["k"], p["k_smooth"], p["d"]),
                  "Stochastic@tv-basicstudies-241", {"k": "plot_0", "d": "plot_1"}),
    "OBV": Spec("On Balance Volume", "separate", {},
                lambda b, p: {"obv": obv(b.close, b.volume)}, "OBV@tv-basicstudies-241", {"obv": "plot_0"},
                cumulative=True),
}


def compute(kind: str, bars, inputs: dict | None = None) -> dict[str, Array]:
    spec = REGISTRY[kind.upper()]
    params = {**spec.inputs, **(inputs or {})}
    return spec.fn(bars, params)
