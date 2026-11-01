// Strategy report dock under the chart, laid out like TradingView's Strategy Tester (re/ui/strategy_*.json):
// header tab with the run name + collapse/maximize/close; toolbar (overview | list of trades, date range,
// initial capital, signal, execution, settings); Key stats; Performance chart; Performance analysis
// (Breakdown, Periodical, Benchmarking, Growth and decline); Trades analysis (Distribution, Streaks,
// Time patterns); List of trades. Data: /api/backtest/report/<run> computed from the qlib run files.
// QuantiFi runs (quantifi:<strategy>/<stamp>, tools/backtest.py in the hackathon repo) reuse the dock with money in coins,
// a By day tab, a Greeks view and a Stress view: sliders pick one slippage scenario (Obizhaeva-Wang linear push that refills,
// liquidity share, delay), replayed on the server and compared with the website run; a scenario opens like any run.
import {
  BaselineSeries, ColorType, HistogramSeries, LineSeries, LineStyle, TickMarkType, createChart, createSeriesMarkers, type IChartApi, type ISeriesApi, type SeriesType, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import type { App } from '../main';
import { quantifiLabel, quantifiTick, stopIndex, stopLabel } from '../chart/util';
import { api, type InstrumentDetail, type OptJob, type OptMetrics, type OptRow, type Report, type ReportTrade, type RunSummary, type SpaceRow, type StrategyRun, type StressStops } from '../api';
import { icon } from './icons';
import { openMenu } from './menu';
import { backtestDialog, esc, logo, pineScriptDialog, promptText, quantifiDialog, runsDialog, toast, type BacktestParams } from './dialogs';

type PerfTab = 'breakdown' | 'periodical' | 'benchmarking' | 'growth' | 'days';
type TradesTab = 'distribution' | 'streaks' | 'time';
const UP = '#089981', DOWN = '#F23645', GRAY = '#787B86', BLUE = '#2962FF';

const minus = (x: number) => (x < 0 ? '−' : '');
export const money = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—'
  : `${minus(x)}${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const pct = (x: number | null | undefined, d = 2, plus = false) => (x === null || x === undefined || !Number.isFinite(x) ? '—'
  : `${x < 0 ? '−' : plus && x > 0 ? '+' : ''}${Math.abs(x * 100).toFixed(d)}%`);
const compact = (x: number) => {
  const a = Math.abs(x);
  return a >= 1e9 ? `${x / 1e9} B` : a >= 1e6 ? `${x / 1e6} M` : a >= 1e3 ? `${x / 1e3} K` : String(x);
};
const cls = (x: number | null | undefined) => (x === null || x === undefined ? '' : x > 0 ? 'up' : x < 0 ? 'down' : '');
const date = (s: string) => (s.startsWith('Day') ? s : s.length > 10
  ? new Date(`${s.replace(' ', 'T')}:00Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
  : new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }));
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
/** Axis labels like TradingView's strategy charts: 62.37 M, -1.25 M, 850.00 K. */
const axisMoney = (p: number) => {
  const a = Math.abs(p), sgn = p < 0 ? '−' : '';
  return a >= 1e9 ? `${sgn}${(a / 1e9).toFixed(2)} B` : a >= 1e6 ? `${sgn}${(a / 1e6).toFixed(2)} M` : a >= 1e3 ? `${sgn}${(a / 1e3).toFixed(2)} K` : `${sgn}${a.toFixed(2)}`;
};
const PNL_ROWS = 20;

export class StrategyDock {
  open = false;
  runId: string | null = null;
  report: Report | null = null;
  view: 'overview' | 'trades' | 'optimize' | 'instruments' | 'greeks' | 'stress' = 'overview';
  /** 'qlib': a portfolio backtest run; 'pine': the active chart's Pine strategy (Strategy Tester); 'quantifi': a hackathon replay. */
  kind: 'qlib' | 'pine' | 'quantifi' = 'qlib';
  /** QuantiFi stress view: the slider stops (from the server), the picked values and the scenario last replayed. */
  private stops: StressStops | null = null;
  private stressPick: { h: number | null; s: number; d: number } = { h: 100, s: 0.5, d: 0 };
  private scenario: { key: string; label: string; status: 'running' | 'done' | 'error'; since: number; runId?: string; report?: Report; error?: string } | null = null;
  /** QuantiFi runs: the product on the upper chart (its book at tick level, fills, quotes, position, indicators). */
  private chartProduct: string | null = null;
  private pending: string | null = null;
  private opt: OptState | null = null;
  /** Instruments view: list filter and the instrument opened in it (null = the list). */
  private instFilter: 'all' | 'earned' | 'lost' = 'all';
  private instQuery = '';
  private inst: { id: string; data: InstrumentDetail | null; error?: string } | null = null;
  private instTab: 'overview' | 'trips' | 'ops' = 'overview';
  private optTimer = 0;
  private perfTab: PerfTab = 'breakdown';
  private tradesTab: TradesTab = 'distribution';
  private freq: 'monthly' | 'quarterly' | 'yearly' = 'monthly';
  private pnlBy: 'instrument' | 'side' | 'year' = 'instrument';
  private pnlAll = false;
  private show = { pnl: true, buyhold: false, excursions: true, runups: true };
  private sortAsc = false;
  private charts: IChartApi[] = [];
  private barSpecs = new Map<string, BarSpec>();
  private barSeq = 0;
  private resizeObs = new ResizeObserver(() => this.flushBars());
  private runs: RunSummary[] | null = null;
  private running: { since: number; label: string } | null = null;
  private height = 360;

