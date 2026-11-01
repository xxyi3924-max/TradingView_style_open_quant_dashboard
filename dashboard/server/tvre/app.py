"""FastAPI server: market data, indicators, watchlists, layouts, alerts, and the qlib backtest bridge."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path

import httpx
import numpy as np
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import alerts, backtest, bars, config, data, details, indicators, quantifi, report
from .pine import catalog as pine_catalog
from .pine import optimize as pine_optimize
from .pine import report as pine_report
from .pine.parser import PineSyntaxError
from .pine.runtime import PineRuntimeError, Runtime
from .providers import local, tradingview
from .providers.tradingview import SidecarError
from .providers.tradingview import restamp as tv_restamp
from .store import Store
from .symbols import to_local

log = logging.getLogger("tvre")
ALERT_INTERVAL = float(os.environ.get("TVRE_ALERT_INTERVAL", "20"))
DEFAULT_ALERT_TTL = 30 * 86400   # TradingView's alert dialog defaults expiration to about one month ahead


class Hub:
    """Fan-out of server events (alert fires) to SSE subscribers."""

    def __init__(self):
        self.queues: set[asyncio.Queue] = set()

    def publish(self, event: dict) -> None:
        for q in list(self.queues):
            q.put_nowait(event)


def _series(arr) -> list:
    return [None if (x is None or not np.isfinite(x)) else float(x) for x in np.asarray(arr, dtype="float64")]


def run_alert_checks(store: Store, hub: Hub | None = None) -> list[dict]:
    """One pass of the alert engine over all active alerts. Returns the fired log rows."""
    fired = []
    groups: dict[tuple[str, str], list[dict]] = {}
    now = time.time()
    for a in store.alerts(active_only=True):
        if a.get("expires") and now > a["expires"]:
            store.set_alert(a["id"], active=False)   # expired: stop without firing
            continue
        groups.setdefault((a["symbol"], a["timeframe"]), []).append(a)
    for (symbol, tf), group in groups.items():
        try:
            frame, _ = data.get_bars(symbol, tf, count=400)
        except data.NoData as e:
            log.warning("alert data unavailable for %s %s: %s", symbol, tf, e)
            continue
        for a in group:
            for f in alerts.evaluate(a, frame):
                msg = a["message"] or alerts.describe(a)
                row = store.log_fire(a["id"], f["bar_time"], f["value"], msg)
                updates = {"last_bar": f["bar_time"], "last_fired": row["fired_at"]}
                if a["trigger"] == "once":
                    updates["active"] = False
                a = store.set_alert(a["id"], **updates)
                fired.append(row)
                if hub:
                    hub.publish({"type": "alert", "log": row, "alert": a})
    return fired


def create_app(store: Store | None = None, start_engine: bool = True) -> FastAPI:
    store = store or Store(config.DB_PATH)
    hub = Hub()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = None
        if start_engine:
            async def loop():
                while True:
                    try:
                        await asyncio.to_thread(run_alert_checks, store, hub)
                    except Exception:  # keep the engine alive
                        log.exception("alert engine pass failed")
                    await asyncio.sleep(ALERT_INTERVAL)
            task = asyncio.create_task(loop())
        yield
        if task:
            task.cancel()

    app = FastAPI(title="TradingView RE", lifespan=lifespan)
    app.state.store, app.state.hub = store, hub

    # ---------------------------------------------------------------- market data
    @app.get("/api/health")
    def health():
        return {"ok": True, "sidecar": tradingview.healthy()}

    @app.get("/api/bars")
    def get_bars(symbol: str, timeframe: str = "D", count: int = Query(500, le=40000), to: int | None = None,
                 source: str = "auto", adjustment: str | None = Query(None, pattern="^(splits|dividends)$")):
        try:
            frame, used = data.get_bars(symbol, timeframe, count, to, source, adjustment)
        except data.NoData as e:
            raise HTTPException(404, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {"symbol": symbol, "timeframe": bars.normalize_timeframe(timeframe), "source": used,
                "bars": bars.to_records(frame)}

    @app.get("/api/search")
    def search(q: str, type: str | None = None):
        return {"results": data.search(q, type)}

    @app.get("/api/symbol")
    def symbol(symbol: str):
        if quantifi.is_symbol(symbol):
            return quantifi.symbol_info(symbol)
        try:
            info = tradingview.symbol_info(symbol)
            return {k: info.get(k) for k in ("pro_name", "full_name", "description", "exchange", "currency_code",
                                             "timezone", "session", "pricescale", "minmov", "type")} | {"source": "tradingview"}
        except SidecarError:
            return {"pro_name": symbol, "description": symbol, "pricescale": 1000, "minmov": 1, "source": "local"}

    @app.get("/api/details")
    def symbol_details(symbol: str):
        """Right-panel details card: quote snapshot (if the sidecar is up) + stats from daily bars."""
        try:
            daily, used = data.get_bars(symbol, "D", 400)
        except data.NoData:
            daily, used = bars.empty(), "none"
        quote = None
        try:
            if not quantifi.is_symbol(symbol):
                quote = tradingview.quotes([symbol]).get(symbol)
        except SidecarError:
            pass
        if quote is None and daily.empty:
            raise HTTPException(404, f"no data for {symbol}")
        name = None
        if used == "local":
            ref = to_local(symbol)
            name = local.cn_names().get(ref.code) if ref and ref.market == "cn_etf" else None
        return details.build(symbol, quote, daily, used, name)

    @app.get("/api/quotes")
    def quotes(symbols: str):
        try:
            return tradingview.quotes([s for s in symbols.split(",") if s])
        except SidecarError as e:
            raise HTTPException(503, str(e))

    async def _proxy(path: str, params: dict, transform=None):
        """Relay a sidecar SSE stream; `transform` rewrites each event's JSON payload."""
        async def gen():
            try:
                async with httpx.AsyncClient(base_url=config.SIDECAR_URL, timeout=None) as c:
                    async with c.stream("GET", path, params=params) as r:
                        async for line in r.aiter_lines():
                            if transform and line.startswith("data: "):
                                line = "data: " + json.dumps(transform(json.loads(line[6:])))
                            yield (line + "\n").encode()
            except httpx.TransportError as e:
                yield f"event: error\ndata: {json.dumps({'code': 'SIDECAR_DOWN', 'message': str(e)})}\n\n".encode()
        return StreamingResponse(gen(), media_type="text/event-stream")

    @app.get("/api/stream/bars")
    async def stream_bars(symbol: str, timeframe: str = "D"):
        tf = bars.normalize_timeframe(timeframe)

        def restamp(payload):
            if isinstance(payload, list) and tf in bars.DAILY_PLUS and payload:
                stamps = tv_restamp(symbol, tf, [c["time"] for c in payload])
                payload = [dict(c, time=int(t)) for c, t in zip(payload, stamps)]
            return payload
        return await _proxy("/stream/candles", {"symbol": symbol, "timeframe": tf}, restamp)

    @app.get("/api/stream/quotes")
    async def stream_quotes(symbols: str):
        return await _proxy("/stream/quotes", {"symbols": symbols})

    # ---------------------------------------------------------------- indicators
    @app.get("/api/indicators")
    def indicator_list():
        return {k: {"name": s.name, "pane": s.pane, "inputs": s.inputs, "tv_builtin": s.tv_builtin}
                for k, s in indicators.REGISTRY.items()}

    @app.get("/api/indicator")
    def indicator(symbol: str, type: str, timeframe: str = "D", inputs: str = "{}", count: int = 500,
                  source: str = "auto"):
        if type.upper() not in indicators.REGISTRY:
            raise HTTPException(404, f"unknown indicator {type}")
        try:
            frame, used = data.get_bars(symbol, timeframe, count, None, source)
        except data.NoData as e:
            raise HTTPException(404, str(e))
        out = indicators.compute(type, frame, json.loads(inputs))
        return {"time": frame["time"].astype(int).tolist(), "source": used,
                "values": {k: _series(v) for k, v in out.items()}}

    @app.get("/api/parity")
    def parity(symbol: str, type: str, timeframe: str = "D", count: int = 300, warmup: int = 150):
        """Our indicator vs TradingView's own built-in study on the identical candles."""
        spec = indicators.REGISTRY.get(type.upper())
        if not spec or not spec.tv_builtin:
            raise HTTPException(400, f"{type} has no anonymous TradingView oracle")
        try:
            tv = tradingview.indicator(symbol, timeframe, spec.tv_builtin, count)
        except SidecarError as e:
            raise HTTPException(e.status if e.status != 200 else 502, f"{e.code}: {e}")
        import pandas as pd
        frame = pd.DataFrame(tv["candles"], columns=bars.COLUMNS)
        ours = indicators.compute(type, frame)
        tv_rows = {r["$time"]: r for r in tv["values"]}
        report = {}
        for key, plot in spec.tv_plot.items():
            ref = np.array([tv_rows.get(t, {}).get(plot) if tv_rows.get(t, {}).get(plot) is not None else np.nan
                            for t in frame["time"]], dtype="float64")
            mine = np.asarray(ours[key], dtype="float64")
            if spec.cumulative:   # TradingView accumulates from earlier history: compare bar-to-bar increments
                ref, mine = np.diff(ref, prepend=np.nan), np.diff(mine, prepend=np.nan)
            ok = np.isfinite(ref) & np.isfinite(mine)
            ok[:warmup] = False
            err = np.abs(mine[ok] - ref[ok]) / np.maximum(np.abs(ref[ok]), 1e-9 if not spec.cumulative else 1.0)
            report[key] = {"n": int(ok.sum()), "max_rel_err": float(err.max()) if err.size else None,
                           "compared": "increments" if spec.cumulative else "levels",
                           "last_ours": _series([ours[key][-1]])[0],
                           "last_tv": tv["values"][-1].get(plot) if tv["values"] else None}
        return {"symbol": symbol, "type": type.upper(), "oracle": spec.tv_builtin, "plots": report}

    # ---------------------------------------------------------------- watchlists
    @app.get("/api/watchlists")
    def watchlists():
        return store.watchlists()

    @app.post("/api/watchlists")
    def create_watchlist(payload: dict = Body(...)):
        try:
            return store.create_watchlist(payload["name"], payload.get("symbols", []))
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.patch("/api/watchlists/{wid}")
    def update_watchlist(wid: int, payload: dict = Body(...)):
        wl = store.update_watchlist(wid, payload.get("name"), payload.get("symbols"))
        if not wl:
            raise HTTPException(404, "watchlist not found")
        return wl

    @app.delete("/api/watchlists/{wid}")
    def delete_watchlist(wid: int):
        if not store.delete_watchlist(wid):
            raise HTTPException(404, "watchlist not found")
        return {"ok": True}

    # ---------------------------------------------------------------- layouts
    @app.get("/api/layouts")
    def layouts():
        return store.layouts()

    @app.get("/api/layouts/{lid}")
    def layout(lid: int):
        lay = store.layout(lid)
        if not lay:
            raise HTTPException(404, "layout not found")
        return lay

    @app.post("/api/layouts")
    def save_layout(payload: dict = Body(...)):
        if not isinstance(payload.get("state"), dict) or not payload.get("name"):
            raise HTTPException(400, "name and state required")
        lay = store.save_layout(payload["name"], payload["state"], payload.get("id"))
        store.set_setting("last_layout", lay["id"])
        return lay

    @app.delete("/api/layouts/{lid}")
    def delete_layout(lid: int):
        if not store.delete_layout(lid):
            raise HTTPException(404, "layout not found")
        return {"ok": True}

    @app.get("/api/settings/{key}")
    def get_setting(key: str):
        return {"key": key, "value": store.get_setting(key)}

    @app.put("/api/settings/{key}")
    def put_setting(key: str, payload: dict = Body(...)):
        store.set_setting(key, payload.get("value"))
        return {"key": key, "value": payload.get("value")}

    # ---------------------------------------------------------------- alerts
    @app.get("/api/alerts")
    def list_alerts():
        return [dict(a, description=alerts.describe(a)) for a in store.alerts()]

    @app.post("/api/alerts")
    def create_alert(payload: dict = Body(...)):
        try:
            cond = payload["condition"]
            alerts.validate(cond)
            trigger = payload.get("trigger", "once")
            if trigger not in alerts.TRIGGERS:
                raise ValueError(f"trigger must be one of {sorted(alerts.TRIGGERS)}")
            tf = bars.normalize_timeframe(payload.get("timeframe", "D"))
            frame, _ = data.get_bars(payload["symbol"], tf, count=3)
            # history before the current (forming) bar never fires; the current bar is eligible
            last_bar = int(frame["time"].iloc[-2]) if len(frame) >= 2 else None
        except (KeyError, ValueError, data.NoData) as e:
            raise HTTPException(400, str(e))
        expires = payload.get("expires", time.time() + DEFAULT_ALERT_TTL)
        a = store.create_alert(payload["symbol"], tf, cond, trigger, payload.get("message", ""), last_bar,
                               float(expires) if expires else None)
        return dict(a, description=alerts.describe(a))

    @app.patch("/api/alerts/{aid}")
    def update_alert(aid: int, payload: dict = Body(...)):
        a = store.set_alert(aid, **{k: v for k, v in payload.items() if k in ("active", "message", "trigger", "expires")})
        if not a:
            raise HTTPException(404, "alert not found")
        return a

    @app.delete("/api/alerts/{aid}")
    def delete_alert(aid: int):
        if not store.delete_alert(aid):
            raise HTTPException(404, "alert not found")
        return {"ok": True}

    @app.get("/api/alerts/log")
    def alert_log(limit: int = 200, since_id: int = 0):
        return store.alert_log(limit, since_id)

    @app.post("/api/alerts/check")
    def check_alerts():
        return {"fired": run_alert_checks(store, hub)}

    @app.post("/api/alerts/replay")
    def replay(payload: dict = Body(...)):
        """Evaluate a condition over history without persisting (what would have fired, bar by bar)."""
        try:
            alerts.validate(payload["condition"])
            frame, used = data.get_bars(payload["symbol"], payload.get("timeframe", "D"), payload.get("count", 500))
        except (KeyError, ValueError, data.NoData) as e:
            raise HTTPException(400, str(e))
        sig = alerts.signal(payload["condition"], frame)
        return {"source": used, "times": [int(t) for t, s in zip(frame["time"], sig) if s]}

    @app.get("/api/alerts/stream")
    async def alert_stream(request: Request):
        q: asyncio.Queue = asyncio.Queue()
        hub.queues.add(q)

        async def gen():
            try:
                yield ": connected\n\n"
                while not await request.is_disconnected():
                    try:
                        ev = await asyncio.wait_for(q.get(), timeout=15)
                        yield f"event: {ev['type']}\ndata: {json.dumps(ev)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": ping\n\n"
            finally:
                hub.queues.discard(q)
        return StreamingResponse(gen(), media_type="text/event-stream")

    # ---------------------------------------------------------------- backtests (qlib)
    @app.get("/api/backtest/pools")
    def bt_pools():
        return {"pools": backtest.pools(), "builtin_signals": backtest.BUILTIN_SIGNALS}

    @app.get("/api/backtest/signals")
    def bt_signals(pool: str):
        return {"builtin": backtest.BUILTIN_SIGNALS, "files": backtest.signal_files(pool)}

    @app.get("/api/backtest/runs")
    def bt_runs(pool: str | None = None, q: str = "", limit: int = 5000):
        runs = backtest.list_runs(pool, q, min(limit, 5000))
        return (quantifi.list_runs(q) + runs)[:limit] if pool is None else runs

    # ---------------------------------------------------------------- Pine strategies
    @app.get("/api/strategies")
    def strategies():
        """TradingView's built-in strategy templates (fetched on demand) and the user's saved scripts."""
        try:
            builtin = pine_catalog.builtins()
        except pine_catalog.CatalogError as e:
            builtin, err = [], str(e)
        else:
            err = None
        return {"builtin": builtin, "user": store.scripts(), "error": err}

    def _script_source(script: dict) -> str:
        if script.get("source"):
            return script["source"]
        sid = str(script.get("id") or "")
        if sid.startswith("user:"):
            row = store.script(int(sid[5:]))
            if not row:
                raise HTTPException(404, "script not found")
            return row["source"]
        try:
            return pine_catalog.builtin_source(sid)
        except pine_catalog.CatalogError as e:
            raise HTTPException(404, str(e))

    @app.get("/api/strategies/source")
    def strategy_source(id: str):
        return {"id": id, "source": _script_source({"id": id})}

    @app.post("/api/strategies/scripts")
    def save_script(payload: dict = Body(...)):
        src = str(payload.get("source") or "")
        try:
            title = pine_catalog.validate_user_script(src)
        except pine_catalog.CatalogError as e:
            raise HTTPException(400, str(e))
        return store.save_script(str(payload.get("name") or title), src, payload.get("id"))

    @app.delete("/api/strategies/scripts/{sid}")
    def delete_script(sid: int):
        store.delete_script(sid)
        return {"ok": True}

    def _symbol_meta(symbol: str) -> dict:
        """Tick size, quantity step, exchange timezone and currency for the broker emulator."""
        try:
            info = tradingview.symbol_info(symbol)
            scale, minmov = float(info.get("pricescale") or 100), float(info.get("minmov") or 1)
            kind = str(info.get("type") or "")
            return {"mintick": minmov / scale, "qty_step": 0.00001 if kind == "crypto" else 1.0,
                    "tz": info.get("timezone") or "Etc/UTC", "currency": info.get("currency_code") or ""}
        except SidecarError:
            cn = symbol.startswith(("SSE:", "SZSE:"))
            return {"mintick": 0.001 if cn else 0.01, "qty_step": 1.0, "tz": "Asia/Shanghai" if cn else "America/New_York",
                    "currency": "CNY" if cn else "USD"}

    @app.post("/api/strategy/run")
    def strategy_run(payload: dict = Body(...)):
        """Run a Pine strategy on a symbol's bars and return its Strategy Report (+ chart markers, inputs, properties)."""
        symbol, tf = str(payload.get("symbol") or ""), str(payload.get("timeframe") or "D")
        count = int(min(max(int(payload.get("count") or 5000), 50), 20000))
        src = _script_source(payload.get("script") or {})
        try:
            frame, used = data.get_bars(symbol, tf, count, None, "auto", payload.get("adjustment"))
        except data.NoData as e:
            raise HTTPException(404, str(e))
        bars_ = bars.to_records(frame)
        if len(bars_) < 2:
            raise HTTPException(422, "not enough bars")
        meta = _symbol_meta(symbol)
        try:
            res = Runtime(src, bars_, inputs=payload.get("inputs") or {}, props=payload.get("props") or {},
                          mintick=meta["mintick"], qty_step=meta["qty_step"], tz=meta["tz"], symbol=symbol, timeframe=tf).run()
        except (PineSyntaxError, PineRuntimeError) as e:
            raise HTTPException(422, f"Pine: {e}")
        out = pine_report.build(res, symbol, tf, meta["currency"])
        out["meta"]["source"] = used
        out["space"] = pine_optimize.suggest_space(res.inputs)
        return out

    # ---------------------------------------------------------------- strategy optimiser
    @app.post("/api/strategy/optimize")
    def strategy_optimize(payload: dict = Body(...)):
        """Start an input optimisation (background job): {script, symbols, timeframe, count, adjustment, space,
        objective, trials, min_trades, oos_pct, folds, props, inputs (held fixed)}."""
        src = _script_source(payload.get("script") or {})
        symbols = [str(x) for x in (payload.get("symbols") or []) if str(x).strip()][:8]
        if not symbols:
            raise HTTPException(400, "no symbols")
        tf = str(payload.get("timeframe") or "D")
        count = int(min(max(int(payload.get("count") or 5000), 100), 20000))
        datasets = []
        for sym in symbols:
            try:
                frame, _ = data.get_bars(sym, tf, count, None, "auto", payload.get("adjustment"))
            except data.NoData as e:
                raise HTTPException(404, f"{sym}: {e}")
            datasets.append({"symbol": sym, "bars": bars.to_records(frame), **{k: v for k, v in _symbol_meta(sym).items() if k != "currency"}})
        try:
            job = pine_optimize.start(src, datasets, payload.get("space") or [], objective=str(payload.get("objective") or "net_profit"),
                                      trials=int(payload.get("trials") or 100), min_trades=int(payload.get("min_trades") or 0),
                                      oos_pct=float(payload.get("oos_pct") if payload.get("oos_pct") is not None else 30),
                                      folds=int(payload.get("folds") or 0), props=payload.get("props") or {},
                                      fixed=payload.get("inputs") or {}, seed=int(payload.get("seed") or 42))
        except pine_optimize.OptimizeError as e:
            raise HTTPException(400, str(e))
        return job.public()

    @app.get("/api/strategy/optimize/{job_id}")
    def strategy_optimize_job(job_id: str):
        j = pine_optimize.JOBS.get(job_id)
        if not j:
            raise HTTPException(404, "job not found")
        return j.public()

    @app.delete("/api/strategy/optimize/{job_id}")
    def strategy_optimize_cancel(job_id: str):
        return {"cancelled": pine_optimize.cancel(job_id)}

    @app.post("/api/strategy/export")
    def strategy_export(payload: dict = Body(...)):
        """The script's source with new input defaults ({script, values: {title: value}})."""
        src = _script_source(payload.get("script") or {})
        probe = [{"time": 1_600_000_000 + i * 86400, "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 1.0} for i in range(3)]
        try:
            res = Runtime(src, probe).run()
            return {"source": pine_optimize.export_source(src, payload.get("values") or {}, res.inputs), "name": res.title}
        except (PineSyntaxError, PineRuntimeError, pine_optimize.OptimizeError) as e:
            raise HTTPException(422, str(e))

    @lru_cache(maxsize=32)
    def _report(path: str, mtime: float) -> dict:
        return report.build(Path(path))

    @app.get("/api/backtest/report/{run_id:path}")
    def bt_report(run_id: str):
        """TradingView-style Strategy Report for one run (cached per run directory + report.csv mtime), including QuantiFi
        runs and their stress scenarios (quantifi:<strategy>/<stamp>/stress/<label>)."""
        if run_id.startswith("quantifi:"):
            try:
                return quantifi.report(run_id)
            except FileNotFoundError:
                raise HTTPException(404, "run not found")
        try:
            d = backtest.resolve_run(run_id)
            return _report(str(d), (d / "report.csv").stat().st_mtime)
        except FileNotFoundError:
            raise HTTPException(404, "run not found")

    @app.get("/api/backtest/instrument")
    def bt_instrument(run: str, instrument: str):
        """One instrument in a saved run: operations (buy/add/trim/sell), holding periods and P&L summary."""
        if run.startswith("quantifi:"):
            try:
                return quantifi.instrument_detail(run, instrument)
            except FileNotFoundError:
                raise HTTPException(404, "run not found")
            except KeyError:
                raise HTTPException(404, f"{instrument} was never traded in this run")
        try:
            return report.instrument_detail(backtest.resolve_run(run), instrument)
        except FileNotFoundError:
            raise HTTPException(404, "run not found")
        except KeyError:
            raise HTTPException(404, f"{instrument} was never held in this run")

    @app.get("/api/backtest/overlay")
    def bt_overlay(run: str, product: str):
        """QuantiFi runs: the strategy's quotes, position and own numbers for one product's chart."""
        try:
            return quantifi.overlay(run, product)
        except FileNotFoundError:
            raise HTTPException(404, "run not found")

    @app.get("/api/backtest/runs/{run_id:path}")
    def bt_run(run_id: str):
        try:
            return backtest.load_run(run_id)
        except FileNotFoundError:
            raise HTTPException(404, "run not found")

    @app.post("/api/backtest")
    def bt_start(payload: dict = Body(...)):
        try:
            return backtest.start(payload)
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.get("/api/backtest/jobs/{job_id}")
    def bt_job(job_id: str):
        j = backtest.job(job_id)
        if not j:
            raise HTTPException(404, "job not found")
        return j

    # ---------------------------------------------------------------- QuantiFi (UTEFA hackathon) replays
    @app.get("/api/quantifi/strategies")
    def qf_strategies():
        """Strategy files (submission/ and teammates' folders) that tools/backtest.py can replay."""
        return quantifi.strategies()

    @app.post("/api/quantifi/run")
    def qf_run(payload: dict = Body(...)):
        try:
            return quantifi.start(str(payload.get("strategy") or ""))
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.get("/api/quantifi/stress-stops")
    def qf_stress_stops():
        """Slider stops of the stress scenarios: push half-life in ticks (null = no decay), liquidity share, delay."""
        return quantifi.STRESS_STOPS

    @app.post("/api/quantifi/scenario")
    def qf_scenario(payload: dict = Body(...)):
        """{run, half_life, share, delay} -> {status: done, run_id} when replayed before, else a job to poll."""
        try:
            return quantifi.scenario(str(payload.get("run") or ""), payload.get("half_life"), float(payload.get("share", 1.0)),
                                     int(payload.get("delay", 0)))
        except ValueError as e:
            raise HTTPException(400, str(e))
        except FileNotFoundError:
            raise HTTPException(404, "run not found")

    @app.get("/api/quantifi/jobs/{job_id}")
    def qf_job(job_id: str):
        j = quantifi.job(job_id)
        if not j:
            raise HTTPException(404, "job not found")
        return j

    # ---------------------------------------------------------------- web client
    if config.WEB_DIST.exists():
        app.mount("/assets", StaticFiles(directory=config.WEB_DIST / "assets"), name="assets")

        @app.get("/{path:path}")
        def spa(path: str):
            if path == "api" or path.startswith("api/"):
                raise HTTPException(404, "not found")             # unknown API routes are not the app shell
            root = config.WEB_DIST.resolve()
            f = (root / path).resolve()
            return FileResponse(f if path and f.is_file() and f.is_relative_to(root) else root / "index.html")

    return app

