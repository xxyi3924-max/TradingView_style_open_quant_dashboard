# QuantiFi replay engine

A tick-by-tick backtester for the QuantiFi 2026 (UTEFA) algorithmic trading competition. Strategies use the IMC Prosperity interface: a `Trader` class whose `run(state)` returns orders, conversions and a `traderData` string. The engine replays the competition's order books and trades under the website's fill rules. It also replays slippage stress scenarios, where the market reacts to the strategy's own trading. Python standard library only.

## Fill rules (the website's)

- An order that crosses the book fills against the displayed levels at their prices, best first.
- What is left rests for that tick only. A buy fills at its own price on a market trade printed at or below it, a sell on one at or above it. Each printed lot fills one order.
- If a product's buys alone, or its sells alone, could take the position past its limit, all of that product's orders are cancelled for the tick.
- Each day starts flat with a fresh `Trader`, as the website runs one day at a time. Positions are marked at mid.

## Stress scenarios

`--stress h=100,share=0.5,delay=0` replays the strategy in a market that reacts to it:
- **Push and refill:** each unit bought moves that product's asks up by λ / share coins, and each unit sold moves its bids down. The gap refills with a half-life of h ticks (linear transient impact with order-book resilience, Obizhaeva & Wang 2013). λ is calibrated from the displayed books.
- **Thinner book:** only `share` of the displayed volume and of market trades is the strategy's.
- **Delay:** orders reach the book `delay` ticks late.

The strategy sees the stressed book and reacts to it. The model, its calibration, its checks and its references are in [docs/slippage_model.md](docs/slippage_model.md).

## Data (not included)

Put the competition files in `Data/`. Both are semicolon-separated, one file per training day (−2, −1, 0):

- `prices_day_<d>.csv`: `day;timestamp;product;bid_price_1;bid_volume_1;…;bid_price_3;bid_volume_3;ask_price_1;ask_volume_1;…;ask_price_3;ask_volume_3;mid_price;profit_and_loss`
- `trades_day_<d>.csv`: `timestamp;buyer;seller;symbol;currency;price;quantity`

Timestamps step by 100; a day is 10,000 ticks. Position limits, days to option expiry, and the underlying used for the voucher Greeks are constants at the top of `tools/backtest.py`.

## Run

```bash
python3 tools/backtest.py submission/example_trader.py                    # website rules
python3 tools/backtest.py submission/example_trader.py --stress h=100,share=0.5,delay=0
python3 tools/stress.py submission/example_trader.py                      # all 60 scenarios, as tables
python3 -m pytest tests -q
```

Each run writes `runs/<strategy>/<stamp>/`:
- `meta.json`: summary, PnL per day, the scenario, and λ.
- `fills.csv`
- `equity.csv`: PnL every tick.
- `greeks.csv`: option book delta, gamma, vega and theta every 10 ticks.
- `indicators.csv`: the numbers the strategy keeps in `traderData` or an optional `self.plots` dict, plus its own quotes.

The dashboard in [`../dashboard`](../dashboard) opens these runs as Strategy reports, with fills, quotes and indicators on a tick-level chart, and a Stress view with sliders.

`datamodel.py` is our own implementation of the interface's types, so competition `Trader` files run unchanged. `submission/example_trader.py` is a deliberately simple strategy that shows the interface; it is not a competition strategy and loses money.
