// Live tests: they hit TradingView through the sidecar, so they need network access.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../src/server.mjs';

let base;
before(async () => { await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.closeAllConnections(); server.close(); setTimeout(() => process.exit(0), 200).unref(); });
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

test('health', async () => { const { status, body } = await get('/health'); assert.equal(status, 200); assert.equal(body.ok, true); });

test('daily candles are ascending OHLC with sane invariants', async () => {
  const { status, body } = await get('/candles?symbol=SSE:510300&timeframe=D&count=200');
  assert.equal(status, 200);
  assert.equal(body.candles.length, 200);
  for (let i = 0; i < body.candles.length; i++) {
    const c = body.candles[i];
    assert.ok(c.high >= Math.max(c.open, c.close) - 1e-9 && c.low <= Math.min(c.open, c.close) + 1e-9, `bar ${i} OHLC`);
    if (i) assert.ok(c.time > body.candles[i - 1].time, 'ascending time');
  }
});

test('paging with `to` returns strictly older bars', async () => {
  const a = (await get('/candles?symbol=SSE:510300&timeframe=D&count=100')).body.candles;
  const b = (await get(`/candles?symbol=SSE:510300&timeframe=D&count=100&to=${a[0].time - 1}`)).body.candles;
  assert.ok(b.length > 0 && b.at(-1).time < a[0].time);
});

test('intraday timeframe', async () => {
  const { body } = await get('/candles?symbol=NASDAQ:AAPL&timeframe=5&count=50');
  assert.equal(body.candles.length, 50);
  const gaps = body.candles.slice(1).map((c, i) => c.time - body.candles[i].time);
  assert.ok(gaps.filter(g => g === 300).length > 40, 'mostly 5-minute spacing');
});

test('search finds the CSI300 ETF', async () => {
  const { body } = await get('/search?q=510300');
  assert.ok(body.results.some(r => r.id === 'SSE:510300'));
});

test('unknown symbol maps to 404', async () => {
  const { status, body } = await get('/candles?symbol=NOPE:ZZZZZZ&timeframe=D&count=5');
  assert.equal(status, 404, JSON.stringify(body));
});

test('built-in RSI study is served', async () => {
  const { status, body } = await get('/indicator?symbol=SSE:510300&timeframe=D&indicator=RSI@tv-basicstudies-241&count=100');
  assert.equal(status, 200, JSON.stringify(body));
  const v = body.values.at(-1).plot_0;
  assert.ok(v > 0 && v < 100);
});

test('candle stream emits a bars event', async () => {
  const ctl = new AbortController();
  const r = await fetch(base + '/stream/candles?symbol=BINANCE:BTCUSDT&timeframe=1', { signal: ctl.signal });
  const reader = r.body.getReader();
  let text = '';
  const deadline = Date.now() + 20000;
  while (!text.includes('event: bars') && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
  ctl.abort();
  assert.ok(text.includes('event: bars'));
});