  constructor(private el: HTMLElement, private resizer: HTMLElement, private center: HTMLElement, private app: App) {
    try {
      this.height = Number(localStorage.getItem('dock_height')) || 360;
      this.stressPick = { ...this.stressPick, ...JSON.parse(localStorage.getItem('qf_stress') || '{}') };
    } catch { /* ignore */ }
    el.addEventListener('click', e => this.onClick(e));
    el.addEventListener('input', e => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.st) { this.pickStress(t.dataset.st as 'h' | 's', Number(t.value)); return; }
      if (t.dataset.instq === undefined) return;
      this.instQuery = t.value;
      this.render();
      const box = this.el.querySelector<HTMLInputElement>('[data-instq]');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    });
    this.resizeObs.observe(el);
    this.bindResize();
    this.render();
  }

  // ---------------------------------------------------------------- open / close / size
  toggle(force?: boolean) {
    this.open = force ?? !this.open;
    this.el.hidden = !this.open;
    this.resizer.hidden = !this.open;
    if (!this.open) this.setMax(false);
    this.el.style.height = `${this.height}px`;
    this.app.widgets?.sync();
    if (this.open) this.render();
  }
  private setMax(max: boolean) {
    this.el.classList.toggle('max', max);
    this.center.classList.toggle('dock-max', max);
    if (max) this.el.classList.remove('collapsed');
  }
  private bindResize() {
    this.resizer.addEventListener('pointerdown', e => {
      const y0 = e.clientY, h0 = this.el.offsetHeight;
      const move = (ev: PointerEvent) => {
        this.height = Math.max(120, Math.min(this.center.offsetHeight - 120, h0 - (ev.clientY - y0)));
        this.el.style.height = `${this.height}px`;
        this.el.classList.remove('collapsed');
      };
      const up = () => { document.removeEventListener('pointermove', move); try { localStorage.setItem('dock_height', String(this.height)); } catch { /* ignore */ } };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up, { once: true });
    });
  }

  // ---------------------------------------------------------------- data
  async loadRun(id: string) {
    this.kind = id.startsWith('quantifi:') ? 'quantifi' : 'qlib';
    this.chartProduct = null;
    this.inst = null;
    this.pending = null;
    this.runId = id;
    this.report = null;
    this.toggle(true);
    this.render();
    try {
      this.report = await api.btReport(id);
    } catch (e) {
      toast(`Strategy report failed: ${esc((e as Error).message)}`);
    }
    this.render();
    if (this.report) this.app.setStrategyTrades(this.report);
    if (this.report?.meta.kind === 'quantifi') void this.showProduct(this.topProduct(this.report));
  }

  /** The product that moved the run's PnL most (either way): what the upper chart opens on. */
  private topProduct(r: Report): string | null {
    const rows = [...r.breakdown.profits_by_instrument].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
    return rows[0]?.instrument ?? null;
  }
  /** Put one product of the QuantiFi run on the upper chart, leaving the dock where it is. */
  private async showProduct(product: string | null) {
    const r = this.report, run = this.runId;
    if (!product || !r || !run || r.meta.kind !== 'quantifi') return;
    this.chartProduct = product;
    try {
      const d = await api.btInstrument(run, product);
      if (this.runId !== run || this.chartProduct !== product || this.report !== r) return;
      await this.app.showRunInstrument(d, r);
    } catch (e) {
      toast(`${esc(product)}: ${esc((e as Error).message)}`);
    }
  }

  // ---------------------------------------------------------------- QuantiFi stress scenarios
  /** The website run the stress view works from: the open run, or the run an open scenario was made from. */
  private websiteRun(): string | null {
    const q = this.report?.quantifi;
    return q ? (q.stress ? q.website?.run ?? null : this.runId) : null;
  }
  private stressKey() {
    const p = this.stressPick;
    return `${this.websiteRun()}|${p.h}|${p.s}|${p.d}`;
  }
  private stressName(h: number | null, s: number, d: number) {
    return `h ${stopLabel(h)} · ${Math.round(s * 100)}% liquidity · ${d} tick${d === 1 ? '' : 's'} delay`;
  }
  /** A slider moved: remember the stop and update its label in place (no re-render, so dragging stays smooth). */
  private pickStress(which: 'h' | 's', i: number) {
    const st = this.stops;
    if (!st) return;
    if (which === 'h') this.stressPick.h = st.half_life[i] ?? null; else this.stressPick.s = st.share[i] ?? 1;
    try { localStorage.setItem('qf_stress', JSON.stringify(this.stressPick)); } catch { /* ignore */ }
    const lab = this.el.querySelector<HTMLElement>(`[data-stv="${which}"]`);
    if (lab) lab.textContent = which === 'h' ? this.halfLifeText(this.stressPick.h) : `${Math.round(this.stressPick.s * 100)}%`;
    const run = this.el.querySelector<HTMLButtonElement>('[data-a="st-run"]');
    if (run) run.textContent = this.scenario?.key === this.stressKey() && this.scenario.status === 'done' ? 'Replayed' : 'Run scenario';
  }
  private halfLifeText(h: number | null) {
    return h === null ? 'never fades' : h === 0 ? '0 (gone next tick)' : `${stopLabel(h)} tick${h === 1 ? '' : 's'}`;
  }

  /** Replay the picked scenario of the website run on the server (or reuse it), then show it beside the website run. */
  private async runScenario() {
    const base = this.websiteRun(), p = { ...this.stressPick }, key = this.stressKey();
    if (!base || this.scenario?.status === 'running') return;
    this.scenario = { key, label: this.stressName(p.h, p.s, p.d), status: 'running', since: Date.now() };
    this.render();
    const tick = window.setInterval(() => {
      const el = this.el.querySelector('[data-st-progress]');
      if (el && this.scenario) el.textContent = `Replaying… ${Math.round((Date.now() - this.scenario.since) / 1000)}s`;
    }, 1000);
    try {
      let job = await api.qfScenario(base, p.h, p.s, p.d);
      while (job.status === 'running') {
        await new Promise(r => setTimeout(r, 1000));
        job = await api.qfJob(job.id);
      }
      if (job.status === 'error' || !job.run_id) throw new Error(job.error?.slice(-300) || 'replay failed');
      const report = await api.btReport(job.run_id);
      if (this.scenario?.key === key) this.scenario = { ...this.scenario, status: 'done', runId: job.run_id, report };
    } catch (e) {
      if (this.scenario?.key === key) this.scenario = { ...this.scenario, status: 'error', error: (e as Error).message };
    } finally {
      clearInterval(tick);
      if (this.view === 'stress') this.render();
    }
  }

  /** Pick a strategy file, replay it with tools/backtest.py on the server, then open the run. */
  async newQuantifiRun() {
    let list;
    try { list = await api.qfStrategies(); } catch (e) { toast(`QuantiFi strategies unavailable: ${esc((e as Error).message)}`); return; }
    const pick = await quantifiDialog(list);
    if (!pick) return;
    this.toggle(true);
    this.running = { since: Date.now(), label: pick.label };
    this.render();
    const tick = window.setInterval(() => this.renderHead(), 1000);
    try {
      let job = await api.qfRun(pick.path);
      while (job.status === 'running') {
        await new Promise(r => setTimeout(r, 1000));
        job = await api.qfJob(job.id);
      }
      if (job.status === 'error') { toast(`QuantiFi run failed: ${esc(job.error?.slice(-300))}`, 15000); return; }
      this.runs = null;
      toast(`${esc(pick.label)}: PnL ${money(job.summary?.pnl, 0)} · max drawdown ${money(job.summary?.max_drawdown, 0)}`);
      await this.loadRun(job.run_id!);
    } catch (e) {
      toast(`QuantiFi run failed: ${esc((e as Error).message)}`);
    } finally {
      clearInterval(tick);
      this.running = null;
      this.render();
    }
  }

  async run(params: BacktestParams) {
    this.toggle(true);
    this.running = { since: Date.now(), label: `${params.pool} · ${params.signal ?? params.signal_file?.split('/').pop()}` };
    this.render();
    const tick = window.setInterval(() => this.renderHead(), 1000);
    try {
      let job = await api.btStart(params as unknown as Record<string, unknown>);
      while (job.status === 'running') {
        await new Promise(r => setTimeout(r, 1500));
        job = await api.btJob(job.id);
      }
      if (job.status === 'error') { toast(`Backtest failed: ${esc(job.error?.slice(-300))}`, 15000); return; }
      this.runs = null;
      toast(`Backtest done: Sharpe ${job.summary?.sharpe?.toFixed(2) ?? '—'}`);
      await this.loadRun(job.run_id!);
    } catch (e) {
      toast(`Backtest failed: ${esc((e as Error).message)}`);
    } finally {
      clearInterval(tick);
      this.running = null;
      this.render();
    }
  }

  /** A Pine strategy is (re)running on the active chart. */
  showPending(name: string) {
    this.kind = 'pine';
    this.pending = name;
    this.report = null;
    this.runId = null;
    this.toggle(true);
  }
  /** Show the active chart's Pine strategy report (null: the chart has no strategy). */
  showStrategy(run: StrategyRun | null, name?: string, open = false) {
    if (!run && this.kind !== 'pine') return;
    this.kind = 'pine';
    this.pending = null;
    this.runId = null;
    this.report = run;
    if (run && name) run.meta.name = name;
    if (open) this.toggle(true); else if (this.open) this.render();
  }

  private paramsFromReport(): Partial<BacktestParams> {
    const m = this.report?.meta;
    if (!m || m.kind === 'pine') return {};
    const cfg = m.config as Record<string, unknown>;
    const sigFile = typeof cfg.signal_file === 'string' ? (cfg.signal_file as string).replace(/^.*?Work_Quant\//, '') : undefined;
    return { pool: m.pool ?? undefined, signal: sigFile ? undefined : m.signal ?? undefined, signal_file: sigFile, topk: m.topk ?? undefined,
      rebalance_days: m.rebalance_days ?? undefined, start: m.start, open_cost: m.open_cost ?? undefined, close_cost: m.close_cost ?? undefined,
      account: m.initial_capital };
  }
  async newBacktest(initial: Partial<BacktestParams> = this.paramsFromReport()) {
    const p = await backtestDialog(initial);
    if (p) await this.run(p);
  }

  // ---------------------------------------------------------------- rendering
  render() {
    if (this.el.querySelector('[data-o]')) this.readOptForm();      // keep unsaved optimiser settings
    this.charts.forEach(c => c.remove());
    this.charts = [];
    this.barSpecs.clear();
    const r = this.report;
    this.el.innerHTML = `<div class="dk-head"></div><div class="dk-body">${r ? `${this.toolsHtml(r)}<div data-content></div>` : this.emptyHtml()}</div>`;
    this.renderHead();
    if (!r) return;
    const c = this.el.querySelector<HTMLElement>('[data-content]')!;
    if (this.view === 'optimize' && r.meta.kind !== 'pine') this.view = 'overview';
    if (this.view === 'instruments' && r.meta.kind === 'pine') this.view = 'overview';
    const qf = r.meta.kind === 'quantifi';
    if (this.view === 'greeks' && !r.quantifi?.greeks) this.view = 'overview';
    if (this.view === 'greeks') { c.innerHTML = this.greeksHtml(r); this.greeksCharts(r); return; }
    if (this.view === 'stress' && !qf) this.view = 'overview';
    if (this.view === 'stress') { c.innerHTML = this.stressHtml(r); this.stressChart(); if (!this.stops) void this.loadStops(); return; }
    if (qf && !['breakdown', 'days'].includes(this.perfTab)) this.perfTab = 'breakdown';
    if (!qf && this.perfTab === 'days') this.perfTab = 'breakdown';
    if (qf && this.tradesTab === 'time') this.tradesTab = 'distribution';
    if (this.view === 'instruments') { c.innerHTML = this.inst ? this.instrumentHtml(r) : this.instrumentsHtml(r); if (this.inst && this.instTab === 'overview') this.instrumentChart(); return; }
    if (this.view === 'trades') { c.innerHTML = this.tradesHtml(r); return; }
    if (this.view === 'optimize') { c.innerHTML = this.optimizeHtml(r as StrategyRun); this.renderOptResults(); return; }
    c.innerHTML = `${this.keyStatsHtml(r)}${this.performanceHtml()}
      <div class="dk-sec"><div class="dk-h1">Performance analysis</div>${this.tabsHtml('perf', qf ? [['breakdown', 'Breakdown'], ['days', 'By day']]
        : [['breakdown', 'Breakdown'], ['periodical', 'Periodical'], ['benchmarking', 'Benchmarking'], ['growth', 'Growth and decline']], this.perfTab)}<div data-perf-body></div></div>
      <div class="dk-sec" style="padding-bottom:24px"><div class="dk-h1">Trades analysis</div>${this.tabsHtml('trades', qf ? [['distribution', 'Distribution'], ['streaks', 'Streaks']]
        : [['distribution', 'Distribution'], ['streaks', 'Streaks'], ['time', 'Time patterns']], this.tradesTab)}<div data-trades-body></div></div>`;
    this.perfChart(c.querySelector<HTMLElement>('.perf-chart')!, r);
    this.renderPerfTab();
    this.renderTradesTab();
  }

  private renderHead() {
    const head = this.el.querySelector<HTMLElement>('.dk-head');
    if (!head) return;
    const name = this.running ? `Running ${this.running.label}… ${Math.round((Date.now() - this.running.since) / 1000)}s`
      : this.pending ? `${this.pending} · running…` : this.report?.meta.name ?? (this.runId ? 'Loading…' : 'Strategy report');
    const max = this.el.classList.contains('max');
    head.innerHTML = `<div class="dk-tab" title="${esc(this.runId ?? '')}">${icon('strategy', 24)}<span class="name" data-name>${esc(name)}</span>
      <button class="caret" data-a="runs" data-tip="Open strategy report" aria-label="Open strategy report">${icon('chevronDown')}</button></div>
      <span class="spacer"></span>
      <button class="hb" data-a="collapse" data-tip="Collapse panel" aria-label="Collapse panel">${icon('minimize')}</button>
      <button class="hb" data-a="max" data-tip="${max ? 'Restore panel' : 'Maximize panel'}" aria-label="Maximize panel">${icon(max ? 'restore' : 'maximize')}</button>
      <button class="hb" data-a="close" data-tip="Close strategy report" aria-label="Close strategy report">${icon('close')}</button>`;
  }

  private emptyHtml() {
    if (this.runId && !this.report) return '<div class="dk-empty">Loading strategy report…</div>';
    if (this.pending) return `<div class="dk-empty">Running ${esc(this.pending)} on ${esc(this.app.view?.symbol ?? '')}…</div>`;
    return `<div class="dk-empty">${icon('strategy', 28)}<div>Add a Pine strategy to the chart, run a qlib backtest, or open a saved run to see its strategy report.</div>
      <div style="display:flex;gap:8px"><button class="pill-btn" data-a="add-strategy">Add strategy</button><button class="pill-btn light" data-a="new">New backtest</button>
      <button class="pill-btn light" data-a="qf-new">QuantiFi run</button><button class="pill-btn light" data-a="runs">Open saved run</button></div></div>`;
  }

  private toolsHtml(r: Report) {
    if (r.meta.kind === 'pine') return this.pineToolsHtml(r as StrategyRun);
    if (r.meta.kind === 'quantifi') return this.qfToolsHtml(r);
    const m = r.meta, sig = m.signal ?? '—';
    const exec = `Top ${m.topk ?? '—'} · ${m.rebalance_days ?? '—'}d · ${m.open_cost !== null ? (m.open_cost * 1e4).toFixed(0) : '—'}bp`;
    // US runs come from the us_stock_rotation study; the backtest launcher here runs the CN ETF engine only
    const us = this.runId?.startsWith('us:') ?? false;
    const chip = (a: string, tip: string, html: string) => (us
      ? `<span class="dk-chip static" data-tip="${tip} (US study run, read-only)">${html}</span>`
      : `<button class="dk-chip" data-a="${a}" data-tip="${tip}">${html}${icon('chevronDown')}</button>`);
    return `<div class="dk-tools">
      <div class="dk-seg"><button data-view="overview" class="${this.view === 'overview' ? 'active' : ''}" data-tip="Overview" aria-label="Overview">${icon('line', 20)}</button>
        <button data-view="trades" class="${this.view === 'trades' ? 'active' : ''}" data-tip="List of trades" aria-label="List of trades">${icon('csv', 20)}</button>
        <button data-view="instruments" class="${this.view === 'instruments' ? 'active' : ''}" data-tip="Instruments: what it earned and lost on each name" aria-label="Instruments">${icon('pool', 20)}</button></div>
      ${chip('range', 'Backtesting range', `${icon('calendar')}<span>${date(m.start)} — ${date(m.end)}</span>`)}
      ${chip('settings', 'Initial capital', `${icon('dollar')}<span>${compact(m.initial_capital)}<span class="cur">${m.currency}</span></span>`)}
      ${chip('settings', 'Pool and signal', `${icon('pool')}<span>${esc(m.pool ?? '')} · ${esc(sig)}</span>`)}
      ${chip('settings', 'Execution', `${icon('replay')}<span>${exec}</span>`)}
      <span class="dk-vsep"></span>
      ${us ? '' : `<button class="wbtn" data-a="settings" data-tip="Backtest properties" aria-label="Backtest properties">${icon('hexgear')}</button>`}
      <button class="wbtn" data-a="new" data-tip="New backtest" aria-label="New backtest">${icon('plus')}</button></div>`;
  }


  private qfToolsHtml(r: Report) {
    const q = r.quantifi!, m = r.meta;
    const seg = (v: StrategyDock['view'], tip: string, html: string) => `<button data-view="${v}" class="${this.view === v ? 'active' : ''}" data-tip="${tip}" aria-label="${tip}">${html}</button>`;
    const st = q.stress;
    return `<div class="dk-tools">
      <div class="dk-seg">${seg('overview', 'Overview', icon('line', 20))}${seg('trades', 'List of trades', icon('csv', 20))}
        ${seg('instruments', 'Products: what it earned and lost on each', icon('pool', 20))}
        ${q.has_greeks ? seg('greeks', 'Greeks: net delta, vega, gamma and theta of the option book', '<span class="greek-ico">Δ</span>') : ''}
        ${seg('stress', 'Stress test: replay with extra slippage (push, thinner book, delay)', icon('tune', 20))}</div>
      <span class="dk-chip static" data-tip="Training days replayed; each starts flat with a fresh Trader">${icon('calendar')}<span>${esc(m.start.split(' ·')[0])} — ${esc(m.end.split(' ·')[0])} · ${q.days.length} days</span></span>
      <span class="dk-chip static" data-tip="${esc(q.path)} · replayed ${esc(q.created)} in ${q.seconds}s">${icon('strategy')}<span>${esc(q.label)}</span></span>
      <span class="dk-chip static" data-tip="Fills: taken from the book · resting orders matched to market trades">${icon('replay')}<span>${q.fills.toLocaleString('en-US')} fills</span></span>
      ${st ? `<span class="dk-vsep"></span><span class="dk-chip static qf-stressed" data-tip="Stress scenario: each unit bought moves the asks up (each sold, the bids down) by λ/share, refilling with this half-life; this share of the book and of market trades; orders reach the book after this delay">${icon('tune')}<span>Stress · h ${stopLabel(st.half_life)} · ${Math.round(st.share * 100)}% · delay ${st.delay}</span></span>
        ${q.website ? `<button class="dk-chip qf-website" data-a="st-website" data-tip="Open the website run this scenario was made from">${icon('chevronLeft')}<span>Website run</span></button>` : ''}` : ''}
      <span class="dk-vsep"></span>
      <button class="wbtn" data-a="qf-new" data-tip="New QuantiFi run" aria-label="New QuantiFi run">${icon('plus')}</button></div>`;
  }

  private pineToolsHtml(r: StrategyRun) {
    const m = r.meta, p = r.props;
    const size = p.default_qty_type === 'percent_of_equity' ? `${p.default_qty_value}% of equity`
      : p.default_qty_type === 'cash_per_order' ? `${compact(p.default_qty_value)} ${m.currency} per order` : `${p.default_qty_value} contracts`;
    const comm = p.commission_type === 'percent' ? `${p.commission_value}%` : `${p.commission_value} ${m.currency}${p.commission_type === 'cash_per_contract' ? '/contract' : '/order'}`;
    return `<div class="dk-tools">
      <div class="dk-seg"><button data-view="overview" class="${this.view === 'overview' ? 'active' : ''}" data-tip="Overview" aria-label="Overview">${icon('line', 20)}</button>
        <button data-view="trades" class="${this.view === 'trades' ? 'active' : ''}" data-tip="List of trades" aria-label="List of trades">${icon('csv', 20)}</button>
        <button data-view="optimize" class="${this.view === 'optimize' ? 'active' : ''}" data-tip="Optimize inputs" aria-label="Optimize inputs">${icon('tune', 20)}</button></div>
      <span class="dk-chip static" data-tip="Backtesting range: the bars loaded on the chart">${icon('calendar')}<span>${date(m.start)} — ${date(m.end)}</span></span>
      <button class="dk-chip" data-a="props" data-tip="Initial capital">${icon('dollar')}<span>${compact(p.initial_capital)}<span class="cur">${m.currency}</span></span>${icon('chevronDown')}</button>
      <button class="dk-chip" data-a="props" data-tip="Order size">${icon('pool')}<span>${size}${p.pyramiding > 1 ? ` · pyramiding ${p.pyramiding}` : ''}</span>${icon('chevronDown')}</button>
      <button class="dk-chip" data-a="props" data-tip="Commission and slippage">${icon('replay')}<span>${comm} · ${p.slippage} ticks</span>${icon('chevronDown')}</button>
      <span class="dk-vsep"></span>
      <button class="wbtn" data-a="inputs" data-tip="Strategy settings" aria-label="Strategy settings">${icon('hexgear')}</button></div>`;
  }

  private stat(label: string, value: string, extra = '', c = '', tip = '') {
    return `<div class="kstat"><div class="l" ${tip ? `title="${esc(tip)}"` : ''}>${label}</div><div class="v ${c}">${value}${extra}</div></div>`;
  }
  private cur() { return `<span class="cur">${this.report?.meta.currency ?? ''}</span>`; }

  private keyStatsHtml(r: Report) {
    if (r.meta.kind === 'quantifi') return this.qfKeyStatsHtml(r);
    const k = r.key_stats, c = cls(k.total_pnl);
    return `<div class="dk-sec"><div class="dk-h1">Key stats</div><div class="kstats" data-keystats>
      ${this.stat('Total PnL', `<span data-k="total_pnl">${money(k.total_pnl)}</span>${this.cur()}`, `<span>${pct(k.total_pnl_pct)}</span>`, c)}
      ${this.stat('Max drawdown', `${money(k.max_drawdown)}${this.cur()}`, `<span>${pct(k.max_drawdown_pct)}</span>`)}
      ${this.stat('Profitable trades', pct(k.profitable_pct), `<span>${k.wins}/${k.closed_trades}</span>`, '', 'Closed trades with a positive P&L')}
      ${this.stat('Profit factor', k.profit_factor === null ? '—' : k.profit_factor.toFixed(2), '', '', 'Gross profit / gross loss')}
    </div></div>`;
  }

  /** QuantiFi key stats: coins, the website run's numbers beside a stress scenario's, and how the replay went. */
  private qfKeyStatsHtml(r: Report) {
    const k = r.key_stats, q = r.quantifi!, cur = this.cur(), w = q.stress ? q.website : null;
    const vs = (x: number | null | undefined) => (w ? `<span class="muted">website: ${money(x, 0)}</span>` : '');
    const kept = w && w.total_pnl ? k.total_pnl / w.total_pnl : null;
    return `<div class="dk-sec"><div class="dk-h1">Key stats<span class="spacer"></span>
        <span class="qf-mode ${q.stress ? 'on' : ''}">${q.stress ? `Stress · ${esc(this.stressName(q.stress.half_life, q.stress.share, q.stress.delay))}` : 'Website fill rules'}</span></div>
      <div class="kstats" data-keystats>
        ${this.stat('Total PnL', `<span data-k="total_pnl">${money(k.total_pnl, 0)}</span>${cur}`, w ? `<span class="muted">website: ${money(w.total_pnl, 0)} · kept ${pct(kept, 0)}</span>` : '', cls(k.total_pnl))}
        ${this.stat('Max drawdown', `${money(k.max_drawdown, 0)}${cur}`, vs(w?.max_drawdown), '', 'Largest fall of the cumulative PnL from its running peak, tick by tick, starting flat')}
        ${this.stat('Sharpe ratio', q.sharpe === null ? '—' : q.sharpe.toFixed(2), w ? `<span class="muted">website: ${w.sharpe === null ? '—' : w.sharpe.toFixed(2)}</span>` : `<span class="muted">Sortino ${q.sortino === null ? '—' : q.sortino.toFixed(2)}</span>`, '',
          'Mean / standard deviation of PnL over 100-tick blocks, scaled to one day (×√100); risk-free 0. Sortino uses the downside deviation.')}
        ${this.stat('Profitable trades', pct(k.profitable_pct), `<span>${k.wins}/${k.closed_trades}</span>`, '', 'Closed holding periods (flat → position → flat) with a positive PnL')}</div>
      <div class="kstats">
        ${this.stat('Profit factor', k.profit_factor === null ? '—' : k.profit_factor.toFixed(2), '', '', 'Gross profit / gross loss of the holding periods')}
        ${this.stat('Fills', q.fills.toLocaleString('en-US'), `<span class="muted">${q.taken_fills.toLocaleString('en-US')} taken · ${q.resting_fills.toLocaleString('en-US')} resting${w ? ` · website ${(w.fills ?? 0).toLocaleString('en-US')}` : ''}</span>`, '',
          `${q.volume.toLocaleString('en-US')} units traded`)}
        ${q.stress ? this.stat('Push cost', `${money(q.push_cost, 0)}${cur}`, `<span class="muted">${q.taken_volume ? `${money(q.push_cost / q.taken_volume, 2)} per unit taken` : ''}</span>`, '',
          'Paid over the recorded book because of the strategy\'s own earlier takes (included in the PnL)') : ''}
        ${this.stat('Rejected / errors', `${q.rejected} / ${q.errors}`, '', q.rejected || q.errors ? 'down' : '',
          q.first_error ? `First error: ${q.first_error}` : 'Order batches cancelled for a possible limit breach / exceptions raised by run()')}</div></div>`;
  }

  private performanceHtml() {
    const s = this.show;
    const item = (k: keyof typeof s, label: string, color: string) =>
      `<button data-series="${k}" class="${s[k] ? '' : 'off'}"><i style="background:${s[k] ? color : 'transparent'};border:1px solid ${color}"></i>${label}${s[k] ? '' : icon('eyeoff', 18)}</button>`;
    const qf = this.report?.meta.kind === 'quantifi';
    return `<div class="dk-sec"><div class="dk-h2">Performance<span class="spacer"></span>
        <button class="wbtn" data-a="perf-shot" data-tip="Download image" aria-label="Download performance chart">${icon('camera')}</button></div>
      <div class="perf-wrap"><div class="perf-legend">${item('pnl', 'Cumulative PnL', UP)}${qf ? '' : item('buyhold', 'Buy and hold', GRAY)}
        ${item('excursions', 'Trades excursions', '#26A69A')}${item('runups', 'Run-ups and drawdowns', DOWN)}</div><div class="perf-chart"></div></div></div>`;
  }

  private tabsHtml(group: string, tabs: [string, string][], cur: string) {
    return `<div class="tabs-pill" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-${group}="${k}" class="${k === cur ? 'active' : ''}" aria-selected="${k === cur}">${l}</button>`).join('')}</div>`;
  }

  // ---------------------------------------------------------------- charts
  private baseChart(el: HTMLElement): IChartApi {
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css('--panel') }, textColor: css('--muted'), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: css('--line-soft') } },
      rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
      localization: { priceFormatter: (p: number) => axisMoney(p) },
      handleScroll: false, handleScale: false,
    });
    if (this.report?.meta.kind === 'quantifi') chart.applyOptions({   // training day and timestamp instead of placeholder dates
      timeScale: { tickMarkFormatter: (t: Time, type: TickMarkType) => quantifiTick(t as number, type <= TickMarkType.DayOfMonth) },
      localization: { timeFormatter: (t: Time) => quantifiLabel(t as number) } });
    this.charts.push(chart);
    return chart;
  }

  private perfChart(el: HTMLElement, r: Report) {
    const chart = this.baseChart(el), s = r.series, t = s.time;
    const at = (i: number) => t[i] as UTCTimestamp;
    if (this.show.runups) {
      const dd = chart.addSeries(HistogramSeries, { priceScaleId: 'dd', color: 'rgba(242,54,69,0.25)', priceLineVisible: false, lastValueVisible: false });
      chart.priceScale('dd').applyOptions({ scaleMargins: { top: 0.75, bottom: 0 }, visible: false });
      const ddv = r.meta.kind === 'quantifi' ? s.drawdown : s.drawdown_pct;   // QuantiFi: coins (no capital base)
      dd.setData(t.map((_, i) => ({ time: at(i), value: ddv[i] ?? 0 })));
    }
    if (this.show.excursions) {
      const toTime = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;
      const byTime = new Map<number, { up: number; dn: number }>();
      for (const tr of r.trades) {
        const k = tr.exit_time ?? toTime(tr.exit_date), e = byTime.get(k) ?? { up: 0, dn: 0 };
        e.up += tr.runup; e.dn += tr.drawdown; byTime.set(k, e);
      }
      const keys = [...byTime.keys()].filter(k => k >= t[0] && k <= t[t.length - 1]).sort((a, b) => a - b);
      const up = chart.addSeries(HistogramSeries, { priceScaleId: 'exc', color: 'rgba(8,153,129,0.55)', priceLineVisible: false, lastValueVisible: false });
      const dn = chart.addSeries(HistogramSeries, { priceScaleId: 'exc', color: 'rgba(242,54,69,0.55)', priceLineVisible: false, lastValueVisible: false });
      chart.priceScale('exc').applyOptions({ scaleMargins: { top: 0.55, bottom: 0.05 }, visible: false });
      up.setData(keys.map(k => ({ time: k as UTCTimestamp, value: byTime.get(k)!.up })));
      dn.setData(keys.map(k => ({ time: k as UTCTimestamp, value: byTime.get(k)!.dn })));
    }
    if (this.show.buyhold && s.buy_hold_pnl.length) {
      const bh = chart.addSeries(LineSeries, { color: GRAY, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      bh.setData(t.map((_, i) => ({ time: at(i), value: s.buy_hold_pnl[i] ?? 0 })));
    }
    if (this.show.pnl) {
      const pnl = chart.addSeries(BaselineSeries, { baseValue: { type: 'price', price: 0 }, lineWidth: 2, priceLineVisible: false,
        topLineColor: UP, topFillColor1: 'rgba(8,153,129,0.22)', topFillColor2: 'rgba(8,153,129,0.02)',
        bottomLineColor: DOWN, bottomFillColor1: 'rgba(242,54,69,0.02)', bottomFillColor2: 'rgba(242,54,69,0.22)' });
      pnl.setData(t.map((_, i) => ({ time: at(i), value: s.pnl[i] ?? 0 })));
      pnl.createPriceLine({ price: 0, color: GRAY, lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: true });
    }
    chart.timeScale().fitContent();
  }

  private lineChart(el: HTMLElement, lines: { t: number[]; v: (number | null)[]; color: string; width?: 1 | 2 }[]) {
    const chart = this.baseChart(el);
    for (const l of lines) {
      const s: ISeriesApi<SeriesType> = chart.addSeries(LineSeries, { color: l.color, lineWidth: l.width ?? 2, priceLineVisible: false, lastValueVisible: true });
      s.setData(l.t.map((t, i) => ({ time: t as UTCTimestamp, value: l.v[i] ?? 0 })));
    }
    chart.timeScale().fitContent();
  }

  /** Bar chart placeholder; drawn by flushBars() at the container's real width (crisp text). */
  private bars(groups: BarSpec['groups'], pct: boolean, decimals = 1) {
    const id = `b${++this.barSeq}`;
    this.barSpecs.set(id, { groups, pct, decimals });
    return `<div class="bars-box" data-bars="${id}"></div>`;
  }
  private flushBars() {
    this.el.querySelectorAll<HTMLElement>('[data-bars]').forEach(box => {
      const spec = this.barSpecs.get(box.dataset.bars!);
      const w = box.clientWidth;
      if (!spec || !w || box.dataset.w === String(w)) return;
      box.dataset.w = String(w);
      box.innerHTML = barsSvg(spec.groups, spec.pct, spec.decimals, w);
    });
  }

  // ---------------------------------------------------------------- performance analysis tabs
  private renderPerfTab() {
    const r = this.report!, box = this.el.querySelector<HTMLElement>('[data-perf-body]')!;
    const cur = this.cur(), init = r.meta.initial_capital;
    if (this.perfTab === 'breakdown') {
      const b = r.breakdown;
      const pine = r.meta.kind === 'pine';
      const rows = this.pnlBy === 'instrument'
        ? b.profits_by_instrument.map(p => (pine ? { key: '', label: esc(p.instrument), v: p.pnl }
          : { key: p.symbol, inst: p.instrument, label: `${esc(p.symbol.split(':').pop())} <span class="muted">${esc(p.name)}</span>`, v: p.pnl }))
        : this.pnlBy === 'side' ? Object.entries(b.profits_by_side ?? {}).map(([k, v]) => ({ key: '', label: k, v }))
        : r.periodical.yearly.map(y => ({ key: '', label: y.period, v: y.strategy * init }));
      const max = Math.max(...rows.map(x => Math.abs(x.v)), 1);
      const capped = !this.pnlAll && rows.length > PNL_ROWS;
      const shown = capped ? [...rows.slice(0, PNL_ROWS / 2), ...rows.slice(-PNL_ROWS / 2)] : rows;
      const unatt = b.unattributed !== null && Math.abs(b.unattributed) > Math.max(1, 1e-6 * init);
      const share = (x: number) => (init ? `<span>${pct(x / init)}</span>` : '');   // QuantiFi: no capital base
      box.innerHTML = `<div class="kstats">${this.stat('Gross profit', `${money(b.gross_profit)}${cur}`, share(b.gross_profit), '', 'Sum of winning trades (price P&L before costs)')}
        ${this.stat('Gross loss', `${money(b.gross_loss)}${cur}`, share(b.gross_loss), '', 'Sum of losing trades (price P&L before costs)')}
        ${this.stat('Profit factor', r.key_stats.profit_factor === null ? '—' : r.key_stats.profit_factor.toFixed(2))}
        ${r.meta.kind === 'quantifi' ? this.stat('Push cost', `${money(r.quantifi!.push_cost)}${cur}`, '', '', 'Stress scenarios only: paid over the recorded book because of the strategy\'s own takes; included in the trades above')
          : this.stat('Commission load', `${money(b.commission)}${cur}`, `<span>${pct(b.commission / init)}</span>`)}</div>
        ${unatt ? `<div class="note" data-unattributed>${money(b.unattributed)} ${r.meta.currency} of the account P&L is not attributed to any trade:
          the engine carried stale prices for ${b.stale_trades} position${b.stale_trades === 1 ? '' : 's'} (suspended or back-filled data), so its
          account curve and the trade list disagree by this amount. Gross profit − gross loss − commission = ${money(b.net_pnl_trades)} ${r.meta.currency}.</div>` : ''}
        ${pine ? `<div class="kstats">${this.stat('Margin calls', String(b.margin_calls ?? 0))}${this.stat('Max contracts held', axisMoney(b.max_contracts_held ?? 0))}<div></div><div></div></div>` : ''}
        <div class="dk-h2">Profits and losses<span class="spacer"></span><span class="seg2"><button data-pnlby="instrument" class="${this.pnlBy === 'instrument' ? 'active' : ''}">${pine ? 'By signal' : 'By instrument'}</button>
          ${pine ? `<button data-pnlby="side" class="${this.pnlBy === 'side' ? 'active' : ''}">By side</button>` : ''}
          ${r.meta.kind === 'quantifi' ? '' : `<button data-pnlby="year" class="${this.pnlBy === 'year' ? 'active' : ''}">By year</button>`}</span></div>
        <table class="pnl-table">${shown.map(x => `<tr ${'inst' in x && x.inst ? `data-inst="${esc(x.inst)}" title="Operations and holding periods"` : x.key ? `data-sym="${esc(x.key)}"` : ''}><td style="width:38%">${x.label}</td>
          <td><span class="bar" style="width:${(Math.abs(x.v) / max * 100).toFixed(1)}%;background:${x.v >= 0 ? UP : DOWN}"></span></td>
          <td class="num ${cls(x.v)}" style="width:22%">${x.v >= 0 ? '+' : ''}${money(x.v)}${cur}</td></tr>`).join('')}</table>
        ${rows.length > PNL_ROWS ? `<button class="pill-btn light" data-a="pnl-all" style="margin-top:12px">${capped ? `Show all ${rows.length}` : 'Show top and bottom 10'}</button>` : ''}`;
    } else if (this.perfTab === 'days') {
      const q = r.quantifi!;
      box.innerHTML = `<div class="kstats">${q.by_day.map(d => this.stat(`Day ${d.day < 0 ? '−' : ''}${Math.abs(d.day)}`, `${money(d.pnl, 0)}${cur}`,
          `<span class="muted">${d.fills.toLocaleString('en-US')} fills · T ${q.tte[String(d.day)] ?? '—'}d</span>`, cls(d.pnl))).join('')}</div>
        <div class="dk-h2">PnL by training day</div>${this.bars(q.by_day.map(d => ({ label: `Day ${d.day}`, values: [{ v: d.pnl, color: d.pnl >= 0 ? UP : DOWN }] })), false)}
        <table class="cmp-table"><tr><th>Day</th><th>PnL</th><th>Fills</th></tr>
          ${q.by_day.map(d => `<tr><td>${d.day}</td><td class="${cls(d.pnl)}">${money(d.pnl, 0)}</td><td>${d.fills.toLocaleString('en-US')}</td></tr>`).join('')}</table>`;
    } else if (this.perfTab === 'periodical') {
      const p = r.periodical, rows = p[this.freq];
      box.innerHTML = `<div class="kstats">${this.stat('Annualized return (CAGR)', pct(p.cagr), '', cls(p.cagr))}${this.stat('Total return', pct(p.total_return), '', cls(p.total_return))}
        ${this.stat('Sharpe ratio', p.sharpe === null ? '—' : p.sharpe.toFixed(2), '', '', r.meta.kind === 'pine'
          ? `Monthly returns of closed-trade equity minus the ${(r as StrategyRun).props.risk_free_rate}% risk-free rate, not annualized (TradingView's definition)` : 'Daily returns, annualized with 252 days, risk-free 0')}
        ${this.stat('Sortino ratio', p.sortino === null ? '—' : p.sortino.toFixed(2), '', '', r.meta.kind === 'pine'
          ? 'Monthly returns over their downside deviation, not annualized' : 'Downside deviation of daily returns, annualized')}</div>
        <div class="dk-h2">${{ monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' }[this.freq]} returns<span class="spacer"></span><span class="seg2">
          ${(['monthly', 'quarterly', 'yearly'] as const).map(f => `<button data-freq="${f}" class="${this.freq === f ? 'active' : ''}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}</span></div>
        ${this.bars(rows.map(x => ({ label: x.period, values: [{ v: x.strategy, color: x.strategy >= 0 ? UP : DOWN }, { v: x.benchmark, color: '#B2B5BE' }] })), true)}
        <div class="chart-legend"><span><i style="background:${UP}"></i>Strategy</span><span><i style="background:#B2B5BE"></i>Buy and hold (benchmark)</span></div>`;
    } else if (this.perfTab === 'benchmarking') {
      const b = r.benchmarking;
      box.innerHTML = `<div class="kstats">${this.stat('Strategy return', pct(b.strategy_return, 2, true), '', cls(b.strategy_return))}
        ${this.stat('Buy and hold return', pct(b.buy_hold_return, 2, true), '', cls(b.buy_hold_return), `Benchmark: ${r.meta.benchmark ?? 'pool default'}`)}
        ${this.stat('Strategy outperformance', pct(b.outperformance, 2, true), '', cls(b.outperformance))}
        ${this.stat('Correlation', b.correlation === null ? '—' : b.correlation.toFixed(2), '', '', 'Correlation of daily returns with the benchmark')}</div>
        <div class="dk-h2">Strategy vs benchmark</div><div class="perf-chart" data-bench style="height:240px"></div>
        <div class="chart-legend"><span><i style="background:${BLUE}"></i>Strategy PnL</span><span><i style="background:${GRAY}"></i>Buy and hold PnL</span></div>`;
      this.lineChart(box.querySelector<HTMLElement>('[data-bench]')!, [
        { t: r.series.time, v: r.series.buy_hold_pnl, color: GRAY, width: 1 }, { t: r.series.time, v: r.series.pnl, color: BLUE }]);
    } else {
      const g = r.growth_decline;
      const eps = [...g.runups.map(x => ({ ...x, kind: 'up' })), ...g.drawdowns.map(x => ({ ...x, kind: 'dn' }))].sort((a, b) => a.start.localeCompare(b.start));
      const days = (x: number | null) => (x === null ? '—' : `${Math.round(x).toLocaleString('en-US')} days`);
      box.innerHTML = `<div class="kstats">${this.stat('Average run-up duration', days(g.avg_runup_days))}${this.stat('Average drawdown duration', days(g.avg_drawdown_days))}
        ${this.stat('Max drawdown as % of initial capital', pct(g.max_drawdown_of_initial))}<div></div></div>
        <div class="two-col"><div><div class="dk-h2">Alternating growth and decline</div>
          ${this.bars(eps.map(x => ({ label: x.start.slice(0, 7), values: [{ v: x.pct, color: x.kind === 'up' ? UP : DOWN }] })), true)}
          <div class="chart-legend"><span><i style="background:${UP}"></i>Run-up</span><span><i style="background:${DOWN}"></i>Drawdown</span></div></div>
        <div><div class="dk-h2">Comparison of growth and decline periods</div>
          <table class="cmp-table"><tr><th></th><th>Run-up</th><th>Drawdown</th></tr>
            <tr><td>Maximum</td><td>${pct(g.runup.max)}</td><td>${pct(g.drawdown.max)}</td></tr>
            <tr><td>Average</td><td>${pct(g.runup.avg)}</td><td>${pct(g.drawdown.avg)}</td></tr>
            <tr><td>Current</td><td>—</td><td>${pct(g.drawdown.current)}</td></tr>
            <tr><td>Count</td><td>${g.runups.length}</td><td>${g.drawdowns.length}</td></tr></table></div></div>`;
    }
    this.flushBars();
  }

  // ---------------------------------------------------------------- trades analysis tabs
  private renderTradesTab() {
    const r = this.report!, box = this.el.querySelector<HTMLElement>('[data-trades-body]')!, cur = this.cur();
    if (this.tradesTab === 'distribution') {
      const d = r.distribution;
      const avgBars = r.trades.length ? r.trades.reduce((s, t) => s + t.bars, 0) / r.trades.length : null;
      const e = d.histogram.edges, total = d.winners + d.losers + d.breakevens;
      const groups = d.histogram.counts.map((n, i) => ({ label: `${(e[i] * 100).toFixed(0)}%`, values: [{ v: n, color: (e[i] + e[i + 1]) / 2 < 0 ? DOWN : UP }] }));
      box.innerHTML = `<div class="kstats">${this.stat('Expectancy', `${money(d.expectancy)}${cur}`, `<span>${pct(d.expectancy_pct)}</span>`, cls(d.expectancy), 'Average P&L per trade')}
        ${this.stat(r.meta.kind === 'quantifi' ? 'Average ticks in trade' : 'Average bars in trade', avgBars === null ? '—' : avgBars.toFixed(1))}
        ${this.stat('Largest profit', `${money(d.largest_profit)}${cur}`, '', 'up')}${this.stat('Largest loss', `${money(d.largest_loss)}${cur}`, '', 'down')}</div>
        <div class="two-col"><div><div class="dk-h2">Returns distribution</div>${this.bars(groups, false)}
          <div class="chart-legend"><span><i style="background:${DOWN}"></i>Losers · average ${pct(d.avg_loss_pct)}</span><span><i style="background:${UP}"></i>Winners · average ${pct(d.avg_profit_pct)}</span></div></div>
        <div><div class="dk-h2">Trades distribution</div><div class="donut-wrap">${donutSvg([{ v: d.winners, color: UP }, { v: d.losers, color: DOWN }, { v: d.breakevens, color: '#B2B5BE' }], String(total + d.open), 'Total trades')}
          <div class="donut-legend">${[['Winners', d.winners, UP], ['Losers', d.losers, DOWN], ['Breakevens', d.breakevens, '#B2B5BE'], ['Open', d.open, BLUE]]
            .map(([l, n, c]) => `<div><span><i style="background:${c}"></i>${l}</span><span>${n} trades</span><span class="num">${total ? pct(Number(n) / total) : '—'}</span></div>`).join('')}</div></div></div></div>`;
    } else if (this.tradesTab === 'streaks') {
      const s = r.streaks;
      box.innerHTML = `<div class="kstats">${this.stat('Longest winning streak', `${s.max_win} trades`, '', 'up')}${this.stat('Longest losing streak', `${s.max_loss} trades`, '', 'down')}
        ${this.stat('Average winning streak', `${s.avg_win.toFixed(1)} trades`)}${this.stat('Average losing streak', `${s.avg_loss.toFixed(1)} trades`)}</div>
        <div class="dk-h2">Closed trades in order</div>${this.bars(r.trades.filter(t => !t.open).map(t => ({ label: t.exit_date.slice(0, r.meta.kind === 'quantifi' ? 6 : 7), values: [{ v: t.return_pct, color: t.pnl >= 0 ? UP : DOWN }] })), true)}`;
    } else {
      const tp = r.time_patterns;
      box.innerHTML = `<div class="two-col"><div><div class="dk-h2">Average trade return by entry weekday</div>
          ${this.bars(tp.by_entry_weekday.map(w => ({ label: `${w.key} (${w.trades})`, values: [{ v: w.avg_return, color: (w.avg_return ?? 0) >= 0 ? UP : DOWN }] })), true)}</div>
        <div><div class="dk-h2">Average daily return by month</div>
          ${this.bars(tp.by_month.map(m => ({ label: m.key, values: [{ v: m.avg_daily_return, color: (m.avg_daily_return ?? 0) >= 0 ? UP : DOWN }] })), true, 3)}</div></div>`;
    }
    this.flushBars();
  }

  // ---------------------------------------------------------------- list of trades
  private tradesHtml(r: Report) {
    const cur = this.cur(), pine = r.meta.kind === 'pine';
    const rows = [...r.trades].sort((a, b) => (this.sortAsc ? a.n - b.n : b.n - a.n));
    const sig = (s?: string) => (pine ? `<td class="sig">${esc(s ?? '')}</td>` : '');
    const tr = (t: ReportTrade) => `<tbody class="trade" data-trade="${t.n}" data-sym="${esc(t.symbol)}">
      <tr><td rowspan="2"><span class="tno">${t.n}</span><span class="tside ${t.side === 'short' ? 'short' : ''}">${t.side === 'short' ? 'Short' : 'Long'}</span>
        <span class="tsym">${pine ? '' : `${esc(t.symbol.split(':').pop())} ${esc(t.name)}`}</span></td>
        <td>Exit</td><td>${t.open ? '<span class="muted">Open</span>' : date(t.exit_date)}</td>${sig(t.open ? '' : t.exit_label)}<td class="num">${t.open ? '—' : `${money(t.exit_price, 3)}${cur}`}</td>
        <td class="num" rowspan="2">${axisMoney(t.qty)}<br>${axisMoney(t.qty * t.entry_price)}${cur}</td>
        <td class="num ${cls(t.pnl)}" rowspan="2">${t.pnl > 0 ? '+' : ''}${money(t.pnl)}${cur}${t.stale ? '<span class="stale" title="The engine priced this position with a stale close">stale</span>' : ''}</td>
        <td class="num" rowspan="2"><span class="up">+${money(t.runup)}</span><br><span class="down">${money(t.drawdown)}</span></td>
        <td class="num ${cls(t.return_pct)}" rowspan="2">${t.open ? '—' : pct(t.return_pct, 2, true)}</td></tr>
      <tr class="entry"><td class="sub">Entry</td><td class="sub">${date(t.entry_date)}</td>${pine ? `<td class="sub sig">${esc(t.entry_label ?? '')}</td>` : ''}<td class="sub num">${money(t.entry_price, 3)}${cur}</td></tr></tbody>`;
    return `<div class="dk-sec"><div class="dk-h1 trades-head">List of trades<span class="spacer"></span>
        <button class="wbtn" data-a="csv" data-tip="Export CSV" aria-label="Export trades CSV">${icon('download')}</button></div>
      <div class="trades-wrap"><table class="trades"><thead><tr><th data-a="sort" style="cursor:pointer"><span class="th-sort">Trade number ${icon(this.sortAsc ? 'sortUp' : 'sortDown', 16)}</span></th><th>Type</th><th>Date and time</th>${pine ? '<th>Signal</th>' : ''}
        <th class="num">Price</th><th class="num">Size</th><th class="num" title="Price P&L before commissions (commissions are in Breakdown)">PnL</th>
        <th class="num" title="Best and worst mark-to-market P&L while the position was open">Run-up / Drawdown</th><th class="num">Return</th></tr></thead>
        ${rows.map(tr).join('')}</table></div></div>`;
  }

  private exportCsv() {
    const r = this.report!;
    const q = (x?: string) => `"${(x ?? '').replace(/"/g, '""')}"`;
    const head = ['trade', 'symbol', 'name', 'side', 'entry_signal', 'exit_signal', 'entry_date', 'entry_price', 'exit_date', 'exit_price', 'qty', 'pnl', 'return_pct', 'runup', 'drawdown', 'bars', 'open', 'stale'];
    const lines = r.trades.map(t => [t.n, t.symbol, q(t.name), t.side ?? 'long', q(t.entry_label), q(t.exit_label), t.entry_date, t.entry_price, t.exit_date, t.exit_price, t.qty, t.pnl, t.return_pct, t.runup, t.drawdown, t.bars, t.open, t.stale].join(','));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' }));
    a.download = `${r.meta.name}_trades.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------------------------------------------------------------- instruments: earned / lost per name
  private instrumentRows(r: Report) {
    const by = new Map<string, { instrument: string; symbol: string; name: string; pnl: number; trips: number; wins: number; losses: number; days: number; last: string; open: boolean }>();
    for (const t of r.trades) {
      const x = by.get(t.instrument) ?? { instrument: t.instrument, symbol: t.symbol, name: t.name, pnl: 0, trips: 0, wins: 0, losses: 0, days: 0, last: '', open: false };
      x.pnl += t.pnl; x.trips += 1; x.days += t.bars;
      if (!t.open) { if (t.pnl > 0) x.wins += 1; else if (t.pnl < 0) x.losses += 1; }
      if (t.open) x.open = true;
      if (t.exit_date > x.last) x.last = t.exit_date;
      by.set(t.instrument, x);
    }
    return [...by.values()].sort((a, b) => b.pnl - a.pnl);
  }

  private instrumentsHtml(r: Report) {
    const cur = this.cur(), all = this.instrumentRows(r);
    const earned = all.filter(x => x.pnl > 0), lost = all.filter(x => x.pnl < 0);
    const total = all.reduce((s, x) => s + x.pnl, 0);
    const q = this.instQuery.toLowerCase();
    const rows = (this.instFilter === 'earned' ? earned : this.instFilter === 'lost' ? [...lost].reverse() : all)
      .filter(x => !q || `${x.symbol} ${x.name} ${x.instrument}`.toLowerCase().includes(q));
    const max = Math.max(...all.map(x => Math.abs(x.pnl)), 1);
    const sum = (xs: typeof all) => xs.reduce((s, x) => s + x.pnl, 0);
    const seg = (k: typeof this.instFilter, label: string) => `<button data-instf="${k}" class="${this.instFilter === k ? 'active' : ''}">${label}</button>`;
    return `<div class="dk-sec"><div class="dk-h1">Instruments</div>
      <div class="kstats">${this.stat('Names traded', String(all.length))}
        ${this.stat('Earned on', `${earned.length} names`, `<span class="up">+${money(sum(earned))}${cur}</span>`, '', 'Instruments whose holding periods made money in total')}
        ${this.stat('Lost on', `${lost.length} names`, `<span class="down">${money(sum(lost))}${cur}</span>`, '', 'Instruments whose holding periods lost money in total')}
        ${this.stat('Net from trades', `${money(total)}${cur}`, '', cls(total), 'Sum of every holding period\'s price P&L (before commissions)')}</div>
      <div class="dk-h2"><span class="seg2">${seg('all', 'All')}${seg('earned', 'Earned')}${seg('lost', 'Lost')}</span><span class="spacer"></span>
        <input class="inst-search" data-instq placeholder="Search name or code" value="${esc(this.instQuery)}"/></div>
      <table class="inst-table"><thead><tr><th>Instrument</th><th class="num">P&L</th><th></th><th class="num">Share of net</th><th class="num">Holding periods</th>
        <th class="num">Won / lost</th><th class="num">${r.meta.kind === 'quantifi' ? 'Ticks held' : 'Days held'}</th><th>Last</th></tr></thead><tbody>
        ${rows.map(x => `<tr data-inst="${esc(x.instrument)}" title="Open ${esc(x.symbol)}: operations, holding periods and chart">
          <td><span class="isym">${esc(x.symbol.split(':').pop())}</span> <span class="muted">${esc(x.name !== x.symbol ? x.name : '')}</span>${x.open ? '<span class="open-tag">open</span>' : ''}</td>
          <td class="num ${cls(x.pnl)}">${x.pnl > 0 ? '+' : ''}${money(x.pnl)}${cur}</td>
          <td style="width:18%"><span class="bar" style="width:${(Math.abs(x.pnl) / max * 100).toFixed(1)}%;background:${x.pnl >= 0 ? UP : DOWN}"></span></td>
          <td class="num">${total ? pct(x.pnl / Math.abs(total), 1) : '—'}</td><td class="num">${x.trips}</td>
          <td class="num"><span class="up">${x.wins}</span> / <span class="down">${x.losses}</span></td><td class="num">${x.days}</td>
          <td class="muted">${date(x.last)}</td></tr>`).join('')}
      </tbody></table>${rows.length ? '' : '<div class="muted" style="padding:16px 0">No instruments match</div>'}</div>`;
  }

  async openInstrument(instrument: string) {
    const r = this.report, run = this.runId;
    if (!r || !run || r.meta.kind === 'pine') return;
    const qf = r.meta.kind === 'quantifi';
    if (qf) this.chartProduct = instrument;
    this.view = 'instruments';
    this.inst = { id: instrument, data: null };
    this.instTab = 'overview';
    this.toggle(true);
    this.render();
    try {
      const d = await api.btInstrument(run, instrument);
      if (this.inst?.id !== instrument) return;
      this.inst.data = d;
      this.render();
      await this.app.showRunInstrument(d, r);
    } catch (e) {
      if (this.inst?.id === instrument) { this.inst.error = (e as Error).message; this.render(); }
    }
  }

  /** One instrument of a saved run, laid out like TradingView's Strategy Tester: symbol header, tab pills,
   *  key stats + cumulative P&L chart + metrics table, the list of holding periods (Entry/Exit rows) and an
   *  order-history table of every operation. */
  private instrumentHtml(r: Report) {
    const cur = this.cur(), i = this.inst!, d = i.data;
    const back = `<button class="inst-back" data-a="inst-back" data-tip="All instruments" aria-label="All instruments">${icon('chevronLeft', 8)}</button>`;
    if (!d) return `<div class="dk-sec"><div class="inst-head">${back}<span class="muted">${i.error ? esc(i.error) : `Loading ${esc(i.id)}…`}</span></div></div>`;
    const s = d.summary, tab = this.instTab;
    const total = r.trades.reduce((x, t) => x + t.pnl, 0);
    const won = d.trips.filter(t => !t.open && t.pnl > 0), lost = d.trips.filter(t => !t.open && t.pnl < 0);
    const gp = won.reduce((x, t) => x + t.pnl, 0), gl = -lost.reduce((x, t) => x + t.pnl, 0);
    const worstDd = Math.min(0, ...d.trips.map(t => t.drawdown));
    const head = `<div class="inst-head">${back}${logo(d.symbol, 28)}<div class="inst-title"><div class="l1"><span class="isym">${esc(d.symbol.split(':').pop())}</span>
        <span class="ex muted">${esc(d.symbol.includes(':') ? d.symbol.split(':')[0] : '')}</span>${s.open_qty ? '<span class="open-tag">In position</span>' : ''}</div>
        <div class="l2 muted">${esc(d.name !== d.instrument && d.name !== d.symbol ? d.name : '')}${d.name && d.name !== d.symbol ? ' · ' : ''}${date(s.first)} — ${date(s.last)}</div></div>
      <span class="spacer"></span><button class="dk-chip" data-a="inst-chart" data-tip="Show operations on the chart">${icon('candles', 20)}<span>Chart</span></button></div>
      ${this.tabsHtml('itab', [['overview', 'Overview'], ['trips', `Holding periods · ${s.trips}`], ['ops', `Operations · ${d.operations.filter(o => o.action !== 'open').length}`]], tab)}`;
    if (tab === 'overview') {
      const row = (label: string, v: string, sub = '', c = '') => `<tr><td>${label}</td><td class="num ${c}">${v}${sub ? `<span class="sub">${sub}</span>` : ''}</td></tr>`;
      const m = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x > 0 ? '+' : ''}${money(x)}${cur}`);
      return `<div class="dk-sec">${head}<div class="kstats">
          ${this.stat('Total PnL', `${money(s.pnl)}${cur}`, `<span>${total ? pct(s.pnl / Math.abs(total), 2) : '—'} of net</span>`, cls(s.pnl), 'Price P&L of every holding period of this instrument, before commissions')}
          ${this.stat('Max drawdown', `${money(Math.abs(worstDd))}${cur}`, '', '', 'Worst mark-to-market loss inside one holding period')}
          ${this.stat('Profitable periods', pct(s.win_rate), `<span>${s.wins}/${s.closed}</span>`)}
          ${this.stat('Profit factor', gl ? (gp / gl).toFixed(2) : gp ? '∞' : '—', '', '', 'Gross profit / gross loss of closed holding periods')}</div></div>
        <div class="dk-sec"><div class="dk-h2">Cumulative PnL<span class="spacer"></span><span class="chart-legend" style="margin:0">
          <span><i style="background:${BLUE}"></i>Buy</span><span><i style="background:${DOWN}"></i>Sell</span></span></div><div class="perf-chart inst-perf" style="height:260px"></div></div>
        <div class="dk-sec" style="padding-bottom:24px"><div class="dk-h2">Performance</div><table class="metrics-table"><tbody>
          ${row('Net profit', m(s.pnl), total ? pct(s.pnl / Math.abs(total), 2) + ' of net' : '', cls(s.pnl))}
          ${row('Gross profit', m(gp), '', 'up')}${row('Gross loss', m(-gl), '', 'down')}
          ${row('Holding periods', String(s.trips), s.trips > s.closed ? '1 still open' : '')}
          ${row('Winning / losing periods', `<span class="up">${s.wins}</span> / <span class="down">${s.losses}</span>`)}
          ${row('Avg return per period', pct(s.avg_return, 2, true), '', cls(s.avg_return))}
          ${row('Avg winning period', won.length ? m(gp / won.length) : '—', '', 'up')}${row('Avg losing period', lost.length ? m(-gl / lost.length) : '—', '', 'down')}
          ${row('Largest winning period', m(s.best), '', 'up')}${row('Largest losing period', m(s.worst), '', 'down')}
          ${row(d.kind === 'quantifi' ? 'Ticks held' : 'Days held', String(s.days_held), `avg ${(s.days_held / Math.max(1, s.trips)).toFixed(1)} per period`)}
          ${d.kind === 'quantifi' ? row('Push per unit (λ)', d.lambda === null || d.lambda === undefined ? '—' : d.lambda.toFixed(3), d.push_cost ? `coins per unit taken · push paid ${money(d.push_cost)}` : 'coins per unit taken, under stress') : ''}
          ${row('Buys / sells', `${s.buys} / ${s.sells}`, 'adds and trims included')}
          ${row('Bought / sold', `${axisMoney(s.bought_value)} / ${axisMoney(s.sold_value)} ${esc(r.meta.currency)}`)}
          ${row('Position now', s.open_qty ? `${axisMoney(s.open_qty)} units` : 'Flat', s.open_qty ? `${axisMoney(s.open_value)} ${esc(r.meta.currency)} · open P&L ${m(s.open_pnl)}` : '')}
        </tbody></table></div>`;
    }
    if (tab === 'trips') {
      const rows = [...d.trips].map((t, k) => ({ t, n: k + 1 })).sort((a, b) => (this.sortAsc ? a.n - b.n : b.n - a.n));
      let cum = 0;
      const cumBy = new Map(d.trips.map((t, k) => [k + 1, (cum += t.pnl)]));
      return `<div class="dk-sec" style="padding-bottom:24px">${head}<div class="trades-wrap"><table class="trades"><thead><tr>
          <th data-a="sort" style="cursor:pointer"><span class="th-sort">Period ${icon(this.sortAsc ? 'sortUp' : 'sortDown', 16)}</span></th><th>Type</th><th>Date</th>
          <th class="num">Price</th><th class="num">Size</th><th class="num">PnL</th><th class="num">Run-up / Drawdown</th><th class="num">Cumulative PnL</th></tr></thead>
        ${rows.map(({ t, n }) => `<tbody class="trade" data-goto="${t.entry_time ?? t.entry_date}">
          <tr><td rowspan="2"><span class="tno">${n}</span><span class="tside ${t.side === 'short' ? 'short' : ''}">${t.side === 'short' ? 'Short' : 'Long'}</span></td><td>Exit</td><td>${t.open ? '<span class="muted">Open</span>' : date(t.exit_date)}</td>
            <td class="num">${t.open ? '—' : `${money(t.exit_price, 3)}${cur}`}</td>
            <td class="num" rowspan="2">${axisMoney(t.qty)}<br>${axisMoney(t.max_value)}${cur}</td>
            <td class="num ${cls(t.pnl)}" rowspan="2">${t.pnl > 0 ? '+' : ''}${money(t.pnl)}${cur}<br><span class="sub ${cls(t.return_pct)}">${pct(t.return_pct, 2, true)}</span></td>
            <td class="num" rowspan="2"><span class="up">+${money(t.runup)}</span><br><span class="down">${money(t.drawdown)}</span></td>
            <td class="num ${cls(cumBy.get(n))}" rowspan="2">${money(cumBy.get(n))}${cur}</td></tr>
          <tr class="entry"><td class="sub">Entry</td><td class="sub">${date(t.entry_date)}</td><td class="sub num">${money(t.entry_price, 3)}${cur}</td></tr></tbody>`).join('')}
        </table></div></div>`;
    }
    const label: Record<string, [string, string]> = { buy: ['Buy', 'Open'], add: ['Buy', 'Add'], trim: ['Sell', 'Trim'], sell: ['Sell', 'Close'], open: ['—', 'Held'],
      short: ['Sell', 'Open short'], short_add: ['Sell', 'Add short'], cover_trim: ['Buy', 'Trim short'], cover: ['Buy', 'Cover'], dayend: ['—', 'Day end · mid'] };
    const qf = d.kind === 'quantifi', OPS_SHOWN = 2000;
    const opsShown = [...d.operations].reverse().slice(0, OPS_SHOWN);
    return `<div class="dk-sec" style="padding-bottom:24px">${head}<div class="trades-wrap"><table class="orders"><thead><tr><th>Date</th><th>Side</th><th>Action</th>
        <th class="num">Qty</th><th class="num">Price</th><th class="num">Value</th><th class="num">Position</th><th class="num">Realized PnL</th><th class="num">Cumulative PnL</th></tr></thead><tbody>
      ${opsShown.map(o => { const [side, act] = label[o.action]; return `<tr data-goto="${o.time ?? o.date}">
        <td>${date(o.date)}</td><td><span class="side side-${side.toLowerCase()}">${side}</span></td><td class="${o.action === 'open' || o.action === 'dayend' ? 'muted' : ''}">${act}${qf && o.kind === 'passive' ? ' <span class="muted">· resting</span>' : ''}</td>
        <td class="num">${o.qty ? axisMoney(Math.abs(o.qty)) : '—'}</td><td class="num">${money(o.price, 3)}</td>
        <td class="num">${o.value ? `${money(Math.abs(o.value))}${cur}` : '—'}</td><td class="num">${o.position ? axisMoney(o.position) : '0'}</td>
        <td class="num ${cls(o.trip_pnl)}">${o.trip_pnl === null || o.action === 'open' ? '' : `${o.trip_pnl > 0 ? '+' : ''}${money(o.trip_pnl)}${cur}`}</td>
        <td class="num ${cls(o.cum_pnl)}">${money(o.cum_pnl)}${cur}</td></tr>`; }).join('')}
      </tbody></table></div><div class="note" style="margin-top:12px">${qf
        ? `Prices are fill prices${r.quantifi?.stress ? ', a taken unit\'s including the push of the strategy\'s earlier takes' : ' (website rules)'}; cumulative PnL marks the position at mid. A position still held at a day's close is marked at mid there, as each day starts flat.${d.operations.length > OPS_SHOWN ? ` Showing the newest ${OPS_SHOWN.toLocaleString('en-US')} of ${d.operations.length.toLocaleString('en-US')}.` : ''}`
        : `Prices are the engine's daily closes, the marks its P&L is computed from; orders filled at the next open (deal price ${esc(String((r.meta.config as Record<string, unknown>).deal_price ?? 'open'))}).`} Newest first; click a row to see it on the chart.</div></div>`;
  }

  /** TradingView-style cumulative P&L of one instrument, with its buys and sells marked. */
  private instrumentChart() {
    const d = this.inst?.data, el = this.el.querySelector<HTMLElement>('.inst-perf');
    if (!d || !el || !d.pnl_path.length) return;
    if (d?.kind === 'quantifi') { this.qfInstrumentChart(d); return; }
    const chart = this.baseChart(el);
    const toT = (x: string) => (Date.parse(`${x}T00:00:00Z`) / 1000) as UTCTimestamp;
    const ser = chart.addSeries(BaselineSeries, { baseValue: { type: 'price', price: 0 }, lineWidth: 2, priceLineVisible: false,
      topLineColor: UP, topFillColor1: 'rgba(8,153,129,0.22)', topFillColor2: 'rgba(8,153,129,0.02)',
      bottomLineColor: DOWN, bottomFillColor1: 'rgba(242,54,69,0.02)', bottomFillColor2: 'rgba(242,54,69,0.22)' });
    // a name traded only in the past: stop the curve a little after its last operation instead of running flat for years
    const lastOp = d.operations[d.operations.length - 1]?.date ?? d.pnl_path[d.pnl_path.length - 1][0];
    const span = toT(lastOp) - toT(d.pnl_path[0][0]);
    const until = d.summary.open_qty ? Infinity : toT(lastOp) + Math.max(30 * 86400, span * 0.08);
    ser.setData(d.pnl_path.filter(([x]) => toT(x) <= until).map(([x, v]) => ({ time: toT(x), value: v })));
    ser.createPriceLine({ price: 0, color: GRAY, lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false });
    const first = d.pnl_path[0][0];
    createSeriesMarkers(ser, d.operations.filter(o => (o.action === 'buy' || o.action === 'sell') && o.date >= first).map(o => (o.action === 'buy'
      ? { time: toT(o.date), position: 'belowBar' as const, color: BLUE, shape: 'arrowUp' as const, text: '' }
      : { time: toT(o.date), position: 'aboveBar' as const, color: DOWN, shape: 'arrowDown' as const, text: '' })));
    chart.timeScale().fitContent();
  }

  /** QuantiFi product: cumulative PnL (marked at mid, every 10 ticks) with its trades' opens and closes marked. */
  private qfInstrumentChart(d: InstrumentDetail) {
    const el = this.el.querySelector<HTMLElement>('.inst-perf'), ps = d.pnl_series;
    if (!el || !ps || !ps.time.length) return;
    const chart = this.baseChart(el);
    const ser = chart.addSeries(BaselineSeries, { baseValue: { type: 'price', price: 0 }, lineWidth: 2, priceLineVisible: false,
      topLineColor: UP, topFillColor1: 'rgba(8,153,129,0.22)', topFillColor2: 'rgba(8,153,129,0.02)',
      bottomLineColor: DOWN, bottomFillColor1: 'rgba(242,54,69,0.02)', bottomFillColor2: 'rgba(242,54,69,0.22)' });
    ser.setData(ps.time.map((t, i) => ({ time: t as UTCTimestamp, value: ps.value[i] })));
    ser.createPriceLine({ price: 0, color: GRAY, lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false });
    const snap = (t: number) => { let lo = 0, hi = ps.time.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ps.time[m] <= t) lo = m; else hi = m - 1; } return ps.time[lo]; };
    const seen = new Set<string>();
    const marks = d.trips.flatMap(t => [{ t: t.entry_time!, buy: t.side !== 'short' }, ...(t.open ? [] : [{ t: t.exit_time!, buy: t.side === 'short' }])])
      .map(x => ({ time: snap(x.t), buy: x.buy })).filter(x => { const k = `${x.time}${x.buy}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.time - b.time);
    createSeriesMarkers(ser, marks.map(x => (x.buy ? { time: x.time as UTCTimestamp, position: 'belowBar' as const, color: BLUE, shape: 'arrowUp' as const, text: '' }
      : { time: x.time as UTCTimestamp, position: 'aboveBar' as const, color: DOWN, shape: 'arrowDown' as const, text: '' })));
    chart.timeScale().fitContent();
  }

  // ---------------------------------------------------------------- Greeks (QuantiFi option book)
  private async loadStops() {
    try { this.stops = await api.qfStressStops(); } catch (e) { toast(`Stress stops unavailable: ${esc((e as Error).message)}`); return; }
    if (this.view === 'stress') this.render();
  }

  /** Sliders for one stress scenario of the website run, and the last scenario replayed beside the website run. */
  private stressHtml(r: Report) {
    const q = r.quantifi!, st = this.stops, p = this.stressPick, sc = this.scenario;
    const lam = Object.entries(q.lambda).filter(([, v]) => v !== null).map(([k, v]) => `${k} ${v!.toFixed(3)}`).join(', ');
    if (!st) return '<div class="dk-sec"><div class="muted">Loading…</div></div>';
    const hi = stopIndex(st.half_life, p.h), si = stopIndex(st.share, p.s);
    const running = sc?.status === 'running';
    const same = sc?.key === this.stressKey() && sc.status === 'done';
    const form = `<div class="dk-sec"><div class="dk-h1">Stress test<span class="spacer"></span>
        <span class="muted gk-note">linear push that refills (Obizhaeva &amp; Wang 2013), thinner book, delay</span></div>
      <div class="st-form">
        <label class="st-row" title="How fast the book refills after the strategy's own takes: half of the gap is back after this many ticks">
          <span class="st-name">Push half-life</span>
          <input type="range" min="0" max="${st.half_life.length - 1}" step="1" value="${hi}" data-st="h">
          <span class="st-val" data-stv="h">${this.halfLifeText(st.half_life[hi] ?? null)}</span></label>
        <div class="st-ticks">${st.half_life.map(h => `<span>${stopLabel(h)}</span>`).join('')}</div>
        <label class="st-row" title="Share of each displayed level and of each market trade that is the strategy's; a smaller share also makes each unit push harder (λ / share)">
          <span class="st-name">Liquidity share</span>
          <input type="range" min="0" max="${st.share.length - 1}" step="1" value="${si}" data-st="s">
          <span class="st-val" data-stv="s">${Math.round((st.share[si] ?? 1) * 100)}%</span></label>
        <div class="st-ticks">${st.share.map(x => `<span>${Math.round(x * 100)}%</span>`).join('')}</div>
        <div class="st-row"><span class="st-name">Delay</span>
          <span class="seg2">${st.delay.map(d => `<button data-std="${d}" class="${p.d === d ? 'active' : ''}">${d} tick${d === 1 ? '' : 's'}</button>`).join('')}</span>
          <span class="spacer"></span>
          ${running ? `<span class="muted" data-st-progress>Replaying… ${Math.round((Date.now() - sc!.since) / 1000)}s</span>`
            : `<button class="pill-btn" data-a="st-run">${same ? 'Replayed' : 'Run scenario'}</button>`}</div>
      </div>
      <div class="note">Each unit the strategy buys moves that product's asks up by λ / share coins, and each unit it sells moves its bids down; the gap refills with the half-life, and the other side is untouched, so the strategy can never sell into its own push.
        λ is the order book's own depth: the price walked per unit (${esc(lam) || '—'}). Only the share of displayed volume and of market trades is the strategy's;
        delay is the ticks before an order reaches the book. The strategy is shown the stressed book and reacts to it; positions are marked at the recorded mid.
        h 0 · 100% · 0 ticks is the website.</div></div>`;
    if (!sc || sc.status === 'running') return form;
    if (sc.status === 'error') return `${form}<div class="dk-sec"><div class="down">Scenario failed: ${esc(sc.error ?? '')}</div></div>`;
    const sr = sc.report!, sq = sr.quantifi!, w = sq.website!, k = sr.key_stats, cur = this.cur();
    const kept = w.total_pnl ? k.total_pnl / w.total_pnl : null;
    return `${form}<div class="dk-sec"><div class="dk-h1">${esc(sc.label)}<span class="spacer"></span>
        <button class="pill-btn light" data-a="st-open" data-tip="Open this scenario's report, with its fills on the chart">Open on chart</button></div>
      <div class="kstats">
        ${this.stat('Scenario PnL', `${money(k.total_pnl, 0)}${cur}`, `<span class="muted">website ${money(w.total_pnl, 0)} · kept ${pct(kept, 0)}</span>`, cls(k.total_pnl))}
        ${this.stat('Max drawdown', `${money(k.max_drawdown, 0)}${cur}`, `<span class="muted">website ${money(w.max_drawdown, 0)}</span>`)}
        ${this.stat('Sharpe ratio', sq.sharpe === null ? '—' : sq.sharpe.toFixed(2), `<span class="muted">website ${w.sharpe === null ? '—' : w.sharpe.toFixed(2)}</span>`)}
        ${this.stat('Fills', sq.fills.toLocaleString('en-US'), `<span class="muted">website ${(w.fills ?? 0).toLocaleString('en-US')}</span>`)}
        ${this.stat('Push cost', `${money(sq.push_cost, 0)}${cur}`, `<span class="muted">${sq.taken_volume ? `${money(sq.push_cost / sq.taken_volume, 2)} per unit taken` : 'nothing taken'}</span>`, '',
          'Paid over the recorded book because of the strategy\'s own earlier takes')}</div>
      <div class="perf-legend st-legend"><span><i style="background:${GRAY}"></i>Website</span><span><i style="background:${BLUE}"></i>Scenario</span></div>
      <div class="st-chart"></div></div>`;
  }

  /** Cumulative PnL of the website run and of the scenario on one chart. */
  private stressChart() {
    const el = this.el.querySelector<HTMLElement>('.st-chart'), sr = this.scenario?.report;
    const w = sr?.quantifi?.website;
    if (!el || !sr || !w) return;
    const chart = this.baseChart(el);
    const web = chart.addSeries(LineSeries, { color: GRAY, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    web.setData(w.series.time.map((t, i) => ({ time: t as UTCTimestamp, value: w.series.pnl[i] })));
    const sc = chart.addSeries(LineSeries, { color: BLUE, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    sc.setData(sr.series.time.map((t, i) => ({ time: t as UTCTimestamp, value: sr.series.pnl[i] })));
    chart.timeScale().fitContent();
  }

  private greeksHtml(r: Report) {
    const q = r.quantifi!, g = q.greeks!, c = q.constants;
    const rng = (a: number[]) => { const v = a.filter(Number.isFinite); return v.length ? [Math.min(...v), Math.max(...v)] : [0, 0]; };
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
    const [dlo, dhi] = rng(g.net_delta), [vlo, vhi] = rng(g.vega), [glo, ghi] = rng(g.gamma);
    const nearCap = c.VEGA_CAP_PER_PCT ? g.vega.filter(v => Math.abs(v) >= 0.95 * c.VEGA_CAP_PER_PCT).length / Math.max(1, g.vega.length) : null;
    const f = (x: number, d = 0) => `${x < 0 ? '−' : ''}${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
    const pane = (k: string, title: string, sub: string) => `<div class="gk-pane"><div class="gk-l"><b>${title}</b><span class="muted">${sub}</span></div><div class="gk-chart" data-g="${k}"></div></div>`;
    return `<div class="dk-sec"><div class="dk-h1">Greeks<span class="spacer"></span><span class="muted gk-note">Black–Scholes per strike at its own implied vol (mid);
        days to expiry ${q.days.map(d => `${q.tte[String(d)]}`).join(' / ')} at the open of days ${q.days.join(' / ')}; every 10 ticks</span></div>
      <div class="kstats">${this.stat('Net delta', `${f(dlo)} to ${f(dhi)}`, `<span class="muted">mean |Δ| ${f(mean(g.net_delta.map(Math.abs)), 1)}</span>`, '', 'Option delta plus the LYCHEE position, in LYCHEE units')}
        ${this.stat('Net vega', `${f(vlo)} to ${f(vhi)}`, `<span class="muted">${nearCap === null ? 'coins per 1% IV' : `${pct(nearCap, 0)} of time near the ±${c.VEGA_CAP_PER_PCT} cap`}</span>`, '', 'Coins of PnL per 1% relative move in implied vol')}
        ${this.stat('Net gamma', `${f(glo, 3)} to ${f(ghi, 3)}`, '<span class="muted">delta per coin of LYCHEE</span>')}
        ${this.stat('Theta per day', `${f(mean(g.theta))}`, `<span class="muted">mean · range ${f(rng(g.theta)[0])} to ${f(rng(g.theta)[1])}</span>`, cls(mean(g.theta)), 'Coins per day of time decay, held fixed')}</div></div>
      <div class="dk-sec gk-panes">
        ${pane('delta', 'Net delta', `options + LYCHEE hedge${c.DELTA_BAND ? ` · dotted: hedge band ±${c.DELTA_BAND}` : ''}`)}
        ${pane('vega', 'Net vega', `coins per 1% IV${c.VEGA_CAP_PER_PCT ? ` · dotted: cap ±${c.VEGA_CAP_PER_PCT}` : ''}`)}
        ${pane('gamma', 'Net gamma', 'delta change per coin of LYCHEE')}
        ${pane('theta', 'Theta', 'coins per day')}</div>`;
  }

  private greeksCharts(r: Report) {
    const q = r.quantifi!, g = q.greeks!, c = q.constants;
    const t = g.time as UTCTimestamp[];
    const charts: IChartApi[] = [];
    const draw = (k: string, lines: { v: number[]; color: string; width?: 1 | 2; title?: string }[], refs: number[] = [], digits?: number) => {
      const el = this.el.querySelector<HTMLElement>(`[data-g="${k}"]`);
      if (!el) return;
      const chart = this.baseChart(el);
      if (digits !== undefined) chart.applyOptions({ localization: { priceFormatter: (p: number) => p.toFixed(digits) } });
      chart.applyOptions({ handleScroll: true, handleScale: true });
      lines.forEach((l, i) => {
        const s = chart.addSeries(LineSeries, { color: l.color, lineWidth: l.width ?? 1, priceLineVisible: false, lastValueVisible: i === 0, title: l.title ?? '' });
        s.setData(t.map((x, j) => ({ time: x, value: l.v[j] })));
        if (i === 0) for (const p of refs) s.createPriceLine({ price: p, color: DOWN, lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: true });
      });
      chart.timeScale().fitContent();
      charts.push(chart);
    };
    const band = c.DELTA_BAND ? [c.DELTA_BAND, -c.DELTA_BAND] : [];
    draw('delta', [{ v: g.net_delta, color: BLUE, width: 2, title: 'net' }, { v: g.opt_delta, color: '#B2B5BE', title: 'options' }, { v: g.lychee, color: '#FF9800', title: 'LYCHEE' }], band, 0);
    draw('vega', [{ v: g.vega, color: '#9C27B0', width: 2 }], c.VEGA_CAP_PER_PCT ? [c.VEGA_CAP_PER_PCT, -c.VEGA_CAP_PER_PCT] : [], 0);
    draw('gamma', [{ v: g.gamma, color: UP, width: 2 }], [], 3);
    draw('theta', [{ v: g.theta, color: '#FF9800', width: 2 }], [], 0);
    // one time axis: zooming or scrolling any pane moves them all
    let syncing = false;
    for (const a of charts) a.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (syncing || !range) return;
      syncing = true;
      for (const b of charts) if (b !== a) b.timeScale().setVisibleLogicalRange(range);
      syncing = false;
    });
  }

  // ---------------------------------------------------------------- optimiser (Optuna TPE on our Pine engine)
  private optKey() { const st = this.app.view.strategy; return st ? st.script.id ?? `inline:${st.name}` : ''; }
  private optState(r: StrategyRun): OptState {
    const key = this.optKey();
    if (!this.opt || this.opt.key !== key) {
      this.opt = { key, objective: 'net_profit', trials: 150, min_trades: 20, oos_pct: 30, folds: 0, symbols: this.app.view.symbol,
        space: r.space.map(x => ({ ...x })), job: null, presets: [] };
      void api.getSetting<Record<string, Preset[]>>('strategy_presets').then(p => { if (this.opt?.key === key) { this.opt.presets = p?.[key] ?? []; this.renderOptResults(); } }).catch(() => {});
    }
    return this.opt;
  }

  private optimizeHtml(r: StrategyRun) {
    const o = this.optState(r), running = o.job?.status === 'running';
    const objectives: [string, string][] = [['net_profit', 'Net profit'], ['profit_factor', 'Profit factor'], ['sharpe', 'Sharpe ratio'], ['sortino', 'Sortino ratio'],
      ['win_rate', 'Percent profitable'], ['return_dd', 'Return / max drawdown'], ['max_drawdown', 'Max drawdown % (minimise)']];
    const row = (x: SpaceRow, i: number) => `<tr data-row="${i}"><td><label class="chk-row"><input type="checkbox" data-f="enabled" ${x.enabled ? 'checked' : ''}/>${esc(x.title)}</label></td>
      ${x.kind === 'range' ? `<td><input type="number" step="any" data-f="low" value="${x.low}"/></td><td><input type="number" step="any" data-f="high" value="${x.high}"/></td>
        <td><input type="number" step="any" data-f="step" value="${x.step}"/></td>`
        : `<td colspan="3" class="muted">${(x.choices ?? []).map(c => esc(c)).join(', ')}</td>`}<td class="muted num">${esc(x.default)}</td></tr>`;
    return `<div class="dk-sec"><div class="dk-h1">Optimize inputs<span class="spacer"></span></div>
      <div class="opt-grid"><div><table class="opt-space"><thead><tr><th>Input</th><th>From</th><th>To</th><th>Step</th><th class="num">Default</th></tr></thead>
        <tbody>${o.space.length ? o.space.map(row).join('') : '<tr><td colspan="5" class="muted">This strategy has no numeric or choice inputs.</td></tr>'}</tbody></table></div>
      <div class="form-grid opt-form">
        <label>Objective</label><select data-o="objective">${objectives.map(([k, l]) => `<option value="${k}" ${k === o.objective ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label>Trials</label><input type="number" min="5" max="2000" data-o="trials" value="${o.trials}"/>
        <label title="Trials with fewer closed trades are rejected">Minimum trades</label><input type="number" min="0" data-o="min_trades" value="${o.min_trades}"/>
        <label title="The search never sees the last part of the history; the best trials are scored on it afterwards">Out-of-sample</label>
          <span class="pair"><input type="number" min="0" max="60" data-o="oos_pct" value="${o.oos_pct}"/><span class="muted">% of bars</span></span>
        <label title="Anchored walk-forward: each fold optimises on all bars before its test window (0 = off)">Walk-forward folds</label>
          <input type="number" min="0" max="10" data-o="folds" value="${o.folds}"/>
        <label title="Comma-separated; the objective is averaged over the symbols">Symbols</label><input data-o="symbols" value="${esc(o.symbols)}"/>
        <span></span><span class="pair">${running ? '<button class="pill-btn light" data-a="opt-cancel">Cancel</button>'
          : '<button class="pill-btn" data-a="opt-run">Run optimization</button>'}</span>
      </div></div></div>
      <div class="dk-sec" data-opt-results style="padding-bottom:24px"></div>`;
  }

  private readOptForm() {
    const o = this.opt;
    if (!o) return;
    this.el.querySelectorAll<HTMLInputElement>('[data-o]').forEach(el => {
      const k = el.dataset.o as 'objective' | 'symbols' | 'trials' | 'min_trades' | 'oos_pct' | 'folds';
      if (k === 'objective' || k === 'symbols') o[k] = el.value; else o[k] = Number(el.value);
    });
    this.el.querySelectorAll<HTMLElement>('[data-row]').forEach(tr => {
      const x = o.space[Number(tr.dataset.row)];
      tr.querySelectorAll<HTMLInputElement>('[data-f]').forEach(el => {
        if (el.dataset.f === 'enabled') x.enabled = el.checked; else (x as unknown as Record<string, number>)[el.dataset.f!] = Number(el.value);
      });
    });
  }

  private async runOptimize() {
    this.readOptForm();
    const o = this.opt, v = this.app.view, st = v.strategy;
    if (!o || !st) return;
    try {
      o.job = await api.optimize({ script: st.script, symbols: o.symbols.split(',').map(x => x.trim()).filter(Boolean), timeframe: v.timeframe,
        count: 5000, adjustment: v.adjustment === 'dividends' ? 'dividends' : undefined, space: o.space, objective: o.objective,
        trials: o.trials, min_trades: o.min_trades, oos_pct: o.oos_pct, folds: o.folds, props: st.props, inputs: st.inputs });
    } catch (e) { toast(`Optimization failed: ${esc((e as Error).message)}`, 10000); return; }
    this.render();
    this.pollOpt();
  }
  private pollOpt() {
    clearTimeout(this.optTimer);
    const o = this.opt;
    if (!o?.job || o.job.status !== 'running') return;
    this.optTimer = window.setTimeout(async () => {
      if (!this.opt?.job) return;
      try { this.opt.job = await api.optimizeJob(this.opt.job.id); } catch { /* server restarted */ return; }
      if (this.opt.job.status !== 'running') {
        if (this.opt.job.status === 'error') toast(`Optimization failed: ${esc(this.opt.job.error)}`, 15000);
        if (this.view === 'optimize') { this.readOptForm(); this.render(); }
      } else this.renderOptResults();
      this.pollOpt();
    }, 700);
  }

  private renderOptResults() {
    const box = this.el.querySelector<HTMLElement>('[data-opt-results]'), o = this.opt;
    if (!box || !o) return;
    const j = o.job, obj = j?.objective ?? o.objective;
    const presets = o.presets.length ? `<div class="dk-h2">Presets</div><div class="opt-presets">${o.presets.map((p, i) => `<span class="dk-chip static">${esc(p.name)}
      <button class="wbtn" data-a="preset-apply" data-i="${i}" data-tip="Apply to the chart">${icon('check', 18)}</button>
      <button class="wbtn" data-a="preset-del" data-i="${i}" data-tip="Delete preset">${icon('trash', 18)}</button></span>`).join('')}</div>` : '';
    if (!j) { box.innerHTML = `${presets}<div class="muted">Pick the inputs and ranges to search, then run. Trials run in parallel on the server (Optuna TPE).</div>`; return; }
    const pctDone = j.total ? Math.round(j.done / j.total * 100) : 0;
    const head = `<div class="opt-progress"><div class="bar"><i style="width:${pctDone}%"></i></div><span>${j.status === 'running' ? `${esc(j.phase)} · ` : ''}${j.done}/${j.total} trials
      · ${j.elapsed.toFixed(1)}s${j.status === 'cancelled' ? ' · cancelled' : j.status === 'error' ? ` · <span class="down">${esc(j.error)}</span>` : ''}</span></div>`;
    const v = (m: OptMetrics | null | undefined, k: keyof OptMetrics) => (!m ? '—' : k === 'trades' ? String(m.trades)
      : ['return_pct', 'win_rate', 'max_drawdown'].includes(k) ? pct(m[k]) : m[k].toFixed(2));
    const params = (p: Record<string, unknown>) => Object.entries(p).map(([k, x]) => `<span class="muted">${esc(k)}</span> ${esc(x)}`).join(' · ') || '<span class="muted">current settings</span>';
    const label = (k: string) => ({ net_profit: 'Net profit', profit_factor: 'PF', sharpe: 'Sharpe', sortino: 'Sortino', win_rate: 'Win %', return_dd: 'Ret/DD', max_drawdown: 'Max DD' }[k] ?? k);
    const objCell = (m?: OptMetrics | null) => (!m ? '—' : obj === 'net_profit' ? money(m.net_profit) : v(m, obj as keyof OptMetrics));
    const hasOos = !!j.leaderboard.some(r => r.oos);
    const tr = (r: OptRow, i: number) => `<tr><td class="num">${r.fold ? `F${r.fold}` : i + 1}</td><td class="opt-params">${params(r.params)}</td>
      <td class="num">${objCell(r.is)}</td><td class="num ${cls(r.is.return_pct)}">${v(r.is, 'return_pct')}</td><td class="num">${v(r.is, 'profit_factor')}</td>
      <td class="num">${v(r.is, 'max_drawdown')}</td><td class="num">${r.is.trades}</td>
      ${hasOos ? `<td class="num sep">${objCell(r.oos)}</td><td class="num ${cls(r.oos?.return_pct)}">${v(r.oos, 'return_pct')}</td><td class="num">${v(r.oos, 'trades')}</td>` : ''}
      <td class="acts"><button class="wbtn" data-a="opt-apply" data-i="${i}" data-tip="Apply to the chart">${icon('check', 18)}</button>
        <button class="wbtn" data-a="opt-preset" data-i="${i}" data-tip="Save as preset">${icon('star', 18)}</button>
        <button class="wbtn" data-a="opt-export" data-i="${i}" data-tip="Export Pine with these defaults">${icon('code', 18)}</button></td></tr>`;
    const b = j.baseline;
    const base = b ? `<div class="note">Current settings: ${label(obj)} ${objCell(b.is)} in-sample (${b.is.trades} trades)${b.oos ? `, ${objCell(b.oos)} out-of-sample (${b.oos.trades} trades)` : ''}.
      ${hasOos ? 'Out-of-sample columns replay the top trials on the bars the search never saw; a large drop from in-sample means the inputs are curve-fitted.' : ''}</div>` : '';
    const wf = j.walk_forward;
    const wfHtml = wf ? `<div class="dk-h2">Walk-forward</div><div class="kstats">
        ${this.stat('Stitched out-of-sample return', pct(wf.total.return_pct), '', cls(wf.total.return_pct), 'Fold test-window returns compounded')}
        ${this.stat('Profitable folds', `${wf.total.profitable_folds}/${wf.total.folds}`)}
        ${this.stat('Out-of-sample trades', String(wf.total.trades))}
        ${this.stat('Walk-forward efficiency', wf.total.efficiency === null ? '—' : pct(wf.total.efficiency, 0), '', '', 'Out-of-sample return per bar / in-sample return per bar; above ~50% is usually considered robust')}</div>
      <table class="opt-table"><thead><tr><th>Fold</th><th>Trained to</th><th>Tested to</th><th>Best inputs</th><th class="num">IS return</th><th class="num">OOS return</th><th class="num">OOS trades</th></tr></thead>
        ${wf.folds.map(f => `<tr><td>${f.fold}</td><td>${f.train_end ? date(new Date(f.train_end * 1000).toISOString().slice(0, 10)) : '—'}</td>
          <td>${f.test_end ? date(new Date(f.test_end * 1000).toISOString().slice(0, 10)) : 'end'}</td><td class="opt-params">${f.params ? params(f.params) : '<span class="muted">no trial met the minimum trades</span>'}</td>
          <td class="num ${cls(f.is?.return_pct)}">${v(f.is, 'return_pct')}</td><td class="num ${cls(f.oos?.return_pct)}">${v(f.oos, 'return_pct')}</td><td class="num">${v(f.oos, 'trades')}</td></tr>`).join('')}</table>` : '';
    box.innerHTML = `${head}${presets}${base}${wfHtml}${j.leaderboard.length ? `<div class="dk-h2">${wf ? 'Top trials per fold' : 'Leaderboard'}</div>
      <table class="opt-table"><thead><tr><th>#</th><th>Inputs</th><th class="num">${label(obj)}</th><th class="num">Return</th><th class="num">PF</th><th class="num">Max DD</th><th class="num">Trades</th>
        ${hasOos ? `<th class="num sep">OOS ${label(obj)}</th><th class="num">OOS return</th><th class="num">OOS trades</th>` : ''}<th></th></tr></thead>
        ${j.leaderboard.map(tr).join('')}</table>` : j.status === 'running' ? '' : '<div class="muted">No trial met the minimum number of trades.</div>'}`;
  }

  private async optAction(a: string, i: number) {
    const o = this.opt, v = this.app.view, st = v.strategy;
    if (!o || !st) return;
    const params = a.startsWith('preset') ? o.presets[i]?.inputs : o.job?.leaderboard[i]?.params;
    if (!params) return;
    if (a === 'opt-apply' || a === 'preset-apply') {
      this.showPending(st.name);
      await v.setStrategy({ ...st, inputs: { ...st.inputs, ...params } });
    } else if (a === 'opt-preset') {
      const name = await promptText('Save preset', Object.values(params).join(' / '));
      if (!name) return;
      o.presets = [...o.presets, { name, inputs: params }];
      await this.savePresets();
    } else if (a === 'preset-del') {
      o.presets = o.presets.filter((_, k) => k !== i);
      await this.savePresets();
    } else if (a === 'opt-export') {
      try {
        const out = await api.exportStrategy(st.script, { ...st.inputs, ...params });
        const saved = await pineScriptDialog(out.source, `${st.name || out.name} (optimized)`);
        if (saved) toast(`Saved "${esc(saved.name)}" to My scripts`);
      } catch (e) { toast(`Export failed: ${esc((e as Error).message)}`, 10000); }
    }
  }
  private async savePresets() {
    const o = this.opt!;
    const all = (await api.getSetting<Record<string, Preset[]>>('strategy_presets').catch(() => null)) ?? {};
    all[o.key] = o.presets;
    await api.setSetting('strategy_presets', all);
    this.renderOptResults();
  }

  // ---------------------------------------------------------------- events
  private async runsMenu(_anchor?: HTMLElement) {
    try {
      if (!this.runs) this.runs = await api.btRuns(undefined, '');
    } catch (e) { toast(`Saved runs unavailable: ${esc((e as Error).message)}`); return; }
    const pick = await runsDialog(this.runs, this.runId);
    if (pick?.open) await this.loadRun(pick.open);
    else if (pick?.action === 'new') await this.newBacktest();
    else if (pick?.action === 'quantifi') await this.newQuantifiRun();
    else if (pick?.action === 'pine') await this.app.openIndicators('strategies');
  }

  private rangeMenu(anchor: HTMLElement) {
    const r = this.report!, start = r.meta.start, end = new Date(`${r.meta.end}T00:00:00Z`);
    const back = (y: number) => { const d = new Date(end); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
    const rerun = (s: string) => this.newBacktest({ ...this.paramsFromReport(), start: s });
    openMenu(anchor, [{ section: 'Run again from' }, { label: 'Last year', hint: back(1), onClick: () => rerun(back(1)) },
      { label: 'Last 3 years', hint: back(3), onClick: () => rerun(back(3)) }, { label: 'Last 5 years', hint: back(5), onClick: () => rerun(back(5)) },
      { label: 'Same range', hint: start, onClick: () => rerun(start) }], { name: 'bt-range', minWidth: 240 });
  }

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a) {
      const anchor = t.closest<HTMLElement>('[data-a]')!;
      if (a === 'close') this.toggle(false);
      if (a === 'collapse') { this.el.classList.toggle('collapsed'); this.setMax(false); this.renderHead(); }
      if (a === 'max') { this.setMax(!this.el.classList.contains('max')); this.renderHead(); }
      if (a === 'runs') void this.runsMenu(anchor);
      if (a === 'new') void this.newBacktest();
      if (a === 'settings') void this.newBacktest();
      if (a === 'range') this.rangeMenu(anchor);
      if (a === 'add-strategy') void this.app.openIndicators('strategies');
      if (a === 'qf-new') void this.newQuantifiRun();
      if (a === 'st-run') void this.runScenario();
      if (a === 'st-open' && this.scenario?.runId) { const id = this.scenario.runId; this.view = 'overview'; void this.loadRun(id); }
      if (a === 'st-website' && this.report?.quantifi?.website) { const id = this.report.quantifi.website.run; this.view = 'overview'; void this.loadRun(id); }
      if (a === 'props') void this.app.editStrategy(this.app.view, 'properties');
      if (a === 'inputs') void this.app.editStrategy(this.app.view, 'inputs');
      if (a === 'inst-back') { this.inst = null; this.render(); }
      if (a === 'inst-chart' && this.inst?.data && this.report) void this.app.showRunInstrument(this.inst.data, this.report);
      if (a === 'opt-run') void this.runOptimize();
      if (a === 'opt-cancel' && this.opt?.job) void api.optimizeCancel(this.opt.job.id);
      if (a.startsWith('opt-') && a !== 'opt-run' && a !== 'opt-cancel' || a.startsWith('preset-')) void this.optAction(a, Number(anchor.dataset.i));
      if (a === 'csv') this.exportCsv();
      if (a === 'sort') { this.sortAsc = !this.sortAsc; this.render(); }
      if (a === 'perf-shot') this.downloadPerf();
      if (a === 'pnl-all') { this.pnlAll = !this.pnlAll; this.renderPerfTab(); }
      return;
    }
    const std = t.closest<HTMLElement>('[data-std]')?.dataset.std;
    if (std !== undefined) {
      this.stressPick.d = Number(std);
      try { localStorage.setItem('qf_stress', JSON.stringify(this.stressPick)); } catch { /* ignore */ }
      this.render();
      return;
    }
    const v = t.closest<HTMLElement>('[data-view]')?.dataset.view as StrategyDock['view'] | undefined;
    if (v) { if (this.view === 'optimize') this.readOptForm(); if (v === 'instruments' && this.view === 'instruments') this.inst = null; this.view = v; this.render(); return; }
    const itab = t.closest<HTMLElement>('[data-itab]')?.dataset.itab as typeof this.instTab | undefined;
    if (itab && t.closest('.tabs-pill')) { this.instTab = itab; this.render(); return; }
    const instf = t.closest<HTMLElement>('[data-instf]')?.dataset.instf as typeof this.instFilter | undefined;
    if (instf) { this.instFilter = instf; this.render(); return; }
    const inst = t.closest<HTMLElement>('[data-inst]')?.dataset.inst;
    if (inst) { void this.openInstrument(inst); return; }
    const go = t.closest<HTMLElement>('[data-goto]')?.dataset.goto;
    if (go && this.inst?.data) {
      const at = /^\d+$/.test(go) ? Number(go) : Date.parse(`${go}T00:00:00Z`) / 1000;   // QuantiFi rows carry unix seconds
      void this.app.showRunInstrument(this.inst.data, this.report!).then(() => this.app.view.goTo(at));
      return;
    }
    const ser = t.closest<HTMLElement>('[data-series]')?.dataset.series as keyof StrategyDock['show'] | undefined;
    if (ser) { this.show[ser] = !this.show[ser]; this.render(); return; }
    const pt = t.closest<HTMLElement>('[data-perf]')?.dataset.perf;
    if (pt && t.closest('.tabs-pill')) { this.perfTab = pt as PerfTab; this.render(); return; }
    const tt = t.closest<HTMLElement>('[data-trades]')?.dataset.trades;
    if (tt && t.closest('.tabs-pill')) { this.tradesTab = tt as TradesTab; this.render(); return; }
    const f = t.closest<HTMLElement>('[data-freq]')?.dataset.freq;
    if (f) { this.freq = f as typeof this.freq; this.renderPerfTab(); return; }
    const by = t.closest<HTMLElement>('[data-pnlby]')?.dataset.pnlby;
    if (by) { this.pnlBy = by as typeof this.pnlBy; this.renderPerfTab(); return; }
    const trade = t.closest<HTMLElement>('[data-trade]');
    if (trade && this.report) {
      const tr = this.report.trades.find(x => x.n === Number(trade.dataset.trade))!;
      if (this.report.meta.kind === 'pine') this.app.view.goTo(tr.entry_time ?? 0); else void this.app.showTrade(tr, this.report);
      return;
    }
    const sym = t.closest<HTMLElement>('[data-sym]')?.dataset.sym;
    if (sym && this.report) void this.app.showRunSymbol(sym, this.report);
  }

  private downloadPerf() {
    const c = this.charts[0];
    if (!c) return;
    const a = document.createElement('a');
    a.href = c.takeScreenshot().toDataURL('image/png');
    a.download = `${this.report?.meta.name ?? 'strategy'}_performance.png`;
    a.click();
  }
}

interface Preset { name: string; inputs: Record<string, unknown> }
interface OptState {
  key: string; objective: string; trials: number; min_trades: number; oos_pct: number; folds: number; symbols: string;
  space: SpaceRow[]; job: OptJob | null; presets: Preset[];
}

// ------------------------------------------------------------------------------------- small SVG charts
/** Grouped vertical bars with a zero line; `pct` formats the axis as percentages. */
interface BarSpec { groups: { label: string; values: { v: number | null; color: string }[] }[]; pct: boolean; decimals: number }
function barsSvg(groups: BarSpec['groups'], pct: boolean, decimals = 1, W = 600): string {
  if (!groups.length) return '<div class="muted" style="padding:24px 0">No data</div>';
  const H = 240, L = 4, R = 56, T = 12, B = 24;
  const vals = groups.flatMap(g => g.values.map(v => v.v ?? 0));
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.08; hi += hi > 0 ? pad : 0; lo -= lo < 0 ? pad : 0;
  const y = (v: number) => T + (hi - v) / (hi - lo) * (H - T - B);
  const n = groups.length, slot = (W - L - R) / n, k = groups[0].values.length;
  const bw = Math.max(1, Math.min(28, slot * 0.8 / k));
  const fmt = (v: number) => (pct ? `${(v * 100).toFixed(decimals)}%` : String(Math.round(v)));
  const ticks = niceTicks(lo, hi, 4);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 64))));
  let s = `<svg class="bars-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`;
  for (const tv of ticks) s += `<line x1="${L}" x2="${W - R}" y1="${y(tv)}" y2="${y(tv)}" stroke="var(--line-soft)"/><text x="${W - R + 6}" y="${y(tv) + 4}">${fmt(tv)}</text>`;
  s += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--faint)"/>`;
  groups.forEach((g, i) => {
    const x0 = L + i * slot + (slot - bw * k) / 2;
    g.values.forEach((v, j) => {
      if (v.v === null) return;
      const top = Math.min(y(v.v), y(0)), h = Math.max(1, Math.abs(y(v.v) - y(0)));
      s += `<rect x="${x0 + j * bw}" y="${top}" width="${bw * 0.92}" height="${h}" fill="${v.color}" rx="1"><title>${esc(g.label)}: ${fmt(v.v)}</title></rect>`;
    });
    if (i % every === 0) s += `<text x="${L + i * slot + slot / 2}" y="${H - 8}" text-anchor="middle">${esc(g.label)}</text>`;
  });
  return `${s}</svg>`;
}

