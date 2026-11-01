"""Strategy input optimiser (the workflow of HyperView / TradingView-Machine-Learning-GUI, on our Pine engine).

Optuna's TPE sampler proposes input values; each trial runs the strategy with them (in parallel worker
processes, batch ask/tell) and scores the closed trades. Overfitting checks:

* in-sample / out-of-sample: the search only sees the first (100 - oos_pct)% of bars; the best trials are then
  replayed over all bars and scored on the trades entered after the split;
* anchored walk-forward: k folds, each optimises on every bar before its test window and scores the winner on
  the window; the stitched out-of-sample result is the honest one;
* minimum trades: a trial with too few closed trades is rejected;
* several symbols: a trial's score is the mean over the symbols (trades are summed for the minimum).

`export_source` writes the chosen values back into the script as new input defaults.
"""
from __future__ import annotations

import math
import multiprocessing as mp
import os
import re
import threading
import time
import uuid
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field

import numpy as np

from .broker import Trade
from .parser import parse
from .report import tv_max_drawdown, tv_ratios
from .runtime import InputSpec, Runtime

# name -> (label, maximise?)
OBJECTIVES = {
    "net_profit": ("Net profit", True),
    "profit_factor": ("Profit factor", True),
    "sharpe": ("Sharpe ratio", True),
    "sortino": ("Sortino ratio", True),
    "win_rate": ("Percent profitable", True),
    "return_dd": ("Return / max drawdown", True),
    "max_drawdown": ("Max drawdown %", False),
}
SOURCES = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4"]
PF_CAP = 100.0


class OptimizeError(ValueError):
    pass


# ------------------------------------------------------------------------------------- metrics
def window_metrics(trades: list[Trade], initial: float, rfr: float, t0: int | None = None, t1: int | None = None) -> dict:
    """Closed-trade metrics for trades entered in [t0, t1); equity starts at initial + P&L of earlier trades."""
    sel = [t for t in trades if (t0 is None or t.entry_time >= t0) and (t1 is None or t.entry_time < t1)]
    start = initial + sum(t.profit for t in trades if t0 is not None and t.entry_time < t0)
    gp = sum(t.profit for t in sel if t.profit > 0)
    gl = -sum(t.profit for t in sel if t.profit < 0)
    net = gp - gl
    dd = tv_max_drawdown(sel, start) if sel else 0.0
    sharpe, sortino = tv_ratios(sel, start, rfr) if len(sel) > 1 else (None, None)
    peak = max([start] + list(start + np.cumsum([t.profit for t in sel])))
    dd_pct = dd / peak if peak > 0 else 1.0                         # TradingView: % of peak closed-trade equity
    ret = net / start if start > 0 else 0.0
    return {"trades": len(sel), "net_profit": net, "return_pct": ret, "gross_profit": gp, "gross_loss": gl,
            "profit_factor": min(gp / gl, PF_CAP) if gl else (PF_CAP if gp else 0.0),
            "win_rate": sum(t.profit > 0 for t in sel) / len(sel) if sel else 0.0,
            "max_drawdown": dd_pct, "return_dd": ret / max(dd_pct, 0.01),
            "sharpe": sharpe if sharpe is not None else 0.0, "sortino": sortino if sortino is not None else 0.0}


def combine(ms: list[dict]) -> dict:
    """Several symbols: mean of every metric, trades summed."""
    out = {k: sum(m[k] for m in ms) / len(ms) for k in ms[0]}
    out["trades"] = sum(m["trades"] for m in ms)
    return out


