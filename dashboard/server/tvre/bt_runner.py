"""Subprocess entry: run one qlib backtest from a JSON config and print the summary.

Invoked by tvre.backtest with cwd=Work_Quant and PYTHONPATH=Work_Quant, inside the shared venv.
"""
import json
import sys

from etf_rotation.research.qlib_backtest import BacktestConfig, ensure_qlib, run_backtest


def main() -> None:
    params = json.loads(sys.argv[1])
    if not params.get("provider_uri"):
        ensure_qlib()   # the engine's own CLI does this before run_backtest for the default ETF store
    summary = run_backtest(BacktestConfig(**params))
    print("TVRE_RESULT " + json.dumps(summary, default=str), flush=True)


if __name__ == "__main__":
    main()