function niceTicks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => span / st <= n) ?? raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(+v.toFixed(12));
  return out;
}

function donutSvg(parts: { v: number; color: string }[], big: string, small: string): string {
  const total = parts.reduce((s, p) => s + p.v, 0) || 1, R = 60, r = 42, C = 70;
  let a = -Math.PI / 2, s = `<svg width="140" height="140" viewBox="0 0 140 140" role="img">`;
  for (const p of parts) {
    if (!p.v) continue;
    const b = a + (p.v / total) * Math.PI * 2 - 1e-6, large = b - a > Math.PI ? 1 : 0;
    const pt = (rad: number, ang: number) => `${C + rad * Math.cos(ang)} ${C + rad * Math.sin(ang)}`;
    s += `<path d="M ${pt(R, a)} A ${R} ${R} 0 ${large} 1 ${pt(R, b)} L ${pt(r, b)} A ${r} ${r} 0 ${large} 0 ${pt(r, a)} Z" fill="${p.color}"/>`;
    a = b;
  }
  return `${s}<text x="70" y="70" text-anchor="middle" style="font-size:18px;font-weight:600;fill:var(--fg)">${esc(big)}</text>
    <text x="70" y="88" text-anchor="middle" style="font-size:11px;fill:var(--muted)">${esc(small)}</text></svg>`;
}
