// Typed client for the FastAPI server.
import type { Bar } from './indicators';
import type { RunOverlay } from './chart/view';

export interface BarsResponse { symbol: string; timeframe: string; source: 'tradingview' | 'local' | 'quantifi'; bars: Bar[] }
export interface SearchResult { id: string; symbol: string; description: string; exchange: string; type: string; source: string }
export interface Watchlist { id: number; name: string; symbols: string[] }
export interface LayoutMeta { id: number; name: string; updated: number }
export interface Alert {
  id: number; symbol: string; timeframe: string; condition: Record<string, unknown>; trigger: string;
  message: string; active: boolean; description: string; last_fired: number | null; expires: number | null;
}
export interface AlertLog { id: number; alert_id: number; fired_at: number; bar_time: number; value: number; message: string }
export interface InstrumentOp { date: string; action: 'buy' | 'add' | 'trim' | 'sell' | 'open' | 'short' | 'short_add' | 'cover_trim' | 'cover' | 'dayend';
  qty: number; price: number; value: number; position: number; cum_pnl: number; trip_pnl: number | null; time?: number; kind?: string }
export interface InstrumentTrip { entry_date: string; entry_time?: number; exit_time?: number; side?: 'long' | 'short'; entry_price: number; qty: number; exit_date: string; exit_price: number; pnl: number; return_pct: number | null; days: number; open: boolean; max_value: number; runup: number; drawdown: number; stale: boolean }
export interface InstrumentDetail {
  instrument: string; symbol: string; name: string;
  summary: { pnl: number; trips: number; closed: number; wins: number; losses: number; win_rate: number | null; avg_return: number | null; best: number; worst: number;
    days_held: number; first: string; last: string; buys: number; sells: number; bought_value: number; sold_value: number; open_qty: number; open_value: number; open_pnl: number };
  trips: InstrumentTrip[]; operations: InstrumentOp[]; pnl_path: [string, number][];
  /** QuantiFi runs: intraday times, so the curve comes as unix seconds instead of dates. */
  kind?: 'quantifi'; pnl_series?: { time: number[]; value: number[] }; lambda?: number | null; push_cost?: number;
}
export interface RunSummary { id: string; market: 'cn' | 'us' | 'quantifi'; pool: string; folder: string; name: string; signal: string; topk: number; sharpe: number; annual_return: number; max_drawdown: number; start: string; end: string;
  pnl?: number; max_drawdown_coins?: number }
