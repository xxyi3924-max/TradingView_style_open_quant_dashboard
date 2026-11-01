// TradingView market-data sidecar: wraps @mathieuc/tradingview behind a small HTTP + SSE API
// consumed by the Python server. One shared websocket client for candles/quotes/search,
// recreated on disconnect; indicator studies run on their own short-lived connection,
// one at a time (anonymous sessions refuse concurrent studies).
import http from 'node:http';
import { URL } from 'node:url';
import {
  TradingViewClient, getCandles, getQuotes, getSymbolInfo, searchMarkets,
  getIndicatorData, searchIndicators, watchCandles, watchQuotes,
} from '@mathieuc/tradingview';

const PORT = Number(process.env.SIDECAR_PORT ?? 8787);
const credentials = process.env.TV_SESSIONID
  ? { session: process.env.TV_SESSIONID, signature: process.env.TV_SESSIONID_SIGN }
  : undefined;
const TRANSIENT = new Set(['DISCONNECTED', 'CONNECTION_ERROR', 'TIMEOUT', 'PROTOCOL_ERROR']);

let client = null;
function sharedClient() {
  if (!client || client.isClosed) client = new TradingViewClient({ credentials });
  return client;
}
async function withClient(fn) {
  try {
    return await fn(sharedClient());
  } catch (e) {
    if (!TRANSIENT.has(e?.code)) throw e;
    await client?.close().catch(() => {});
    client = null;
    return fn(sharedClient()); // one retry on a fresh connection
  }
}

let studyQueue = Promise.resolve();
function serialStudy(fn) {
  const run = studyQueue.then(fn, fn);
  studyQueue = run.catch(() => {});
  return run;
}

// fields streamed to the watchlist and the details card
const QUOTE_FIELDS = ['lp', 'ch', 'chp', 'volume', 'lp_time', 'description', 'current_session', 'update_mode',
  'prev_close_price', 'open_price', 'high_price', 'low_price', 'bid', 'ask', 'currency_code', 'exchange', 'type'];

const num = (v, d) => (v === null || v === undefined || v === '' ? d : Number(v));

const routes = {
  async '/health'() {
    return { ok: true, connected: Boolean(client && client.isOpen), authenticated: Boolean(credentials) };
  },
  async '/candles'(q) {
    const symbol = q.get('symbol');
    const timeframe = q.get('timeframe') ?? 'D';
    const query = { symbol, timeframe, count: num(q.get('count'), 500), timeoutMs: 45000 };
    if (q.get('to')) query.to = Number(q.get('to'));
    if (q.get('adjustment')) query.adjustment = q.get('adjustment');
    const candles = await withClient(c => getCandles({ ...query, client: c }));
    return { symbol, timeframe, candles };
  },
  async '/search'(q) {
    const opts = {};
    if (q.get('type')) opts.type = q.get('type');
    if (q.get('exchange')) opts.exchange = q.get('exchange');
    return { results: await searchMarkets(q.get('q') ?? '', opts) };
  },
  async '/symbol'(q) {
    return withClient(c => getSymbolInfo({ symbol: q.get('symbol'), client: c }));
  },
  async '/quotes'(q) {
    const symbols = (q.get('symbols') ?? '').split(',').filter(Boolean);
    return withClient(c => getQuotes({ symbols, client: c }));
  },
  async '/indicator'(q) {
    const query = {
      symbol: q.get('symbol'), timeframe: q.get('timeframe') ?? 'D', indicator: q.get('indicator'),
      count: num(q.get('count'), 300), timeoutMs: 30000, credentials,
    };
    if (q.get('inputs')) query.inputs = JSON.parse(q.get('inputs'));
    const r = await serialStudy(() => getIndicatorData(query));
    return { indicator: query.indicator, candles: r.candles, values: r.values };
  },
  async '/indicators/search'(q) {
    return { results: await searchIndicators(q.get('q') ?? '') };
  },
};

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  return { send, ping };
}

const streams = {
  async '/stream/candles'(q, req, res) {
    const { send, ping } = sse(res);
    const watcher = await watchCandles(
      { symbol: q.get('symbol'), timeframe: q.get('timeframe') ?? 'D', count: 2, client: sharedClient() },
      { onData: c => send('bars', c), onError: e => send('error', { code: e.code, message: e.message }) },
    );
    req.on('close', () => { clearInterval(ping); watcher.stop(); });
  },
  async '/stream/quotes'(q, req, res) {
    const { send, ping } = sse(res);
    const symbols = (q.get('symbols') ?? '').split(',').filter(Boolean);
    const watcher = await watchQuotes(
      { symbols, fields: QUOTE_FIELDS, client: sharedClient() },
      { onData: (symbol, quote) => send('quote', { symbol, ...quote }), onError: e => send('error', { code: e.code, message: e.message }) },
    );
    req.on('close', () => { clearInterval(ping); watcher.stop(); });
  },
};

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (streams[url.pathname]) return await streams[url.pathname](url.searchParams, req, res);
    const route = routes[url.pathname];
    if (!route) { res.writeHead(404).end(JSON.stringify({ error: 'not found' })); return; }
    const body = await route(url.searchParams);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  } catch (e) {
    const status = e?.code === 'SYMBOL_ERROR' || e?.code === 'NO_DATA' || e?.code === 'NOT_FOUND' ? 404
      : e?.code === 'INVALID_ARGUMENT' ? 400 : 502;
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e?.message ?? String(e), code: e?.code ?? 'INTERNAL' }));
  }
});

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, '127.0.0.1', () => console.log(`tv sidecar on http://127.0.0.1:${PORT}`));
  const shutdown = async () => { await client?.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
