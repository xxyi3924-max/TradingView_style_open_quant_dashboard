"""Strategy parity: run TradingView's built-in strategy Pine sources through tvre.pine on the exact bars
TradingView used, and compare the trade lists with TradingView's own Strategy Tester reports.

Inputs (gitignored, captured by sidecar/src/strategy-fixtures.mjs and re/raw/pine):
  re/raw/pine/*.pine                         TradingView's built-in strategy templates
  re/raw/strategy_reports/<sym>_<tf>_<id>.json   TradingView reports (+ last 5000 candles)
  re/raw/strategy_reports/candles_<sym>_<tf>.json  full history from the backtest start
Usage: python scripts/strategy_parity.py [--md re/STRATEGY_PARITY.md] [name-filter]
"""
from __future__ import annotations

import argparse
import glob
import json
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from tvre.pine.report import tv_ratios  # noqa: E402
from tvre.pine.runtime import Runtime  # noqa: E402

RAW = ROOT / "re" / "raw"
SYMBOLS = {  # tick, quantity step, exchange timezone
    "SSE:510300": (0.001, 1.0, "Asia/Shanghai"),
    "NASDAQ:AAPL": (0.01, 1.0, "America/New_York"),
    "BINANCE:BTCUSDT": (0.01, 0.00001, "Etc/UTC"),
}
PROP_KEYS = ("initial_capital", "default_qty_type", "default_qty_value", "pyramiding", "commission_type", "commission_value",
             "slippage", "margin_long", "margin_short", "process_orders_on_close", "close_entries_rule")


@dataclass
class Outcome:
    name: str
    symbol: str
    timeframe: str
    tv_trades: int
    our_trades: int
    matched: int                 # leading trades identical (times, prices, qty, P&L within 1e-6 relative)
    aligned: int                 # leading trades that are the same trade (times, prices, names) with qty/P&L within float-tie noise
    first_diff: str
    net_tv: float
    net_ours: float
    sharpe_tv: float | None = None
    sharpe_ours: float | None = None
    sortino_tv: float | None = None
    sortino_ours: float | None = None

    @property
    def ratios_exact(self) -> bool:
        same = lambda a, b: a is not None and b is not None and abs(a - b) <= 1e-6 * max(1.0, abs(b))
        return same(self.sharpe_ours, self.sharpe_tv) and same(self.sortino_ours, self.sortino_tv)


def bars_for(fx: dict) -> list[dict]:
    sym, tf = fx["symbol"].replace(":", "_"), fx["timeframe"]
    full = json.loads((RAW / "strategy_reports" / f"candles_{sym}_{tf}.json").read_text())
    last = {c["time"]: c for c in fx["candles"]}
    return [last.get(c["time"], c) for c in full]


def source_for(fx: dict) -> str:
    idx = json.loads((RAW / "pine" / "index.json").read_text())
    file = next(x["file"] for x in idx if x["id"] == fx["id"])
    return (RAW / "pine" / file).read_text()


def tv_trades(fx: dict) -> list[dict]:
    return fx["report"]["trades"][::-1]


