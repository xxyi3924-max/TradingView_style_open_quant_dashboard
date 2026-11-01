"""Write web/test/fixtures/indicators.json: Python reference outputs on a deterministic bar series.

The web test suite checks the TypeScript ports against these values (1e-9), so TS == Python, and the
live parity test checks Python == TradingView. Run from server/: python scripts/make_fixture.py
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tvre import indicators  # noqa: E402

rng = np.random.default_rng(42)
n = 400
close = 100 + rng.normal(0, 1, n).cumsum()
high = close + rng.uniform(0.1, 1.5, n)
low = close - rng.uniform(0.1, 1.5, n)
open_ = close + rng.normal(0, 0.5, n)
volume = rng.integers(1_000, 100_000, n).astype(float)
time = (pd.Timestamp("2024-01-01").value // 10**9 + np.arange(n) * 3600 * 6).astype(int)  # 6h bars: VWAP resets
frame = pd.DataFrame({"time": time, "open": open_, "high": high, "low": low, "close": close, "volume": volume})

cases = {k: {} for k in indicators.REGISTRY}
cases["SMA"] = {"length": 20}
cases["EMA"] = {"length": 21}
cases["STOCH"] = {"k": 10, "k_smooth": 1, "d": 3}   # non-default inputs on purpose

out = {"bars": frame.to_dict("records"), "cases": []}
for kind, inputs in cases.items():
    res = indicators.compute(kind, frame, inputs)
    out["cases"].append({"id": kind, "inputs": inputs,
                         "values": {k: [None if not np.isfinite(x) else float(x) for x in v] for k, v in res.items()}})

dest = Path(__file__).resolve().parents[2] / "web" / "test" / "fixtures" / "indicators.json"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(out))
print(f"wrote {dest} ({len(out['cases'])} indicators x {n} bars)")