# ------------------------------------------------------------------------------------- search space
def suggest_space(inputs: list[InputSpec]) -> list[dict]:
    """A default range per input (the UI lets the user edit it): ints/floats from half to double the default,
    clipped to minval/maxval; bools, sources and option lists as choices. Free-text strings are left out."""
    out = []
    for s in inputs:
        d = s.default
        row = {"title": s.title, "type": s.type, "default": d, "enabled": s.type in ("int", "float")}
        if s.options:
            row.update(kind="choice", choices=list(s.options))
        elif s.type == "bool":
            row.update(kind="choice", choices=[True, False])
        elif s.type == "source":
            row.update(kind="choice", choices=SOURCES)
        elif s.type in ("int", "float") and isinstance(d, (int, float)) and not isinstance(d, bool):
            if s.minval is not None and s.maxval is not None and s.maxval - s.minval <= 20:
                lo, hi = float(s.minval), float(s.maxval)
            elif d == 0:
                lo, hi = -10.0, 10.0
            else:
                lo, hi = sorted((d / 2, d * 2))
            if s.minval is not None:
                lo = max(lo, float(s.minval))
            if s.maxval is not None:
                hi = min(hi, float(s.maxval))
            if s.type == "int":
                lo, hi, step = math.floor(lo), math.ceil(hi), max(1, int(s.step or 1))
                lo = max(lo, 1) if d > 0 and s.minval is None else lo
            else:
                step = float(s.step) if s.step else _nice_step((hi - lo) / 20)
            row.update(kind="range", low=lo, high=hi, step=step)
        else:
            continue
        out.append(row)
    return out


def _nice_step(x: float) -> float:
    if x <= 0:
        return 0.01
    mag = 10 ** math.floor(math.log10(x))
    return next(m * mag for m in (1, 2, 5, 10) if m * mag >= x)


def _validate_space(space: list[dict]) -> list[dict]:
    rows = [r for r in space if r.get("enabled")]
    if not rows:
        raise OptimizeError("choose at least one input to optimise")
    for r in rows:
        if r.get("kind") == "range":
            if not (float(r["low"]) <= float(r["high"])) or float(r.get("step") or 0) <= 0:
                raise OptimizeError(f"{r['title']}: need low <= high and a positive step")
        elif r.get("kind") == "choice":
            if not r.get("choices"):
                raise OptimizeError(f"{r['title']}: no choices")
        else:
            raise OptimizeError(f"{r['title']}: unknown kind")
    return rows


def _suggest(trial, rows: list[dict]) -> dict:
    out = {}
    for r in rows:
        if r["kind"] == "choice":
            out[r["title"]] = r["choices"][trial.suggest_categorical(r["title"], list(range(len(r["choices"]))))]
        elif r["type"] == "int":
            out[r["title"]] = trial.suggest_int(r["title"], int(r["low"]), int(r["high"]), step=int(r["step"]))
        else:
            lo, hi, st = float(r["low"]), float(r["high"]), float(r["step"])
            hi = lo + math.floor((hi - lo) / st + 1e-9) * st
            out[r["title"]] = round(trial.suggest_float(r["title"], lo, hi, step=st), 10)
    return out


# ------------------------------------------------------------------------------------- worker processes
_W: dict = {}


def _init_worker(src: str, datasets: list[dict], props: dict, rfr: float, fixed: dict):
    _W.update(script=parse(src), datasets=datasets, props=props, rfr=rfr, fixed=fixed)


def _run(inputs: dict, ds: dict, end: int | None):
    bars = ds["bars"] if end is None else ds["bars"][:end]
    return Runtime(_W["script"], bars, inputs={**_W["fixed"], **inputs}, props=_W["props"], mintick=ds["mintick"], qty_step=ds["qty_step"],
                   tz=ds["tz"], symbol=ds["symbol"]).run()


def _evaluate(task: tuple) -> list[dict]:
    """task = (inputs, [(dataset index, end bar or None, t0, t1)]) -> metrics per window."""
    inputs, windows = task
    out, cache = [], {}
    for i, end, t0, t1 in windows:
        key = (i, end)
        if key not in cache:
            res = _run(inputs, _W["datasets"][i], end)
            cache[key] = (res.trades, res.props.initial_capital)
        trades, init = cache[key]
        out.append(window_metrics(trades, init, _W["rfr"], t0, t1))
    return out


# ------------------------------------------------------------------------------------- jobs
@dataclass
class Job:
    id: str
    total: int
    status: str = "running"            # running | done | cancelled | error
    phase: str = "search"
    done: int = 0
    error: str | None = None
    started: float = field(default_factory=time.time)
    finished: float | None = None
    objective: str = "net_profit"
    best: dict | None = None
    leaderboard: list = field(default_factory=list)
    baseline: dict | None = None
    walk_forward: dict | None = None
    split_time: list | None = None
    cancel: bool = False

    def public(self) -> dict:
        d = {k: v for k, v in self.__dict__.items() if k != "cancel"}
        d["elapsed"] = (self.finished or time.time()) - self.started
        return d