def compare(fx: dict) -> Outcome:
    tick, step, tz = SYMBOLS[fx["symbol"]]
    props = {k: v["value"] for k, v in fx["inputs"].items() if v.get("fake") and k in PROP_KEYS}
    rt = Runtime(source_for(fx), bars_for(fx), props=props, mintick=tick, qty_step=step, tz=tz, symbol=fx["symbol"],
                 timeframe=fx["timeframe"])
    res = rt.run()
    ours = res.trades + res.open_trades
    tv = tv_trades(fx)

    def same_trade(a, t) -> bool:
        return (a.entry_time * 1000 == t["entry"]["time"] and abs(a.entry_price - t["entry"]["value"]) < 1e-9
                and (a.open or a.exit_time * 1000 == t["exit"]["time"]) and (a.open or abs(a.exit_price - t["exit"]["value"]) < 1e-9)
                and a.entry_label == t["entry"]["name"] and (a.open or a.exit_label == t["exit"]["name"])
                and (a.dir == 1) == (t["entry"]["type"] == "long"))

    def exact(a, t) -> bool:
        return same_trade(a, t) and abs(a.qty - t["quantity"]) < 1e-9 and \
            abs(a.profit - t["profit"]["v"]) <= 1e-6 * max(1.0, abs(t["profit"]["v"])) + 1e-3

    def close(a, t) -> bool:   # float ties: TradingView may size/liquidate one step differently
        dq = abs(a.qty - t["quantity"])
        move = abs(t["exit"]["value"] - t["entry"]["value"]) if not a.open else abs(a.exit_price - a.entry_price)
        return same_trade(a, t) and dq <= max(4 * step, 2e-4 * t["quantity"]) + 1e-9 and \
            abs(a.profit - t["profit"]["v"]) <= dq * move + 1e-6 * max(1.0, abs(t["profit"]["v"])) + 1e-2 + 2e-4 * abs(t["profit"]["v"])

    matched = next((k for k, (a, t) in enumerate(zip(ours, tv)) if not exact(a, t)), min(len(ours), len(tv)))
    aligned = next((k for k, (a, t) in enumerate(zip(ours, tv)) if not close(a, t)), min(len(ours), len(tv)))
    first_diff = ""
    if aligned < min(len(ours), len(tv)):
        a, t = ours[aligned], tv[aligned]
        first_diff = (f"#{aligned + 1} ours {a.entry_label} {a.dir:+d} @{a.entry_price} t={a.entry_time} -> {a.exit_label or 'open'} "
                      f"@{a.exit_price} t={a.exit_time} q={a.qty} pnl={a.profit:.4f} | TV {t['entry']['name']} {t['entry']['type']} "
                      f"@{t['entry']['value']} t={t['entry']['time'] // 1000} -> {t['exit']['name'] or 'open'} @{t['exit']['value']} "
                      f"t={t['exit']['time'] // 1000} q={t['quantity']} pnl={t['profit']['v']}")
    elif len(ours) != len(tv):
        first_diff = f"trade count {len(ours)} vs TV {len(tv)}"
    net_tv = fx["report"]["performance"]["all"]["netProfit"]
    perf = fx["report"]["performance"]
    sh, so = tv_ratios(res.trades, res.props.initial_capital, res.props.risk_free_rate,
                       sum(t.profit for t in res.open_trades), int(rt.bars[-1]["time"]))
    return Outcome(fx["name"], fx["symbol"], fx["timeframe"], len(tv), len(ours), matched, aligned, first_diff, net_tv,
                   sum(t.profit for t in res.trades), perf.get("sharpeRatio"), sh, perf.get("sortinoRatio"), so)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("filter", nargs="?", default="")
    ap.add_argument("--md", default=None)
    ap.add_argument("-v", action="store_true")
    args = ap.parse_args()
    outs = []
    for f in sorted(glob.glob(str(RAW / "strategy_reports" / "*_*_*.json"))):
        if Path(f).name.startswith("candles_"):
            continue
        fx = json.loads(Path(f).read_text())
        if args.filter.lower() not in f"{fx['name']} {fx['symbol']}".lower():
            continue
        try:
            o = compare(fx)
        except Exception as e:  # noqa: BLE001 - report every script, keep going
            o = Outcome(fx["name"], fx["symbol"], fx["timeframe"], len(fx["report"]["trades"]), 0, 0, 0, f"ERROR {type(e).__name__}: {e}", 0, 0)
        outs.append(o)
        ok = o.matched == o.tv_trades == o.our_trades
        al = o.aligned == o.tv_trades == o.our_trades
        tag = "OK " if ok else "~  " if al else "-- "
        print(f"{tag} {o.name:38s} {o.symbol:16s} {o.timeframe:>3s}  exact {o.matched:5d} aligned {o.aligned:5d} /{o.tv_trades:<5d} ours={o.our_trades:<5d}"
              + ("" if al else f"\n      {o.first_diff}"))
    total = len(outs)
    exact = sum(o.matched == o.tv_trades == o.our_trades for o in outs)
    aligned = sum(o.aligned == o.tv_trades == o.our_trades for o in outs)
    print(f"\n{exact}/{total} runs identical to TradingView; {aligned}/{total} same trades (allowing float-tie size differences)")
    tx = [o for o in outs if o.matched == o.tv_trades == o.our_trades]
    print(f"Sharpe and Sortino identical on {sum(o.ratios_exact for o in tx)}/{len(tx)} of the trade-identical runs")
    if args.md:
        write_md(Path(args.md), outs)


