# Chart Studio (the dashboard)

A self-hosted, TradingView-style charting app and backtest dashboard. It has real market data, candlesticks, indicators, drawing tools, persistent watchlists and layouts, server-side alerts, a Pine strategy engine, and a Strategy report that shows runs from your own backtest engines (the QuantiFi replay engine in [`../engine`](../engine) is the worked example). Not affiliated with TradingView.

```
sidecar/  Node · @mathieuc/tradingview  →  TradingView data over HTTP + SSE (:8787)
server/   FastAPI →  data routing, indicators, SQLite, alerts, Pine engine, engine bridges (:8000)
web/      Vite + TypeScript + lightweight-charts →  the UI (:5173, proxies /api)
```

## Run

```bash
./dev.sh                      # sidecar + API + web (auto-reload); open http://127.0.0.1:5173
```

- **Install.** `pip install -r server/requirements.txt` (Python 3.11+), then `npm install` in `sidecar/` and `web/`. `dev.sh` uses `$TVRE_PYTHON`, else `python3`.
- **Data.** TradingView is the primary feed (any symbol, intraday, live bars and quotes). If the sidecar is down, the server can fall back to local parquet panels (paths in `server/tvre/config.py`; no data ships with this repo). The badge in the top bar shows the active source.
- **Account session (optional).** `node sidecar/src/with-browser-session.mjs` starts the sidecar with the TradingView session of the account signed in to a debug-port Chrome (`--remote-debugging-port=9222`). The cookies are passed only through the process environment. **Caveat:** on a free plan, TradingView allows one live data session per account. The authenticated sidecar takes it, and the signed-in browser chart then freezes behind a fade overlay. Use the account session only for parity checks, and switch back to `node sidecar/src/server.mjs` afterwards.

## Features

The chrome follows TradingView's chart page as measured from it (1470×757): a 38px top bar, a 52px left toolbar, a 302px widget panel with a 45px icon strip, a 38px bottom range bar, 4px gaps on a #EBEBEB canvas, and the same menus, flyouts and tooltips. The icons are our own drawings.

- **Top bar:** symbol pill (with the data-source switch), Compare, Interval menu, Chart type (10 types incl. Heikin Ashi), Indicators + templates, Alert, Bar replay, Undo/Redo, Layout setup (1–4 charts, symbol/interval/crosshair/time sync), layout name/Save, Manage layouts (autosave, copy, rename, download data, new, recent, open), Quick search (⌘K), Settings, Fullscreen, Snapshot.
- **Left toolbar:** groups with flyouts (cursors + eraser; trend tools incl. crossline; fib; long/short position and price/date ranges; rectangle/circle; text/price label), Measure (Shift+click), Zoom in, weak/strong magnet, keep drawing, lock, hide, remove. Shortcuts: Alt+T/H/J/V/C/F, Alt+Shift+R, Alt+R, Alt+A, `/`, ⌘Z/⌘⇧Z, ⌘S, ⌘K, Shift+F, ⌥⌘S.
- **Bottom bar:** 1D 5D 1M 3M 6M YTD 1Y 5Y All switch interval and span exactly as TradingView does; Go to date; clock with timezone menu; ADJ (dividend adjustment).
- **Right panel:** watchlist with sections, live quotes, column settings, upload/download; details card (price, market status, key stats, performance); Alerts (list + log); Object tree + Data window; Strategy report; keyboard shortcuts.
- **Chart:** symbol search by typing, typed intervals, lazy history on scroll-left, live last-bar updates, TradingView-style legend (description · interval · exchange, OHLC, change, Vol, study rows with hide/settings/remove), compare symbols on a percent scale, bar replay.
- **Indicators:** SMA, EMA, WMA, BB, VWAP, RSI (+ RSI-based MA), MACD, ATR, Stochastic, OBV. All match TradingView's values (`server/scripts/parity_report.py` checks them against the live studies).
- **Drawings:** 17 tools stored per symbol, with magnet, drag body/anchor, lock, hide and Delete.
- **Alerts:** price or indicator vs value or indicator; crossing, crossing up/down, greater/less than, entering/exiting/inside/outside channel; once, once per bar, once per bar close; one-month default expiry. Evaluated server-side every 20 s, with toast, browser notification and log.
- **Strategy report** (dock under the chart, laid out like TradingView's Strategy Tester): run an external qlib engine, `etf_rotation.research.qlib_backtest` (not included in this repo; the bridge is `server/tvre/backtest.py`) (pool, built-in or file signal, top-K, rebalance, start, costs, initial capital) or open any saved run from a folder tree (market → pool → namespace → signal family) that covers both the CN ETF pools and the US stock study (`us_stock_rotation`, read-only, USD). It shows Key stats, a Performance chart (cumulative P&L, buy and hold, trade excursions, drawdowns), Performance analysis (Breakdown, Periodical, Benchmarking, Growth and decline), Trades analysis (Distribution, Streaks, Time patterns) and the List of trades with CSV export. An **Instruments** view lists what the run earned and lost on each name (filter Earned / Lost, search); clicking a name opens its page in TradingView's Strategy Tester layout (Overview with key stats, cumulative P&L chart and metrics; Holding periods; Operations) — P&L summary, holding periods and the full operations history (buy, add, trim, sell with price, size, position after, period and cumulative P&L) — and its chart framed on that activity with a marker per operation. Trade P&L reconciles exactly to the account curve. When the engine priced suspended or back-filled instruments with stale closes, the gap is reported as unattributed P&L instead of being hidden.
- **Pine strategies:** Indicators → Strategies runs TradingView's built-in strategy templates (Pine source fetched at runtime, never stored in the repo) or your own pasted Pine strategy ("My scripts") in our interpreter and broker emulator (`server/tvre/pine/`). The chart gets TradingView-style order labels and a legend row; the dock shows the Strategy Tester report; the gear opens Inputs / Properties. 45 of 63 captured TradingView runs match trade for trade (Sharpe and Sortino identical on 36 of those); `server/scripts/strategy_parity.py` re-runs the comparison from captured reports (not included).
- **Optimiser:** Strategy report → Optimize searches input ranges with Optuna TPE (objective, trials, minimum trades, several symbols), checks the winners on held-out bars (in-sample / out-of-sample split or anchored walk-forward), and can apply a result, save it as a preset, or export the script with new input defaults.
- **QuantiFi 2026 replays:** Strategy report → New QuantiFi run picks any `Trader` file in the engine folder (`submission/`, `other strategy/`; `TVRE_QUANTIFI_ROOT`, default `../engine`) and replays it with its `tools/backtest.py` over training days −2, −1, 0 using the website's fill rules (cross the displayed book; rest against same-tick market trades at your own price; a batch that could breach a position limit is cancelled). Runs open under *QuantiFi 2026* in the saved-run tree. The report is in coins: Key stats with max drawdown, Sharpe/Sortino (100-tick PnL blocks, scaled to a day), fills, rejected batches and errors; By day; Products with every fill on the chart (`QUANTIFI:<product>`, mid-price candles, one tick = one second, each day on its own date, axis labelled *Day −1 · 250k*); a Greeks view (net delta, vega, gamma, theta of the voucher book, Black–Scholes at each strike's implied vol). Opening a run puts its biggest product on the upper chart at tick level (interval menu → Ticks; one bar per tick) with every fill pinned at its price, the book's best bid/ask, the strategy's own quotes, its position, and the numbers it keeps in `traderData` or an optional `self.plots` dict (price-like ones on the candles, e.g. the momentum EMA; the rest in their own panes); clicking a product in the report switches the chart to it. The **Stress** view replays one slippage scenario picked with sliders, on the server (`tools/backtest.py --stress`), and shows it beside the website run: each unit the strategy buys moves that product's asks up by λ / share coins and each unit it sells moves its bids down (λ = the order book's own price walk per unit), and the gap refills with a push half-life (linear transient impact with book resilience, Obizhaeva & Wang 2013), so it can never sell into the push its own buying made; only a share of the displayed volume and market trades is the strategy's; and orders can reach the book a tick late. The strategy is shown the stressed book and reacts to it. A scenario is cached under `<run>/stress/<label>/` and opens like any run (*Open on chart*), with a *Website run* chip back.

