// Capture TradingView's own Strategy Tester reports for the built-in strategies (parity oracle).
// Runs each strategy with its default properties on each symbol, one study at a time, using the
// TradingView session of the debug-port Chrome (needed: anonymous sessions cannot run strategies).
// Writes { id, version, symbol, timeframe, properties, inputs, candles, report } per run.
//   node src/strategy-fixtures.mjs <outDir> [symbol:tf:count ...]
import fs from 'node:fs';
import path from 'node:path';
import { getIndicator, getIndicatorData } from '@mathieuc/tradingview';
import { tradingViewSession } from './browser-cookies.mjs';

const [outDir, ...specs] = process.argv.slice(2);
const runs = (specs.length ? specs : ['SSE:510300:D:5000', 'NASDAQ:AAPL:D:5000', 'BINANCE:BTCUSDT:240:5000'])
  .map(s => { const p = s.split(':'); return { symbol: `${p[0]}:${p[1]}`, timeframe: p[2], count: Number(p[3]) }; });
const SKIP = new Set(['STD;Technical%1Ratings%1Strategy', 'STD;Rob%1Booker%1ADX%1Breakout%1Strategy']);
const list = await (await fetch('https://pine-facade.tradingview.com/pine-facade/list?filter=standard')).json();
const strategies = list.filter(x => x.extra?.kind === 'strategy' && !SKIP.has(x.scriptIdPart) && !/Rob Booker|Technical ratings/i.test(x.scriptName));
const credentials = await tradingViewSession();
fs.mkdirSync(outDir, { recursive: true });
const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
for (const run of runs) {
  for (const s of strategies) {
    if (only && !only.test(s.scriptName)) continue;
    const file = path.join(outDir, `${run.symbol.replace(':', '_')}_${run.timeframe}_${s.scriptIdPart.replace(/^STD;/, '').replace(/%1/g, '_').replace(/\W/g, '_')}.json`);
    if (fs.existsSync(file) && !process.env.FORCE) continue;
    const t0 = Date.now();
    try {
      const ind = await getIndicator(s.scriptIdPart);
      const r = await getIndicatorData({ symbol: run.symbol, timeframe: run.timeframe, indicator: ind, count: run.count, credentials, timeoutMs: 90_000 });
      const inputs = Object.fromEntries(Object.values(ind.inputs).map(v => [v.internalID ?? v.name, { value: v.value, fake: !!v.isFake, name: v.name }]));
      fs.writeFileSync(file, JSON.stringify({ id: s.scriptIdPart, name: s.scriptName, version: ind.version, symbol: run.symbol, timeframe: run.timeframe,
        inputs, candles: r.candles, report: r.strategyReport }));
      console.log(`${s.scriptName} ${run.symbol} ${run.timeframe}: ${r.candles.length} bars, ${r.strategyReport.trades.length} trades (${Date.now() - t0} ms)`);
    } catch (e) {
      console.log(`${s.scriptName} ${run.symbol} ${run.timeframe}: ERROR ${e.code ?? ''} ${e.message}`);
    }
    await new Promise(res => setTimeout(res, 1500));
  }
}
process.exit(0);