def write_md(path: Path, outs: list[Outcome]):
    ok = lambda o: o.matched == o.tv_trades == o.our_trades
    ratio = lambda o: ("✅" if o.ratios_exact else f"{o.sharpe_ours / o.sharpe_tv:.3f}×") if ok(o) and o.sharpe_tv else "—"
    rows = "\n".join(f"| {o.name} | {o.symbol} {o.timeframe} | {o.tv_trades} | {o.matched} | {'✅' if ok(o) else '❌ ' + o.first_diff.replace('|', '/')[:160]} | {ratio(o)} |"
                     for o in outs)
    exact = sum(ok(o) for o in outs)
    rexact = sum(ok(o) and o.ratios_exact for o in outs)
    path.write_text(f"""# Strategy parity: tvre.pine vs TradingView's Strategy Tester

TradingView's built-in strategy templates (Pine source from the Pine Editor's "Create new → Built-in…",
`pine-facade/get/<id>/last`, scriptAccess `open_no_auth`) run unchanged through our interpreter
(`server/tvre/pine/`) on the exact bars TradingView used, with TradingView's default properties
(capital 100,000, order size 100% of equity, pyramiding 1, margin 100%/100%, no commission or slippage).
Each run is compared trade by trade with the report TradingView computed for the same script, symbol
and interval (entry/exit time, price, quantity, P&L, entry/exit names). Generated by
`server/scripts/strategy_parity.py`.

**{exact} of {len(outs)} runs match trade for trade; on {rexact} of those {exact} the Sharpe and Sortino ratios are identical too.**
The last column is our Sharpe / TradingView's where they differ.

| Strategy | Symbol | TradingView trades | Identical leading trades | Result | Sharpe / Sortino |
|---|---|---|---|---|---|
{rows}

## Broker emulator rules (measured against these reports; `server/tvre/pine/broker.py`)

- **Timing.** Orders placed on a bar's close fill from the next bar; market orders at its open
  (`process_orders_on_close` fills at the signal bar's close). At most one fill per bar, except margin calls.
- **Intrabar path.** open → high → low → close if the high is nearer the open (`high − open < open − low`), else
  open → low → high → close. Stop/limit orders trigger on the first segment that crosses them; a gap through the
  level fills at the open. Triggering compares **tick-rounded** prices with the tick-rounded level: an AAPL 1980
  open of 0.118861 (→ 0.12) fills a buy stop at 0.112723 (→ 0.12). Invisible on symbols whose prices are already
  on the tick grid (510300, BTCUSDT); on split-adjusted AAPL it made 3 more runs exact.
- **Prices.** Fills are rounded to the tick half-up (`floor(|p| / tick + 0.5)`, no epsilon). Stop and limit levels
  round against the trader: buy stops and sell limits up, sell stops and buy limits down.
- **Size.** `% of equity`: `floor(round(equity at the signal close, 8) × pct / 100 ÷ sizing price)`; the sizing
  price is the worse of the tick-rounded close and the order's own price (higher for buys, lower for sells).
- **Funding.** At the fill: if (new + held units) × fill price × margin > equity the order is rejected; else if
  that position valued at the *signal close* exceeds equity, only the opposite position is closed (reversal
  becomes a plain exit); else it fills. Strict comparisons. Pyramiding adds count the units already held.
- **Margin calls.** Checked at each intrabar vertex in TradingView's documented order (money spent → market
  value → open profit → equity → margin → available funds); when available funds < 0 (tolerance 1e-6) the
  broker liquidates 4 × the shortfall in units (minimum 1) at the vertex price, labelled "Margin call". The
  shortfall is rounded to 8 decimals before `TRUNCATE(loss / price)`: P&L float dust accumulated over many
  trades otherwise makes 2971.92 / 0.12 truncate to 24765 instead of 24766 (a call 4 units short).
- **Pine semantics.** Float comparisons (`==`, `<`, crossovers) treat values within 1e-10 (relative) as equal;
  `ta.ema` is seeded with the SMA of the first `length` values; pivots need ≥ the left bars and > the right bars.
- **Labels.** Entry label = order comment or id; exit label = the closing order's comment or id; forced exits
  are "Margin call" and "Close Position (Max intraday Loss)".

## Report metrics

| Metric | Status |
|---|---|
| Net profit, gross profit/loss, trades, win rate, profit factor | exact (follow from the trades) |
| Max drawdown | exact: peaks of closed-trade equity, troughs = equity before the trade + the trade's worst open loss |
| Buy and hold return | exact: from the first trade's entry price |
| Sharpe / Sortino | identical on {rexact} of the {exact} trade-identical runs, most others within ~1%: monthly returns of closed-trade equity from the first exit, with the open trade's P&L counted at the last bar, minus risk_free_rate / 12, over the **population** standard deviation (downside deviation for Sortino), not annualized |

## Known differences

- **AAPL daily from 1980 (split-adjusted prices ≈ $0.10 on a $0.01 tick).** In every divergence traced (RSI,
  Inside bar, Consecutive up/down, MACD) the signals match TradingView's and the difference is a whole-unit
  decision at an exact-equity tie; the other AAPL runs have not been traced individually. An order sized at 100% of equity can cost
  exactly the equity (530066 × 0.12 = 63607.92); whether it fills, and whether TradingView then margin-calls 1 unit
  on the entry bar (95 such 1-unit calls in its AAPL reports), depends on float dust in the running equity.
  TradingView's dust and ours fall on different sides in some cases, and its reports (rounded money values) do not
  show its float path. Rounding the funding equity to 8 decimals improves AAPL but breaks a 510300 run where
  TradingView rejects the mirror case, so it is not TradingView's rule. Unresolved.
- **Bar up/down on BTCUSDT 4h (interval 240):** `strategy.risk.max_intraday_loss(1, percent_of_equity)`. Our
  ordinary daily-loss halts match TradingView's, but TradingView also halts on 6 reversal bars, closing the new
  short at its own fill price with zero P&L (first: 2024-02-29 20:00), when that day's loss is well under 1% by
  every measure tried (from the day open, from the day's equity peak, at raw or tick prices). Unresolved.
- **Not supported:** `import` of Pine libraries (Technical Ratings strategy), drawings/tables/requests
  (`request.security`), `strategy.exit` trailing stops, OCA groups beyond cancel.

## Optimiser

`server/tvre/pine/optimize.py` (UI: Strategy report → Optimize) searches input values with Optuna TPE on this
engine: objectives net profit, profit factor, Sharpe, Sortino, percent profitable, return / max drawdown, max
drawdown; minimum closed trades; mean over several symbols; an in-sample / out-of-sample split (the search never
sees the last N% of bars; the best trials are replayed on them) and anchored walk-forward (stitched
out-of-sample return, profitable folds, walk-forward efficiency). Results can be applied to the chart, saved as
presets, or exported as Pine with new input defaults (`/api/strategy/export`, re-run to verify every default).
""")


if __name__ == "__main__":
    main()
