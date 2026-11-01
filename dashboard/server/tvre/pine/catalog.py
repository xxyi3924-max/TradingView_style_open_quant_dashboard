"""Strategy scripts: TradingView's built-in strategy templates and the user's own Pine strategies.

Built-ins are the templates TradingView's Pine Editor offers every user ("Create new -> Built-in...",
scriptAccess `open_no_auth`). They are fetched on demand from pine-facade and cached in the gitignored
`server/cache/pine/`; no TradingView code ships in this repository.
"""
from __future__ import annotations

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

import httpx

from .. import config
from .parser import PineSyntaxError, parse

FACADE = "https://pine-facade.tradingview.com/pine-facade"
CACHE = config.APP_ROOT / "server" / "cache" / "pine"
LIST_TTL = 7 * 86400


class CatalogError(RuntimeError):
    pass


def _safe(script_id: str) -> str:
    return re.sub(r"[^\w.-]", "_", script_id)


def builtins() -> list[dict]:
    """TradingView's built-in strategies: [{id, name, version, supported}] (cached a week)."""
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / "list.json"
    if not f.exists() or time.time() - f.stat().st_mtime > LIST_TTL:
        try:
            items = httpx.get(f"{FACADE}/list", params={"filter": "standard"}, timeout=20).json()
        except (httpx.HTTPError, ValueError) as e:
            if not f.exists():
                raise CatalogError(f"TradingView script list unavailable: {e}") from e
            items = None
        if items is not None:
            rows = [{"id": x["scriptIdPart"], "name": x["scriptName"], "version": x.get("version")}
                    for x in items if (x.get("extra") or {}).get("kind") == "strategy"]
            f.write_text(json.dumps(rows))
    rows = json.loads(f.read_text())
    missing = [r["id"] for r in rows if not (CACHE / f"{_safe(r['id'])}.pine").exists()]
    if missing:                                   # first listing: fetch the sources once so each row says if we run it
        with ThreadPoolExecutor(8) as ex:
            list(ex.map(_try_source, missing))
    for r in rows:
        src = CACHE / f"{_safe(r['id'])}.pine"
        r["supported"] = _supported(src.read_text()) if src.exists() else None
    return sorted(rows, key=lambda r: r["name"].lower())


def _try_source(script_id: str) -> None:
    try:
        builtin_source(script_id)
    except CatalogError:
        pass


def builtin_source(script_id: str) -> str:
    if not script_id.startswith("STD;"):
        raise CatalogError("not a built-in script id")
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{_safe(script_id)}.pine"
    if not f.exists():
        try:
            r = httpx.get(f"{FACADE}/get/{quote(script_id, safe='')}/last", timeout=20)
            body = r.json()
        except (httpx.HTTPError, ValueError) as e:
            raise CatalogError(f"TradingView script {script_id} unavailable: {e}") from e
        src = body.get("source")
        if not src:
            raise CatalogError(f"TradingView did not return the source of {script_id}")
        f.write_text(src)
    return f.read_text()


def _supported(src: str) -> bool:
    try:
        parse(src)
        return "strategy(" in src
    except PineSyntaxError:
        return False


def validate_user_script(src: str) -> str:
    """Parse a pasted script; returns its strategy title or raises CatalogError with the reason."""
    try:
        script = parse(src)
    except PineSyntaxError as e:
        raise CatalogError(str(e)) from e
    m = re.search(r"strategy\s*\(\s*(?:title\s*=\s*)?[\"']([^\"']+)", src)
    if not m:
        raise CatalogError("not a strategy: the script needs a strategy(...) declaration")
    del script
    return m.group(1)


def cached_paths() -> list[Path]:
    return sorted(CACHE.glob("*.pine")) if CACHE.exists() else []
