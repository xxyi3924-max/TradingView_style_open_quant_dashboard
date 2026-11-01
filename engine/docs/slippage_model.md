# Backtester slippage model (stress test)

The website fills an order by walking the displayed book, and the book it shows next tick is the recorded one: our trades never move the market. That is the score, and `tools/backtest.py` reproduces it exactly. The stress test asks what happens if the market did react to us, the way real markets do, and where each strategy stops making money. `tools/stress.py` runs every scenario of a strategy and writes the results as tables.

## The model

This is linear transient impact with order-book resilience (Obizhaeva & Wang 2013), the standard way to add impact to a replay, in the propagator family of Bouchaud, Gefen, Potters & Wyart (2004).

- **Push:** the liquidity our takes eat doesn't come back at once.
  - Each unit bought moves that product's **asks** up by **λ / s** coins.
  - Each unit sold moves its **bids** down by the same amount.
- **Refill:** the gap refills with a **half-life of h ticks**.
  - h = 0: refilled by the next tick, as on the website.
  - h = ∞: not refilled within the day.
- **One-sided:** the other side of the book is untouched. Buying and then selling back costs more than on the website, never less. The strategy can't sell into the push its own buying made.
- **Thinner book:** only a **share s** of every displayed level, and of every market trade, belongs to the strategy (other traders compete for the rest). Volumes are floored. Market trades keep a fractional carry, so 1-lot trades aren't all rounded away.
- **Delay:** with **d = 1**, orders sent at a tick reach the book a tick later (Moallemi & Sağlam 2013). The strategy acts on a stale book, and on a stale position too, so a batch can breach a limit and be cancelled.
- **The strategy reacts:** each tick it is shown the stressed book (each side moved by its push, rounded to whole coins) and decides from that. Taken fills settle at the shown price plus the fractional rest of the push.
- **Marking:** positions are marked at the **recorded** mid, so a strategy never profits on paper from its own push.
- **Resting fills don't push:** they are other traders' market orders, and those orders' impact is already in the recorded prices. Those market trades keep their recorded prices, so a resting order can be hurt by our push but can never sell it to anyone. Resting fills still feel s (fewer market trades are ours) and d (quotes placed on a stale book).

Gatheral (2010) showed that exponential decay is only arbitrage-free with *linear* impact, which is why the push is linear in units taken. An arbitrage-free model must also never reward a strategy for trading against its own impact. Two such loopholes showed up in testing and were closed (see *Checks* below).

## λ: calibrated from our own order books

λ is how far the displayed book walks per unit. It's the OLS slope of distance from mid against units filled, over every 10th book of the three days (the book density in Obizhaeva–Wang). It's cached in `runs/push_lambda.json`:

| Products | λ (coins per unit) |
|---|---|
| Vouchers 7200–7750 | ≈ 0.098 |
| Vouchers 6800, 7000 | ≈ 0.115 |
| Vouchers 7900, 8100 | ≈ 0.057 |
| LYCHEE | 0.058 |
| AMETHYST, PAPER_LANTERNS | ≈ 0.077 |
| Pearls, PEANUT_BUTTER | ≈ 0.091 |
| DRAGONFRUIT, GRANADILLA, MANGOSTEEN, FRUIT_BASKET, TOFFEE_CAKE | ≈ 0.115 |
| JELLY | 0.137 |
| TELLURIUM | 0.163 |

Only λ comes from data. This market has no real impact to measure, so **h, s and d are swept rather than estimated**. The published work puts real markets well inside the grid: impact is still about ⅔ of its peak at the end of a trading day (Bucci et al. 2019; Said et al. 2018). The square-root law holds in options too (Tóth, Eisler & Bouchaud 2016).

**Grid:** h ∈ {0, 1, 10, 100, 1000, ∞} ticks × s ∈ {100, 75, 50, 25, 10}% × d ∈ {0, 1}, 60 scenarios per strategy. The cell h 0 · 100% · no delay is the website. The summary uses three reference cells:

| Reference | h | s | d |
|---|---|---|---|
| Mild | 10 | 75% | 0 |
| Moderate | 100 | 50% | 0 |
| Severe | 1000 | 25% | 1 |

## How to run it

- One scenario: `python3 tools/backtest.py submission/example_trader.py --stress h=100,share=0.5,delay=0`
- The grid for every strategy: `python3 tools/stress.py --all`, which writes `stress_grid.json` next to each website run and the tables to `docs/stress_results.md`. A strategy takes 1–20 minutes on 8 cores, depending on how heavy its `run()` is.
- Rebuild the results doc from the saved grids without replaying: `python3 tools/stress.py --doc`.
- In Trading View RE:
  1. Open a QuantiFi run.
  2. Open the **Stress** view (sliders icon in the dock toolbar).
  3. Pick h, s and d, then click **Run scenario**. The first run takes about 30 s; after that it's cached under `runs/<strategy>/<stamp>/stress/<label>/`.
  4. *Open on chart* shows the scenario's fills on the upper chart, and the *Website run* chip goes back.

## Checks

- **The website is unchanged:** every strategy's website PnL replays exactly as before the stress code was added. The scenario h 0 · 100% · 0 equals the website, and a test checks it.
- **No profit from own impact:** two loopholes showed up and were closed. Both were caught because a market-making strategy made up to 8× its website PnL with a 1-tick delay, and its push cost came out negative.
  1. Shifting the recorded market trades by our push let a resting order sell the push to them (pump, then sell passively). Market trades now keep their recorded prices.
  2. Shifting the *whole* book let a strategy buy, push both sides up, then sell back into the bids its own buying had raised. Now only the side that was eaten moves.

  Tests now check that a round trip through the book, or a pump followed by a resting sell, never beats the website, and that push cost is never negative.
- **λ is plausible:** vouchers come out at about 0.098 coins per unit, which matches 1 coin of price walked per ~12.5 lots at the best level.

## Why not K·ln Q (the earlier model)

The first version charged every taken unit K·ln Q on the website's fills (Avellaneda & Stoikov 2008, eq. 11; K was fitted the same way as λ, against ln Q). We dropped it because the competition data contradicts it:

- Bot trades are 1–3 lots, uniform rather than power-law.
- The price move after a trade doesn't depend on its size.
- Every options take fit inside the best level, yet K·ln Q charged 2.5 coins per unit for levels never touched.
- The paper itself uses ln Q only to derive how often resting quotes fill, not as a cost on its own orders.
- It also had no feedback: the strategy traded exactly as on the website and just paid more.

`tools/stress.py` reports each strategy under both models.

## References

- Obizhaeva, A. & Wang, J. (2013). Optimal trading strategy and supply/demand dynamics. *Journal of Financial Markets* 16(1).
- Bouchaud, J.-P., Gefen, Y., Potters, M. & Wyart, M. (2004). Fluctuations and response in financial markets. *Quantitative Finance* 4(2).
- Gatheral, J. (2010). No-dynamic-arbitrage and market impact. *Quantitative Finance* 10(7).
- Alfonsi, A., Fruth, A. & Schied, A. (2010). Optimal execution strategies in limit order books with general shape functions. *Quantitative Finance* 10(2).
- Moallemi, C. & Sağlam, M. (2013). The cost of latency in high-frequency trading. *Operations Research* 61(5).
- Tóth, B., Eisler, Z. & Bouchaud, J.-P. (2016). The square-root impact law also holds for option markets. arXiv:1602.03043.
- Said, E., Bel Hadj Ayed, A., Husson, A. & Abergel, F. (2018). Market impact: a systematic study of limit orders. arXiv:1802.08502.
- Bucci, F., Benzaquen, M., Lillo, F. & Bouchaud, J.-P. (2019). Slow decay of impact in equity markets: insights from the ANcerno database. arXiv:1901.05332.
- Avellaneda, M. & Stoikov, S. (2008). High-frequency trading in a limit order book. *Quantitative Finance* 8(3). (The earlier K·ln Q model.)