JOBS: dict[str, Job] = {}
_LOCK = threading.Lock()


def start(src: str, datasets: list[dict], space: list[dict], *, objective: str = "net_profit", trials: int = 100,
          min_trades: int = 10, oos_pct: float = 30.0, folds: int = 0, props: dict | None = None, seed: int = 42,
          workers: int | None = None, fixed: dict | None = None) -> Job:
    """Start an optimisation in a background thread; `datasets` = [{symbol, bars, mintick, qty_step, tz}];
    `fixed` = input values (by title) held constant (the chart's current settings for inputs not searched)."""
    if objective not in OBJECTIVES:
        raise OptimizeError(f"unknown objective {objective}")
    rows = _validate_space(space)
    trials = int(min(max(trials, 5), 2000))
    folds = int(min(max(folds, 0), 10))
    oos_pct = float(min(max(oos_pct, 0.0), 60.0))
    if not datasets or any(len(d["bars"]) < 50 for d in datasets):
        raise OptimizeError("need at least 50 bars per symbol")
    total = trials * (folds or 1)
    job = Job(uuid.uuid4().hex[:12], total, objective=objective)
    with _LOCK:
        for k in [k for k, j in JOBS.items() if j.status != "running"][:-20]:
            JOBS.pop(k, None)
        JOBS[job.id] = job
    args = (job, src, datasets, rows, objective, trials, min_trades, oos_pct, folds, props or {}, seed, workers, fixed or {})
    threading.Thread(target=_main, args=args, daemon=True, name=f"optimize-{job.id}").start()
    return job


def cancel(job_id: str) -> bool:
    j = JOBS.get(job_id)
    if j and j.status == "running":
        j.cancel = True
        return True
    return False


def _main(job: Job, src, datasets, rows, objective, trials, min_trades, oos_pct, folds, props, seed, workers, fixed):
    from .broker import Props
    rfr = Props.from_dict(props).risk_free_rate
    n = workers or max(1, min(8, (os.cpu_count() or 2) - 1))
    try:
        with ProcessPoolExecutor(n, mp_context=mp.get_context("spawn"), initializer=_init_worker,
                                 initargs=(src, datasets, props, rfr, fixed)) as pool:
            if folds:
                _walk_forward(job, pool, n, datasets, rows, objective, trials, min_trades, folds, seed)
            else:
                _in_out_sample(job, pool, n, datasets, rows, objective, trials, min_trades, oos_pct, seed)
        job.status = "cancelled" if job.cancel else "done"
    except Exception as e:                           # noqa: BLE001 - reported to the client
        job.status, job.error = "error", f"{type(e).__name__}: {e}"
    job.finished = time.time()


def _score(m: dict, objective: str, min_trades: int) -> float | None:
    if m["trades"] < min_trades:
        return None
    return float(m[objective])


