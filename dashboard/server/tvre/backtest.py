"""Bridge to the shared qlib backtest engine (etf_rotation.research.qlib_backtest).

Runs go through a subprocess in the shared venv (qlib keeps global state, so each run gets a clean
interpreter) and write to pools/<pool>/backtest/<namespace>/<run_id>/. Results are read back from
the engine's own files: report.csv (NAV/bench/cost), holdings.csv (positions), summary.json (metrics).
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import uuid
from pathlib import Path

import numpy as np
import pandas as pd

from . import config
from .symbols import qlib_to_tv

BUILTIN_SIGNALS = ["MOM_12_1", "MOM_6_1", "ROC20", "ROC60"]
ALLOWED_KEYS = {"pool", "scope", "signal", "signal_file", "topk", "rebalance_days", "start", "end",
                "open_cost", "close_cost", "impact_cost", "benchmark", "deal_price", "risk_degree", "account"}
RUNNER = Path(__file__).with_name("bt_runner.py")

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def pools() -> list[str]:
    root = config.ETF_POOLS_ROOT
    return sorted(p.name for p in root.iterdir() if (p / "universe.parquet").exists())


def signal_files(pool: str) -> list[str]:
    research = config.ETF_POOLS_ROOT / pool / "research"
    if not research.exists():
        return []
    return sorted(str(p.relative_to(config.WORK_QUANT)) for p in research.rglob("signal_*.parquet"))


# Saved-run roots by market. CN ETF run ids are paths under etf_rotation/pools ("etf160/backtest/<ns>/<run>",
# unchanged so saved layouts keep working); US run ids carry a prefix ("us:sector_leaders55/backtest/<run>").
def _roots() -> dict[str, Path]:
    return {"cn": config.ETF_POOLS_ROOT, "us": config.US_POOLS_ROOT}


def _run_dirs():
    for market, root in _roots().items():
        if not root.exists():
            continue
        for pattern in ("*/backtest/*/summary.json", "*/backtest/*/*/summary.json"):
            for summary in root.glob(pattern):
                yield market, summary.parent


def run_id_of(path: Path, market: str = "cn") -> str:
    rel = str(path.relative_to(_roots()[market]))
    return rel if market == "cn" else f"{market}:{rel}"


def split_run_id(run_id: str) -> tuple[str, str]:
    market, sep, rel = run_id.partition(":")
    return (market, rel) if sep and market in _roots() else ("cn", run_id)


def resolve_run(run_id: str) -> Path:
    market, rel = split_run_id(run_id)
    root = _roots()[market].resolve()
    path = (root / rel).resolve()
    if root not in path.parents or not (path / "report.csv").exists():
        raise FileNotFoundError(run_id)
    return path


def list_runs(pool: str | None = None, query: str = "", limit: int = 5000) -> list[dict]:
    out = []
    for market, d in _run_dirs():
        rid = run_id_of(d, market)
        rel = split_run_id(rid)[1]
        if pool and not rel.startswith(pool + "/"):
            continue
        if query and query.lower() not in rid.lower():
            continue
        try:
            s = json.loads((d / "summary.json").read_text())
        except (OSError, json.JSONDecodeError):
            continue
        parts = rel.split("/")                       # pool / backtest / [namespace /] run
        out.append({"id": rid, "market": market, "pool": parts[0], "folder": "/".join(parts[2:-1]), "name": d.name,
                    "mtime": d.stat().st_mtime,
                    **{k: s.get(k) for k in ("signal", "topk", "rebalance_days", "start", "end",
                                             "annual_return", "sharpe", "max_drawdown")}})
    out.sort(key=lambda r: r["mtime"], reverse=True)
    return out[:limit]


def _clean(x):
    if isinstance(x, (float, np.floating)):
        return None if not np.isfinite(x) else float(x)
    return x


def trades_from_holdings(holdings: pd.DataFrame) -> list[dict]:
    """Entry/exit events: an instrument appearing in / disappearing from consecutive holding dates."""
    if holdings.empty:
        return []
    h = holdings[holdings["amount"] > 0]
    by_date = h.groupby("date")["instrument"].apply(set).sort_index()
    price = h.set_index(["date", "instrument"])["price"]
    out, prev, prev_date = [], set(), None
    for date, held in by_date.items():
        for inst in sorted(held - prev):
            out.append({"date": date, "instrument": inst, "symbol": qlib_to_tv(inst), "side": "buy",
                        "price": _clean(price.get((date, inst)))})
        for inst in sorted(prev - held):
            out.append({"date": date, "instrument": inst, "symbol": qlib_to_tv(inst), "side": "sell",
                        "price": _clean(price.get((prev_date, inst)))})
        prev, prev_date = held, date
    return out


def load_run(run_id: str) -> dict:
    d = resolve_run(run_id)
    report = pd.read_csv(d / "report.csv", index_col=0, parse_dates=True).sort_index()
    nav = report["account"] / report["account"].iloc[0]
    bench = (1.0 + report["bench"].fillna(0.0)).cumprod()
    dd = nav / nav.cummax() - 1.0
    summary = json.loads((d / "summary.json").read_text()) if (d / "summary.json").exists() else {}
    holdings = pd.read_csv(d / "holdings.csv", encoding="utf-8-sig") if (d / "holdings.csv").exists() \
        else pd.DataFrame(columns=["date", "instrument", "amount", "price", "weight", "name"])
    names = (holdings.drop_duplicates("instrument").set_index("instrument")["name"].to_dict()
             if "name" in holdings else {})
    times = (report.index.normalize().astype("int64") // 1_000_000_000).astype(int).tolist()
    last_date = holdings["date"].max() if not holdings.empty else None
    current = holdings[holdings["date"] == last_date] if last_date else holdings.iloc[0:0]
    return {
        "id": run_id,
        "summary": {k: _clean(v) for k, v in summary.items()},
        "series": {
            "time": times,
            "nav": [_clean(x) for x in nav],
            "bench": [_clean(x) for x in bench],
            "drawdown": [_clean(x) for x in dd],
            "turnover": [_clean(x) for x in report.get("turnover", pd.Series(0.0, index=report.index))],
        },
        "trades": trades_from_holdings(holdings),
        "instruments": [{"instrument": i, "symbol": qlib_to_tv(i), "name": names.get(i, "")}
                        for i in sorted(holdings["instrument"].unique())] if not holdings.empty else [],
        "holdings_last": [{"instrument": r.instrument, "symbol": qlib_to_tv(r.instrument), "weight": _clean(r.weight),
                           "name": getattr(r, "name", "")} for r in current.itertuples()],
    }


def _validate(params: dict) -> dict:
    extra = set(params) - ALLOWED_KEYS
    if extra:
        raise ValueError(f"unsupported backtest fields: {sorted(extra)}")
    p = dict(params)
    if p.get("pool") not in pools():
        raise ValueError(f"unknown pool {p.get('pool')!r}")
    if p.get("signal_file"):
        sf = (config.WORK_QUANT / p["signal_file"]).resolve()
        if config.WORK_QUANT.resolve() not in sf.parents or not sf.exists():
            raise ValueError("signal_file must be an existing file inside Work_Quant")
        p["signal_file"] = str(sf)
        p.setdefault("signal", sf.stem)
    elif p.get("signal", "MOM_12_1").upper() not in BUILTIN_SIGNALS:
        raise ValueError(f"signal must be one of {BUILTIN_SIGNALS} or provide signal_file")
    for k in ("topk", "rebalance_days"):
        if k in p:
            p[k] = int(p[k])
    for k in ("open_cost", "close_cost", "impact_cost", "risk_degree", "account"):
        if k in p:
            p[k] = float(p[k])
    if "account" in p and not p["account"] > 0:
        raise ValueError("account (initial capital) must be positive")
    return p


def _execute(job_id: str, params: dict) -> None:
    env = {**os.environ, "PYTHONPATH": str(config.WORK_QUANT)}
    cmd = [str(config.VENV_PYTHON), str(RUNNER), json.dumps({**params, "output_namespace": config.BACKTEST_NAMESPACE})]
    t0 = time.time()
    proc = subprocess.run(cmd, cwd=config.WORK_QUANT, env=env, capture_output=True, text=True, timeout=3600)
    result = None
    for line in reversed(proc.stdout.splitlines()):
        if line.startswith("TVRE_RESULT "):
            result = json.loads(line[len("TVRE_RESULT "):])
            break
    with _jobs_lock:
        job = _jobs[job_id]
        job["elapsed"] = time.time() - t0
        job["log"] = (proc.stdout + proc.stderr)[-6000:]
        if proc.returncode == 0 and result:
            job["status"] = "done"
            job["run_id"] = run_id_of(Path(result["output_dir"]))
            job["summary"] = {k: _clean(v) for k, v in result.items()}
        else:
            job["status"] = "error"
            job["error"] = (proc.stderr or proc.stdout)[-2000:] or f"exit {proc.returncode}"


def start(params: dict, wait: bool = False) -> dict:
    p = _validate(params)
    job_id = uuid.uuid4().hex[:12]
    with _jobs_lock:
        _jobs[job_id] = {"id": job_id, "status": "running", "params": p, "started": time.time()}
    if wait:
        _execute(job_id, p)
    else:
        threading.Thread(target=_execute, args=(job_id, p), daemon=True).start()
    return job(job_id)


def job(job_id: str) -> dict | None:
    with _jobs_lock:
        j = _jobs.get(job_id)
        return dict(j) if j else None