## Tests

```bash
cd sidecar && npm test                                     # 8 live tests against TradingView
cd server && python -m pytest -q                            # offline + live (TVRE_SKIP_LIVE=1: offline only)
cd web && npx vitest run && npx playwright test             # TS units; e2e B1–B41 (isolated server + temp DB)
cd server && python scripts/parity_report.py                # indicators vs TradingView's studies (needs the sidecar)
```

What the tests pin down:
- TS indicators == Python reference (1e-9), and Python == TradingView studies (≤1e-8 after warm-up).
- The qlib bridge == the engine's native path, bit for bit (skipped when the qlib engine isn't present).
- TradingView W/M bars == our resampling exactly.
- Every behaviour scenario has an end-to-end test (B1–B41, including the toolbar flyouts, range bar, chart types, undo/redo, replay, the Strategy report tabs, Pine strategies and the optimiser).
- Pine engine: 45 TradingView Strategy Tester runs are pinned trade for trade (`server/tests/strategy_parity_exact.json`) and 36 to the exact Sharpe/Sortino (`strategy_ratios_exact.json`), runs where the captured reports exist); optimiser metrics, walk-forward stitching, cancel and Pine export are unit-tested.
- The Strategy report's numbers reconcile with the run's `report.csv` (exact on clean runs; tested on synthetic runs with known P&L).

## Data notes

- **How fresh the data is.** Charts, the watchlist and the details card come from TradingView through the sidecar, an unofficial client (`@mathieuc/tradingview`), and stream live. On the anonymous session, China A-share/ETF exchanges are 15 minutes delayed; US stocks are real-time from Cboe One (Cboe venues only). Use it within TradingView's terms.

## Credits

The app code is our own and contains no TradingView code. Rendering uses TradingView's open-source [lightweight-charts](https://github.com/tradingview/lightweight-charts) (Apache-2.0, attribution kept on the chart); market data comes through [`@mathieuc/tradingview`](https://github.com/Mathieu2301/TradingView-API) (ISC). TradingView is a trademark of TradingView, Inc.; this project is not affiliated with it.
