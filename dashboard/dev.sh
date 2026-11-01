#!/usr/bin/env bash
# Start the TradingView sidecar, the FastAPI server and the Vite dev server (all reload on change).
# Ctrl+C stops all three.
# Optional: export TV_SESSIONID / TV_SESSIONID_SIGN for full TradingView history and Pine studies.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PY="${TVRE_PYTHON:-$ROOT/../csi500_enhance/.venv/bin/python}"
[ -x "$PY" ] || PY=python3                                  # outside Work_Quant: any Python with server/requirements.txt
trap 'kill 0' EXIT INT TERM
(cd "$ROOT/sidecar" && node --watch-path=src src/server.mjs) &
(cd "$ROOT/server" && "$PY" -m uvicorn --factory tvre.app:create_app --host 127.0.0.1 --port 8000 --reload --reload-dir tvre --timeout-graceful-shutdown 2) &  # open SSE streams would block reloads
(cd "$ROOT/web" && npx vite --host 127.0.0.1) &
wait