def _search(job: Job, pool, n: int, rows, objective, trials, min_trades, windows, seed) -> list[dict]:
    """TPE search over `windows` (one per symbol); returns every accepted trial, best first."""
    import optuna
    from optuna.trial import TrialState
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    maximise = OBJECTIVES[objective][1]
    study = optuna.create_study(direction="maximize" if maximise else "minimize",
                                sampler=optuna.samplers.TPESampler(seed=seed, n_startup_trials=min(20, max(5, trials // 5)), multivariate=True))
    seen: dict[tuple, dict] = {}
    accepted: list[dict] = []
    left = trials
    while left > 0 and not job.cancel:
        batch = [study.ask() for _ in range(min(n, left))]
        params = [_suggest(t, rows) for t in batch]
        fresh = {}
        for p in params:
            k = tuple(sorted((a, repr(b)) for a, b in p.items()))
            if k not in seen and k not in fresh:
                fresh[k] = p
        results = dict(zip(fresh, pool.map(_evaluate, [(p, windows) for p in fresh.values()])))
        for t, p in zip(batch, params):
            k = tuple(sorted((a, repr(b)) for a, b in p.items()))
            if k in results:
                seen[k] = combine(results[k])
            m = seen[k]
            v = _score(m, objective, min_trades)
            if v is None or not math.isfinite(v):
                study.tell(t, state=TrialState.PRUNED)
            else:
                study.tell(t, v)
                if k in results:
                    accepted.append({"params": p, "is": m, "value": v})
            job.done += 1
        left -= len(batch)
        accepted.sort(key=lambda r: r["value"], reverse=maximise)
        if accepted:
            job.best = accepted[0]
    return accepted


def _in_out_sample(job: Job, pool, n, datasets, rows, objective, trials, min_trades, oos_pct, seed):
    splits = [int(len(d["bars"]) * (1 - oos_pct / 100)) for d in datasets]
    split_t = [int(d["bars"][s]["time"]) if s < len(d["bars"]) else None for d, s in zip(datasets, splits)]
    job.split_time = split_t
    is_windows = [(i, s if oos_pct else None, None, None) for i, s in enumerate(splits)]
    oos = [(i, None, t, None) for i, t in enumerate(split_t)] if oos_pct else None

    base = pool.submit(_evaluate, ({}, is_windows + (oos or []))).result()      # current settings
    k = len(datasets)
    job.baseline = {"params": {}, "is": combine(base[:k]), "oos": combine(base[k:]) if oos else None}

    accepted = _search(job, pool, n, rows, objective, trials, min_trades, is_windows, seed)
    top = accepted[:20]
    if oos and top and not job.cancel:
        job.phase = "out-of-sample"
        res = list(pool.map(_evaluate, [(r["params"], oos) for r in top]))
        for r, m in zip(top, res):
            r["oos"] = combine(m)
    job.leaderboard = top


def _walk_forward(job: Job, pool, n, datasets, rows, objective, trials, min_trades, folds, seed):
    """Anchored walk-forward: the first half of the bars is the initial training set; the second half is cut
    into `folds` test windows. Fold i trains on everything before window i and is scored on window i."""
    lens = [len(d["bars"]) for d in datasets]
    edges = [[int(L * (0.5 + 0.5 * f / folds)) for f in range(folds + 1)] for L in lens]
    t = lambda i, e: int(datasets[i]["bars"][e]["time"]) if e < lens[i] else None
    out, stitched = [], []
    for f in range(folds):
        if job.cancel:
            break
        job.phase = f"fold {f + 1}/{folds}"
        train = [(i, edges[i][f], None, None) for i in range(len(datasets))]
        test = [(i, None, t(i, edges[i][f]), t(i, edges[i][f + 1])) for i in range(len(datasets))]
        accepted = _search(job, pool, n, rows, objective, trials, min_trades, train, seed + f)
        if not accepted:
            out.append({"fold": f + 1, "train_end": t(0, edges[0][f]), "test_end": t(0, edges[0][f + 1]), "params": None, "is": None, "oos": None})
            continue
        best = accepted[0]
        m = pool.submit(_evaluate, (best["params"], test)).result()
        oos = combine(m)
        stitched.append(oos)
        out.append({"fold": f + 1, "train_end": t(0, edges[0][f]), "test_end": t(0, edges[0][f + 1]),
                    "params": best["params"], "is": best["is"], "oos": oos})
        job.leaderboard = [dict(r, fold=f + 1) for r in accepted[:5]] + job.leaderboard
    # stitched out-of-sample: fold returns compounded (each fold's run starts from its own equity, so raw P&L
    # does not add up); efficiency = out-of-sample return per bar / in-sample return per bar (Pardo's WFE)
    comp = math.prod(1 + m["return_pct"] for m in stitched) - 1 if stitched else None
    tot = {"trades": sum(m["trades"] for m in stitched), "return_pct": comp, "folds": len(stitched),
           "profitable_folds": sum(m["net_profit"] > 0 for m in stitched), "efficiency": None}
    pairs = [(r["is"]["return_pct"] / max(edges[0][r["fold"] - 1], 1), r["oos"]["return_pct"] / max(edges[0][r["fold"]] - edges[0][r["fold"] - 1], 1))
             for r in out if r["is"] and r["oos"]]
    if pairs:
        is_rate = sum(p[0] for p in pairs) / len(pairs)
        tot["efficiency"] = (sum(p[1] for p in pairs) / len(pairs)) / is_rate if is_rate > 0 else None
    job.walk_forward = {"folds": out, "total": tot}


# ------------------------------------------------------------------------------------- export
_INPUT_CALL = re.compile(r"\binput(?:\.(?:int|float|bool|string|source|color|timeframe|symbol|session|price|time|text_area))?\s*\(")


def _pine_literal(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return repr(round(v, 10)) if not v.is_integer() else f"{v:.1f}"
    if isinstance(v, str) and v in SOURCES:
        return v
    return '"' + str(v).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _code_mask(src: str) -> list[bool]:
    """True where the character is code (not inside a string literal or a // comment)."""
    mask, i, quote = [True] * len(src), 0, None
    while i < len(src):
        c = src[i]
        if quote:
            mask[i] = False
            if c == "\\":
                if i + 1 < len(src):
                    mask[i + 1] = False
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "\"'":
            quote, mask[i] = c, False
        elif src.startswith("//", i):
            j = src.find("\n", i)
            j = len(src) if j < 0 else j
            for k in range(i, j):
                mask[k] = False
            i = j
            continue
        i += 1
    return mask


def _args(src: str, open_paren: int, mask: list[bool]) -> tuple[list[tuple[int, int]], int]:
    """Top-level argument spans of the call whose '(' is at open_paren; returns (spans, index of ')')."""
    depth, start, spans, i = 0, open_paren + 1, [], open_paren
    while i < len(src):
        c = src[i]
        if mask[i]:
            if c in "([":
                depth += 1
            elif c in ")]":
                depth -= 1
                if depth == 0:
                    spans.append((start, i))
                    return spans, i
            elif c == "," and depth == 1:
                spans.append((start, i))
                start = i + 1
        i += 1
    raise OptimizeError("unbalanced parentheses in an input() call")


def export_source(src: str, values: dict, inputs: list[InputSpec]) -> str:
    """Rewrite the script so the given inputs (by title) default to the given values. Input calls are matched
    to the runtime's inputs in source order; the result is re-run to check every default landed."""
    mask = _code_mask(src)
    calls = [m for m in _INPUT_CALL.finditer(src) if mask[m.start()]]
    if len(calls) != len(inputs):
        raise OptimizeError(f"found {len(calls)} input calls in the source but the script declares {len(inputs)} inputs")
    by_title = {s.title: s for s in inputs}
    edits = []
    for m, spec in zip(calls, sorted(inputs, key=lambda s: s.index)):
        if spec.title not in values or spec.title not in by_title:
            continue
        spans, _ = _args(src, m.end() - 1, mask)
        target = None
        for a, b in spans:
            text = src[a:b]
            if re.match(r"\s*defval\s*=", text):
                eq = src.index("=", a)
                target = (eq + 1, b)
                break
        if target is None:
            a, b = spans[0]
            if re.match(r"\s*\w+\s*=(?!=)", src[a:b]):
                raise OptimizeError(f"cannot find the default of input '{spec.title}'")
            target = (a, b)
        lead = len(src[target[0]:target[1]]) - len(src[target[0]:target[1]].lstrip())
        trail = len(src[target[0]:target[1]]) - len(src[target[0]:target[1]].rstrip())
        edits.append((target[0] + lead, target[1] - trail, _pine_literal(values[spec.title])))
    out = src
    for a, b, text in sorted(edits, reverse=True):
        out = out[:a] + text + out[b:]
    _check_export(out, values)
    return out


def _check_export(src: str, values: dict) -> None:
    bars = [{"time": 1_600_000_000 + i * 86400, "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 1.0} for i in range(3)]
    res = Runtime(src, bars).run()
    got = {s.title: s.default for s in res.inputs}
    for k, v in values.items():
        g = got.get(k)
        if isinstance(v, float) or isinstance(g, float):
            ok = g is not None and abs(float(g) - float(v)) < 1e-9
        else:
            ok = g == v
        if not ok:
            raise OptimizeError(f"export check failed: input '{k}' defaults to {g!r}, expected {v!r}")
