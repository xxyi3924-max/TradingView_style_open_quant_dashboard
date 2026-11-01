"""Paths and settings. Everything is overridable by environment variables for tests."""
from __future__ import annotations

import os
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2]          # .../Trading View RE
WORK_QUANT = Path(os.environ.get("TVRE_WORK_QUANT", APP_ROOT.parent))
VENV_PYTHON = Path(os.environ.get("TVRE_PYTHON", WORK_QUANT / "csi500_enhance" / ".venv" / "bin" / "python"))

CN_ETF_PRICES = WORK_QUANT / "etf_rotation" / "data" / "raw" / "etf_prices_clean.parquet"
CN_ETF_MASTER = WORK_QUANT / "etf_rotation" / "data" / "raw" / "etf_master.parquet"
US_PRICES = WORK_QUANT / "us_stock_rotation" / "data" / "prices.parquet"
ETF_POOLS_ROOT = WORK_QUANT / "etf_rotation" / "pools"
US_POOLS_ROOT = WORK_QUANT / "us_stock_rotation" / "pools"
# QuantiFi 2026 replay engine: Data/ (order books, trades), strategy files, tools/backtest.py and its runs/.
# Default: an engine/ folder next to the app (the open-source layout), else the hackathon repo.
_ENGINE = APP_ROOT.parent / "engine"
QUANTIFI_ROOT = Path(os.environ.get("TVRE_QUANTIFI_ROOT", _ENGINE if (_ENGINE / "tools" / "backtest.py").exists()
                                    else APP_ROOT.parents[1] / "Hackathon" / "UTEFA"))

DB_PATH = Path(os.environ.get("TVRE_DB", APP_ROOT / "server" / "tvre.sqlite3"))
SIDECAR_URL = os.environ.get("TVRE_SIDECAR_URL", "http://127.0.0.1:8787")
BACKTEST_NAMESPACE = os.environ.get("TVRE_BT_NAMESPACE", "tvre")
WEB_DIST = APP_ROOT / "web" / "dist"
