import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture
def store(tmp_path):
    from tvre.store import Store
    return Store(tmp_path / "t.sqlite3")


@pytest.fixture
def client(store):
    from fastapi.testclient import TestClient
    from tvre.app import create_app
    return TestClient(create_app(store, start_engine=False))


def sidecar_up() -> bool:
    from tvre.providers import tradingview
    return tradingview.healthy()


live = pytest.mark.skipif(os.environ.get("TVRE_SKIP_LIVE") == "1", reason="live tests disabled")


def _work_quant():
    from tvre import config
    return config


# Tests that read the Work_Quant price panels or run its qlib engine; neither ships with the open-source copy.
local_data = pytest.mark.skipif(not _work_quant().CN_ETF_PRICES.exists(), reason="local price panels not present")
qlib_engine = pytest.mark.skipif(not (_work_quant().WORK_QUANT / "etf_rotation").exists(), reason="qlib engine not present")


@pytest.fixture(scope="session")
def live_server(tmp_path_factory):
    """Run the app under uvicorn on a free port (for streaming endpoints)."""
    import socket
    import subprocess
    import time
    import httpx
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    env = {**os.environ, "TVRE_DB": str(tmp_path_factory.mktemp("srv") / "t.sqlite3"), "TVRE_ALERT_INTERVAL": "3600"}
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "--factory", "tvre.app:create_app", "--port", str(port)],
                            cwd=Path(__file__).resolve().parents[1], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            httpx.get(base + "/api/health", timeout=1)
            break
        except httpx.TransportError:
            time.sleep(0.1)
    yield base
    proc.terminate()
    proc.wait(10)