export interface Trade { date: string; instrument: string; symbol: string; side: 'buy' | 'sell'; price: number | null }
export interface Run {
  id: string; summary: Record<string, number | string | null>;
  series: { time: number[]; nav: number[]; bench: number[]; drawdown: number[] };
  trades: Trade[]; instruments: { instrument: string; symbol: string; name: string }[];
  holdings_last: { symbol: string; weight: number; name: string }[];
}
export interface Job { id: string; status: 'running' | 'done' | 'error'; run_id?: string; error?: string; summary?: Record<string, number> }
export interface QuantifiStrategy { path: string; slug: string; label: string; group: string }
/** Stress slider stops: push half-life in ticks (null = never decays), liquidity share, delay in ticks. */
export interface StressStops { half_life: (number | null)[]; share: number[]; delay: number[] }
export interface StressInfo { half_life: number | null; share: number; delay: number; label: string }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init });
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail ?? detail; } catch { /* not json */ }
    throw new Error(`${r.status} ${detail}`);
  }
  return r.json() as Promise<T>;
}
const qs = (p: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const api = {
  health: () => req<{ ok: boolean; sidecar: boolean }>('/api/health'),
  bars: (symbol: string, timeframe: string, count = 600, to?: number, source = 'auto', adjustment?: 'splits' | 'dividends') =>
    req<BarsResponse>(`/api/bars?${qs({ symbol, timeframe, count, to, source, adjustment: adjustment === 'dividends' ? adjustment : undefined })}`),
  search: (q: string) => req<{ results: SearchResult[] }>(`/api/search?${qs({ q })}`).then(r => r.results),
  symbol: (symbol: string) => req<Record<string, string | number | null>>(`/api/symbol?${qs({ symbol })}`),
  details: (symbol: string) => req<Details>(`/api/details?${qs({ symbol })}`),

  watchlists: () => req<Watchlist[]>('/api/watchlists'),
  createWatchlist: (name: string, symbols: string[] = []) => req<Watchlist>('/api/watchlists', json('POST', { name, symbols })),
  updateWatchlist: (id: number, patch: Partial<Watchlist>) => req<Watchlist>(`/api/watchlists/${id}`, json('PATCH', patch)),
  deleteWatchlist: (id: number) => req(`/api/watchlists/${id}`, { method: 'DELETE' }),

  layouts: () => req<LayoutMeta[]>('/api/layouts'),
  layout: (id: number) => req<{ id: number; name: string; state: LayoutState }>(`/api/layouts/${id}`),
  saveLayout: (name: string, state: LayoutState, id?: number) => req<{ id: number; name: string }>('/api/layouts', json('POST', { name, state, id })),
  deleteLayout: (id: number) => req(`/api/layouts/${id}`, { method: 'DELETE' }),
  getSetting: <T>(key: string) => req<{ value: T }>(`/api/settings/${key}`).then(r => r.value),
  setSetting: (key: string, value: unknown) => req(`/api/settings/${key}`, json('PUT', { value })),

  alerts: () => req<Alert[]>('/api/alerts'),
  createAlert: (a: { symbol: string; timeframe: string; condition: unknown; trigger: string; message?: string; expires?: number }) =>
    req<Alert>('/api/alerts', json('POST', a)),
  updateAlert: (id: number, patch: Partial<Alert>) => req<Alert>(`/api/alerts/${id}`, json('PATCH', patch)),
  deleteAlert: (id: number) => req(`/api/alerts/${id}`, { method: 'DELETE' }),
  alertLog: () => req<AlertLog[]>('/api/alerts/log'),
  checkAlerts: () => req<{ fired: AlertLog[] }>('/api/alerts/check', { method: 'POST' }),

  btPools: () => req<{ pools: string[]; builtin_signals: string[] }>('/api/backtest/pools'),
  btSignals: (pool: string) => req<{ builtin: string[]; files: string[] }>(`/api/backtest/signals?${qs({ pool })}`),
  btInstrument: (run: string, instrument: string) =>
    req<InstrumentDetail>(`/api/backtest/instrument?${qs({ run, instrument })}`),
  btRuns: (pool?: string, q = '') => req<RunSummary[]>(`/api/backtest/runs?${qs({ pool, q })}`),
  btRun: (id: string) => req<Run>(`/api/backtest/runs/${id.split('/').map(encodeURIComponent).join('/')}`),
  btReport: (id: string) =>
    req<Report>(`/api/backtest/report/${id.split('/').map(encodeURIComponent).join('/')}`),
  btStart: (params: Record<string, unknown>) => req<Job>('/api/backtest', json('POST', params)),
  btJob: (id: string) => req<Job>(`/api/backtest/jobs/${id}`),
  btOverlay: (run: string, product: string) => req<RunOverlay>(`/api/backtest/overlay?${qs({ run, product })}`),
  qfStrategies: () => req<QuantifiStrategy[]>('/api/quantifi/strategies'),
  qfRun: (strategy: string) => req<Job>('/api/quantifi/run', json('POST', { strategy })),
  qfJob: (id: string) => req<Job>(`/api/quantifi/jobs/${id}`),
  qfStressStops: () => req<StressStops>('/api/quantifi/stress-stops'),
  /** A stress scenario of a website run: done at once when replayed before, otherwise a job to poll with qfJob. */
  qfScenario: (run: string, half_life: number | null, share: number, delay: number) =>
    req<Job>('/api/quantifi/scenario', json('POST', { run, half_life, share, delay })),

  strategies: () => req<{ builtin: StrategyMeta[]; user: { id: number; name: string; updated: number }[]; error: string | null }>('/api/strategies'),
  strategySource: (id: string) => req<{ id: string; source: string }>(`/api/strategies/source?${qs({ id })}`),
  saveScript: (name: string, source: string, id?: number) => req<{ id: number; name: string }>('/api/strategies/scripts', json('POST', { name, source, id })),
  deleteScript: (id: number) => req(`/api/strategies/scripts/${id}`, { method: 'DELETE' }),
  optimize: (body: Record<string, unknown>) => req<OptJob>('/api/strategy/optimize', json('POST', body)),
  optimizeJob: (id: string) => req<OptJob>(`/api/strategy/optimize/${id}`),
  optimizeCancel: (id: string) => req(`/api/strategy/optimize/${id}`, { method: 'DELETE' }),
  exportStrategy: (script: StrategyRef, values: Record<string, unknown>) => req<{ source: string; name: string }>('/api/strategy/export', json('POST', { script, values })),
  runStrategy: (body: { symbol: string; timeframe: string; script: StrategyRef; inputs?: Record<string, unknown>; props?: Partial<StrategyProps>; count?: number; adjustment?: string }) =>
    req<StrategyRun>('/api/strategy/run', json('POST', body)),
};

export interface StrategyMeta { id: string; name: string; version: string; supported: boolean | null }
export interface StrategyRef { id?: string; source?: string; name?: string }
export interface StrategyProps {
  initial_capital: number; default_qty_type: string; default_qty_value: number; pyramiding: number; commission_type: string;
  commission_value: number; slippage: number; margin_long: number; margin_short: number; process_orders_on_close: boolean;
  close_entries_rule: string; risk_free_rate: number;
}
export interface InputSpec { index: number; title: string; type: string; default: unknown; options: unknown[] | null; minval: number | null; maxval: number | null; step: number | null }
export interface StrategyRun extends Report {
  chart: { markers: { time: number; side: 'buy' | 'sell'; text: string; kind: 'entry' | 'exit' }[]; plots: Record<string, (number | null)[]> };
  inputs: InputSpec[];
  props: StrategyProps;
  space: SpaceRow[];
}
export interface SpaceRow {
  title: string; type: string; default: unknown; enabled: boolean; kind: 'range' | 'choice';
  low?: number; high?: number; step?: number; choices?: unknown[];
}
export interface OptMetrics {
  trades: number; net_profit: number; return_pct: number; gross_profit: number; gross_loss: number; profit_factor: number;
  win_rate: number; max_drawdown: number; return_dd: number; sharpe: number; sortino: number;
}
export interface OptRow { params: Record<string, unknown>; is: OptMetrics; oos?: OptMetrics; value: number; fold?: number }
export interface OptJob {
  id: string; total: number; status: 'running' | 'done' | 'cancelled' | 'error'; phase: string; done: number; error: string | null;
  elapsed: number; objective: string; best: OptRow | null; leaderboard: OptRow[];
  baseline: { params: Record<string, unknown>; is: OptMetrics; oos: OptMetrics | null } | null;
  walk_forward: { folds: { fold: number; train_end: number | null; test_end: number | null; params: Record<string, unknown> | null; is: OptMetrics | null; oos: OptMetrics | null }[];
    total: { trades: number; return_pct: number | null; folds: number; profitable_folds: number; efficiency: number | null } } | null;
  split_time: (number | null)[] | null;
}
export interface StrategyState { script: StrategyRef; name: string; inputs: Record<string, unknown>; props: Partial<StrategyProps> }

export interface ChartState {
  symbol: string; timeframe: string; chartType?: string; adjustment?: 'splits' | 'dividends';
  studies: { id: string; inputs: Record<string, number | string>; visible?: boolean }[];
  compare?: string[];
  strategy?: StrategyState | null;
  drawings: Record<string, unknown[]>;   // per symbol
}
export interface LayoutSync { symbol: boolean; interval: boolean; crosshair: boolean; time: boolean }
export interface LayoutState { grid: GridMode; active: number; charts: ChartState[]; watchlistId?: number; sync?: LayoutSync }
export type GridMode = '1' | '2h' | '2v' | '3h' | '3v' | '4';

export interface Details {
  symbol: string; short_name: string; exchange: string; description: string; local_description: string | null;
  type: string | null; sector: string | null; industry: string | null; currency: string | null;
  last: number | null; change: number | null; change_pct: number | null; volume: number | null;
  open: number | null; high: number | null; low: number | null; prev_close: number | null;
  dividends_yield: number | null; beta_1y: number | null; market_cap: number | null; pe_ttm: number | null;
  session: { status: string | null; label: string | null; delayed_minutes: number | null };
  stats: { avg_volume_30d?: number; high_52w?: number; low_52w?: number; performance?: Record<string, number | null> };
  source: string;
}

export interface ReportTrade {
  n: number; instrument: string; symbol: string; name: string; side?: 'long' | 'short'; entry_label?: string; exit_label?: string;
  entry_time?: number; exit_time?: number; entry_date: string; entry_price: number; qty: number;
  exit_date: string; exit_price: number; pnl: number; return_pct: number; bars: number; open: boolean;
  max_value: number; stale: boolean; runup: number; drawdown: number;
}
export interface PeriodRow { period: string; strategy: number; benchmark: number }
export interface Report {
  meta: { kind?: 'pine' | 'quantifi'; symbol?: string; timeframe?: string; source?: string; name: string; start: string; end: string; initial_capital: number; currency: string; pool: string | null; signal: string | null;
    topk: number | null; rebalance_days: number | null; open_cost: number | null; close_cost: number | null; benchmark: string | null; config: Record<string, unknown> };
  key_stats: { total_pnl: number; total_pnl_pct: number; max_drawdown: number; max_drawdown_pct: number; profitable_pct: number | null;
    wins: number; closed_trades: number; profit_factor: number | null };
  series: { time: number[]; pnl: number[]; buy_hold_pnl: number[]; drawdown: number[]; drawdown_pct: number[] };
  breakdown: { gross_profit: number; gross_loss: number; commission: number; net_pnl_trades: number; unattributed: number | null;
    stale_trades: number; profits_by_instrument: { instrument: string; symbol: string; name: string; pnl: number }[];
    profits_by_side?: { Long: number; Short: number }; margin_calls?: number; max_contracts_held?: number };
  periodical: { cagr: number | null; total_return: number; sharpe: number | null; sortino: number | null;
    monthly: PeriodRow[]; quarterly: PeriodRow[]; yearly: PeriodRow[] };
  benchmarking: { strategy_return: number; buy_hold_return: number | null; outperformance: number | null; correlation: number | null };
  growth_decline: { avg_runup_days: number | null; avg_drawdown_days: number | null; max_drawdown_of_initial: number | null;
    runup: { max: number | null; avg: number | null }; drawdown: { max: number | null; avg: number | null; current: number | null };
    runups: { start: string; end: string; pct: number; days: number }[];
    drawdowns: { start: string; end: string; pct: number; days: number; recovered: string | null }[] };
  distribution: { expectancy: number | null; expectancy_pct: number | null; largest_profit: number | null; largest_loss: number | null;
    avg_profit_pct: number | null; avg_loss_pct: number | null; winners: number; losers: number; breakevens: number; open: number;
    histogram: { edges: number[]; counts: number[] } };
  streaks: { max_win: number; max_loss: number; avg_win: number; avg_loss: number };
  time_patterns: { by_entry_weekday: { key: string; avg_return: number | null; trades: number }[];
    by_month: { key: string; avg_daily_return: number | null }[] };
  trades: ReportTrade[];
  quantifi?: QuantifiInfo;
}

/** QuantiFi replay (tools/backtest.py): money in coins, no capital base. A stress scenario carries `stress` and the
 * website run it was made from in `website`. */
export interface QuantifiInfo {
  stress: StressInfo | null; label: string; path: string; created: string; seconds: number; days: number[]; tte: Record<string, number>;
  sharpe: number | null; sortino: number | null; fills: number; volume: number; taken_fills: number; resting_fills: number;
  taken_volume: number; push_cost: number; rejected: number; errors: number; first_error: string;
  website: { run: string; total_pnl: number; max_drawdown: number; sharpe: number | null; fills: number | null;
    series: { time: number[]; pnl: number[] } } | null;
  by_day: { day: number; pnl: number; fills: number }[];
  lambda: Record<string, number | null>; constants: Record<string, number>; has_greeks: boolean;
  day_bounds: { day: number; start: number; end: number }[];
  greeks?: { time: number[]; spot: number[]; opt_delta: number[]; lychee: number[]; net_delta: number[]; gamma: number[]; vega: number[]; theta: number[] };
}

/** Server-sent events with automatic reconnect; returns a closer. */
export function subscribe(path: string, handlers: Record<string, (data: any) => void>): () => void {
  let es: EventSource | null = null, closed = false, retry = 1000;
  const open = () => {
    if (closed) return;
    es = new EventSource(path);
    for (const [ev, fn] of Object.entries(handlers)) es.addEventListener(ev, e => fn(JSON.parse((e as MessageEvent).data)));
    es.onopen = () => { retry = 1000; };
    es.onerror = () => { es?.close(); if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 30000))); };
  };
  open();
  return () => { closed = true; es?.close(); };
}
