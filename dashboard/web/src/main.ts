// App shell: chart grid, toolbars (top, left, bottom, right), keyboard shortcuts, undo/redo,
// layout persistence and sync, and the strategy report dock.
import { api, type ChartState, type GridMode, type LayoutMeta, type LayoutState, type LayoutSync, type InstrumentDetail, type Report, type ReportTrade, type StrategyRun } from './api';
import { tickInterval } from './chart/util';
import { ChartView, DEFAULT_PROPS, parseInterval, type ChartProps, type ChartType, type CursorStyle, type Snapshot, type TradeMark } from './chart/view';
import type { UTCTimestamp } from 'lightweight-charts';
import { create as createDrawing, type ToolType } from './drawings/model';
import type { Magnet, Tool } from './drawings/layer';
import type { Inputs } from './indicators';
import {
  alertDialog, closeDialog, esc, strategySettings, goToDialog, indicatorPicker, isDialogOpen, layoutsDialog, promptText, quickSearch, settingsDialog,
  shortcutsDialog, studySettings, symbolSearch, toast, type QuickAction,
} from './ui/dialogs';
import { closeMenu, initTooltips, isMenuOpen } from './ui/menu';
import { TopBar } from './ui/topbar';
import { DrawBar, GROUPS } from './ui/drawbar';
import { BottomBar, RANGES, TIMEZONES } from './ui/bottombar';
import { WidgetBar } from './ui/widgetbar';
import { StrategyDock, money } from './ui/strategy';
import { CHART_TYPES } from './chart/view';

const GRID_CELLS: Record<GridMode, number> = { '1': 1, '2h': 2, '2v': 2, '3h': 3, '3v': 3, '4': 4 };
const DEFAULT_CHART: ChartState = { symbol: 'SSE:510300', timeframe: 'D', studies: [], drawings: {} };
const DEFAULT_SYNC: LayoutSync = { symbol: false, interval: false, crosshair: true, time: false };
const UNNAMED = 'Unnamed';
const HISTORY_LIMIT = 100;
const VERB: Record<string, string> = { create: 'create drawing', remove: 'remove drawing', move: 'move drawing', edit: 'edit drawing',
  'remove all': 'remove drawings', 'chart type': 'change chart type', compare: 'compare symbol' };

interface History { undo: { snap: Snapshot; label: string }[]; redo: { snap: Snapshot; label: string }[]; last: Snapshot }
interface Template { name: string; studies: { id: string; inputs: Inputs }[] }

export class App {
  charts: ChartView[] = [];
  active = 0;
  grid: GridMode = '1';
  layoutId: number | undefined;
  layoutName = UNNAMED;
  autosave = true;
  dirty = false;
  watchlistId: number | undefined;
  sync: LayoutSync = { ...DEFAULT_SYNC };
  magnetMode: Magnet = 'off';
  lastMagnet: Magnet = 'weak';
  keepDrawing = false;
  lockAll = false;
  hideDrawings = false;
  hideStudies = false;
  cursorStyle: CursorStyle = 'cross';
  feedState: 'tradingview' | 'local' | 'offline' = 'tradingview';
  activeRange: string | null = null;
  props: ChartProps = { ...DEFAULT_PROPS };
  private hist = new Map<ChartView, History>();
  private saveTimer = 0;
  private restoring = false;
  private typed = '';            // keystrokes typed on the chart (symbol / interval quick entry)
  private typedTimer = 0;
  private lastPointer: { view: ChartView; x: number; y: number } | null = null;
  readonly gridEl = document.getElementById('grid')!;
  topbar!: TopBar;
  drawbar!: DrawBar;
  bottombar!: BottomBar;
  widgets!: WidgetBar;
  strategy!: StrategyDock;

  get view() { return this.charts[this.active]; }

  async start() {
    let theme = 'light';
    try { theme = localStorage.getItem('theme') ?? 'light'; } catch { /* storage unavailable */ }
    document.documentElement.dataset.theme = theme;
    try { this.props = { ...DEFAULT_PROPS, ...(await api.getSetting<Partial<ChartProps>>('chart_props') ?? {}) }; } catch { /* first run */ }
    initTooltips();
    this.strategy = new StrategyDock(document.getElementById('dock')!, document.getElementById('dock-resizer')!, document.getElementById('center')!, this);
    this.strategy.toggle(false);
    this.topbar = new TopBar(document.getElementById('topbar')!, this);
    this.bindKeys();
    let state: LayoutState = { grid: '1', active: 0, charts: [DEFAULT_CHART] };
    try {
      const last = await api.getSetting<number>('last_layout');
      if (last) {
        const lay = await api.layout(last);
        state = lay.state; this.layoutId = lay.id; this.layoutName = lay.name;
      }
    } catch { /* first run */ }
    try { this.autosave = (await api.getSetting<boolean>('autosave')) ?? true; } catch { /* default on */ }
    await this.restore(state);
    this.drawbar = new DrawBar(document.getElementById('drawbar')!, this);
    this.bottombar = new BottomBar(document.getElementById('bottombar')!, this);
    this.widgets = new WidgetBar(document.getElementById('rightbar')!, document.getElementById('widget-pages')!, this);
    this.widgets.watchlist.onChange = id => { this.watchlistId = id; this.scheduleSave(); };
    await this.widgets.watchlist.init(state.watchlistId);
    this.widgets.alerts.init().catch(() => {});
    this.refreshChrome();
    this.pollHealth();
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }

  // ---------------------------------------------------------------- grid & charts
  async restore(state: LayoutState) {
    this.restoring = true;
    try {
      this.sync = { ...DEFAULT_SYNC, ...(state.sync ?? {}) };
      this.setGrid(state.grid ?? '1', false);
      await Promise.all(this.charts.map((v, i) => v.restore(state.charts[i] ?? state.charts[0] ?? DEFAULT_CHART)));
      this.activate(Math.min(state.active ?? 0, this.charts.length - 1));
      this.watchlistId = state.watchlistId;
      for (const v of this.charts) this.hist.set(v, { undo: [], redo: [], last: v.snapshot() });
    } finally {
      this.restoring = false;
    }
    this.dirty = false;
    this.refreshChrome();
  }

  setGrid(mode: GridMode, persist = true) {
    this.grid = mode;
    this.gridEl.dataset.grid = mode;
    const n = GRID_CELLS[mode];
    while (this.charts.length > n) { const v = this.charts.pop()!; this.hist.delete(v); v.destroy(); }
    while (this.charts.length < n) {
      const cell = document.createElement('div');
      this.gridEl.appendChild(cell);
      const v = new ChartView(cell, {
        onActivate: view => this.activate(this.charts.indexOf(view)),
        onChange: (view, kind, what) => this.onChartChange(view, kind, what),
        onStatus: (view, msg) => { if (view === this.view) document.body.dataset.status = msg; },
        onCrosshair: (view, _i, point) => this.onCrosshair(view, point),
        onRange: (view, range) => { if (this.sync.time) for (const o of this.charts) if (o !== view) o.syncRange(range); },
        onReplay: () => this.refreshChrome(),
        onStrategy: (view, run, err) => this.onStrategy(view, run, err),
      }, this.props);
      this.applyModes(v);
      cell.addEventListener('legend-settings', e => this.editStudy(v, (e as CustomEvent).detail.uid));
      cell.addEventListener('legend-symbol', () => this.openSymbolSearch(''));
      cell.addEventListener('strategy-settings', () => this.editStrategy(v));
      cell.addEventListener('strategy-report', () => { this.activate(this.charts.indexOf(v)); this.strategy.showStrategy(v.strategyRun, v.strategy?.name, true); });
      v.drawingLayer.onToolDone = () => { this.drawbar?.sync(); };
      cell.addEventListener('pointermove', e => {
        const r = v.host.getBoundingClientRect();
        this.lastPointer = { view: v, x: e.clientX - r.left, y: e.clientY - r.top };
      });
      // new cells start as a copy of the active chart's symbol (TradingView behavior)
      const src = this.view ?? null;
      this.charts.push(v);
      this.hist.set(v, { undo: [], redo: [], last: v.snapshot() });
      if (persist && src) v.load(src.symbol, src.timeframe);
    }
    if (this.active >= n) this.activate(0);
    if (persist) { this.scheduleSave(); this.refreshChrome(); }
  }

  activate(i: number) {
    if (i < 0 || !this.charts[i]) return;
    const changed = i !== this.active;
    this.active = i;
    this.charts.forEach((v, k) => v.el.classList.toggle('active', k === i));
    if (changed && this.strategy.kind === 'pine') this.strategy.showStrategy(this.view.strategyRun, this.view.strategy?.name);
    if (changed) this.refreshChrome();
  }

  private applyModes(v: ChartView) {
    const dl = v.drawingLayer;
    dl.magnetMode = this.magnetMode; dl.keepDrawing = this.keepDrawing; dl.locked = this.lockAll; dl.hidden = this.hideDrawings;
    v.setCursor(this.cursorStyle);
    if (this.hideStudies) v.setStudiesHidden(true);
  }

  private onChartChange(view: ChartView, kind: 'data' | 'edit' | 'select', what?: string) {
    const h = this.hist.get(view);
    if (h && kind === 'edit' && !this.restoring) {
      h.undo.push({ snap: h.last, label: VERB[what ?? ''] ?? what ?? 'change' });
      if (h.undo.length > HISTORY_LIMIT) h.undo.shift();
      h.redo = [];
    }
    if (h && kind !== 'select') h.last = view.snapshot();
    if (kind !== 'select') this.scheduleSave();
    if (view === this.view) this.refreshChrome();
  }

  /** Re-sync every bar with the active chart. */
  refreshChrome() {
    if (!this.view) return;
    this.topbar?.sync();
    this.drawbar?.sync();
    this.bottombar?.sync();
    this.widgets?.onChartChange();
    this.widgets?.sync();
    document.title = `${this.view.symbol.split(':').pop()} ${this.view.bars.at(-1)?.close ?? ''} · Chart Studio`;
  }

  // ---------------------------------------------------------------- symbol / interval / type
  /** Symbol changes go to the active chart, or every chart when the layout syncs symbols. */
  async loadSymbol(symbol: string) {
    const targets = this.sync.symbol ? this.charts : [this.view];
    await Promise.all(targets.map(v => v.load(symbol)));
  }
  async setInterval(tf: string) {
    this.activeRange = null;
    const targets = this.sync.interval ? this.charts : [this.view];
    await Promise.all(targets.map(v => v.setTimeframe(tf)));
  }
  setChartType(t: ChartType) { this.view.setChartType(t); this.refreshChrome(); }
  async customInterval() {
    const raw = await promptText('Add custom interval', '7', 'Add');
    const tf = raw ? parseInterval(raw) : null;
    if (tf) await this.setInterval(tf); else if (raw) toast(`Not an interval: ${esc(raw)} (examples: 7, 2h, 1D, 1W)`);
  }

  /** Bottom range bar: TradingView switches the interval for each range, then shows that span. */
  async setRange(label: string) {
    const r = RANGES.find(x => x.label === label);
    if (!r) return;
    const v = this.view;
    const counts: Record<string, number> = { '1': 1500, '5': 1500, '30': 1500, '60': 2300, '120': 2300, D: 600, W: 600, M: 1000 };
    const before = v.timeframe;
    if (v.timeframe !== r.tf || r.tf === 'M') await v.load(v.symbol, r.tf, counts[r.tf]);
    if (!v.bars.length) { toast(`${esc(r.tip)} is not available for ${esc(v.symbol)} from the ${esc(v.source || 'current')} feed`); await v.load(v.symbol, before); return; }
    const last = v.bars[v.bars.length - 1].time;
    const span = r.days === null ? null : r.days === 'ytd' ? last - Date.UTC(new Date(last * 1000).getUTCFullYear(), 0, 1) / 1000 : r.days * 86400;
    v.showSpan(span);
    this.activeRange = label;
    this.refreshChrome();
  }
  async goTo() {
    const v = this.view;
    const t = await goToDialog(v.bars.at(-1)?.time ?? Date.now() / 1000);
    if (t !== null && !v.goTo(t)) toast('No data at that date');
  }
  async toggleAdjustment() {
    const v = this.view;
    await v.setAdjustment(v.adjustment === 'dividends' ? 'splits' : 'dividends');
    this.scheduleSave();
    this.refreshChrome();
  }
  setTimezone(tz: string) { this.applyProps({ timezone: tz }); }

  // ---------------------------------------------------------------- tools & modes
  selectTool(tool: Tool) {
    for (const v of this.charts) v.setTool(v === this.view ? tool : 'cursor');
    this.drawbar?.sync();
  }
  setCursorStyle(s: CursorStyle) { this.cursorStyle = s; for (const v of this.charts) v.setCursor(s); }
  setMagnet(m: Magnet) {
    this.magnetMode = m;
    if (m !== 'off') this.lastMagnet = m;
    for (const v of this.charts) v.drawingLayer.magnetMode = m;
    this.drawbar.render();
  }
  setKeepDrawing(on: boolean) { this.keepDrawing = on; for (const v of this.charts) v.drawingLayer.keepDrawing = on; this.drawbar.sync(); }
  setLockAll(on: boolean) { this.lockAll = on; for (const v of this.charts) v.drawingLayer.locked = on; this.drawbar.render(); }
  setHidden(what: 'drawings' | 'indicators' | 'all', hide: boolean) {
    if (what !== 'indicators') { this.hideDrawings = hide; for (const v of this.charts) { v.drawingLayer.hidden = hide; v.drawingLayer.redraw(); } }
    if (what !== 'drawings') { this.hideStudies = hide; for (const v of this.charts) v.setStudiesHidden(hide); }
    this.drawbar.render();
  }
  removeAll(what: 'drawings' | 'indicators' | 'all') {
    const v = this.view;
    if (what !== 'indicators' && v.drawings().length) v.drawingLayer.clear();
    if (what !== 'drawings') for (const s of [...v.studies]) v.removeStudy(s.uid);
    this.refreshChrome();
  }

  // ---------------------------------------------------------------- undo / redo
  history() {
    const h = this.hist.get(this.view);
    return { undo: h?.undo.at(-1)?.label ?? '', redo: h?.redo.at(-1)?.label ?? '' };
  }
  undo() {
    const v = this.view, h = this.hist.get(v);
    const e = h?.undo.pop();
    if (!h || !e) return;
    h.redo.push({ snap: v.snapshot(), label: e.label });
    v.applySnapshot(e.snap);
    h.last = v.snapshot();
    this.refreshChrome();
  }
  redo() {
    const v = this.view, h = this.hist.get(v);
    const e = h?.redo.pop();
    if (!h || !e) return;
    h.undo.push({ snap: v.snapshot(), label: e.label });
    v.applySnapshot(e.snap);
    h.last = v.snapshot();
    this.refreshChrome();
  }

  // ---------------------------------------------------------------- dialogs
  pickSymbol(title = 'Symbol search') { return symbolSearch('', title); }
  async openSymbolSearch(initial: string) {
    const s = await symbolSearch(initial);
    if (s) await this.loadSymbol(s);
  }
  async openCompare() {
    const s = await symbolSearch('', 'Compare symbol');
    if (s) await this.view.addCompare(s);
  }
  async openIndicators(tab: 'indicators' | 'strategies' = 'indicators') {
    const pick = await indicatorPicker(tab);
    if (!pick) return;
    if (pick.kind === 'indicator') { this.view.addStudy(pick.id); return; }
    // one strategy per chart, like TradingView: adding another replaces it
    this.strategy.showPending(pick.name);
    await this.view.setStrategy({ script: pick.ref, name: pick.name, inputs: {}, props: {} });
  }
  /** Strategy Inputs / Properties dialog for the active chart's strategy; reruns it with the new values. */
  async editStrategy(v: ChartView = this.view, tab: 'inputs' | 'properties' = 'inputs') {
    const st = v.strategy, run = v.strategyRun;
    if (!st || !run) return;
    const next = await strategySettings(st.name || run.meta.name, run.inputs, run.props, st, tab);
    if (!next) return;
    if (v === this.view) this.strategy.showPending(st.name);
    await v.setStrategy({ ...st, inputs: next.inputs, props: { ...st.props, ...next.props } });
  }
  private onStrategy(v: ChartView, run: StrategyRun | null, error?: string) {
    if (v !== this.view) return;
    if (error) toast(`Strategy failed: ${esc(error)}`, 10000);
    // A chart strategy re-runs whenever the chart's symbol changes. Only take over the report panel when it is
    // showing that strategy: a saved-run report the user opened (e.g. an instrument page) must stay.
    if (this.strategy.kind === 'pine' || !this.strategy.report) this.strategy.showStrategy(v.strategy ? run : null, v.strategy?.name);
  }
  private async editStudy(v: ChartView, uid: string) {
    const s = v.studies.find(x => x.uid === uid);
    if (!s) return;
    const next = await studySettings(s.id, s.inputs);
    if (next) v.updateStudyInputs(uid, next);
  }

  /** Alt+A / Alert button. Like TradingView, the value defaults to the crosshair price (last close if the
   *  pointer is not over this chart). */
  async openAlert() {
    const v = this.view;
    const last = v.bars[v.bars.length - 1];
    if (!last) return;
    const p = this.lastPointer?.view === v ? v.drawingLayer.pointAt(this.lastPointer) : null;
    const draft = await alertDialog(v.symbol, v.timeframe, p?.price ?? last.close, v.studies.map(s => ({ id: s.id, inputs: s.inputs })));
    if (!draft) return;
    try {
      const a = await api.createAlert(draft);
      toast(`Alert created: ${esc(a.description)}`);
      this.widgets.alerts.refresh();
    } catch (e) { toast(`Alert failed: ${esc((e as Error).message)}`); }
  }

  toggleReplay() {
    const v = this.view;
    if (v.replay || v.replayPicking) v.exitReplay(); else v.startReplayPick();
    this.refreshChrome();
  }

  async openSettings() {
    const next = await settingsDialog(this.props, TIMEZONES());
    if (next) this.applyProps(next);
  }
  applyProps(p: Partial<ChartProps>) {
    this.props = { ...this.props, ...p };
    for (const v of this.charts) { v.setProps(this.props); v.renderLegend(); }
    api.setSetting('chart_props', this.props).catch(() => {});
    this.refreshChrome();
  }

  setTheme(t: string) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('theme', t); } catch { /* ignore */ }
    for (const v of this.charts) v.setProps({});
    if (this.strategy.open) this.strategy.render();
  }
  showShortcuts() { shortcutsDialog(); }
  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => toast('Fullscreen is not available'));
  }

  quickSearch() {
    const actions: QuickAction[] = [
      ...GROUPS.flatMap(g => g.sections.flatMap(s => s.items.map(i => ({ label: i.label, hint: i.hint, group: 'Drawing tools', run: () => this.drawbar.pick(i.id) })))),
      { label: 'Measure', group: 'Drawing tools', run: () => this.selectTool('measure') },
      { label: 'Zoom in', group: 'Drawing tools', run: () => this.selectTool('zoom') },
      ...CHART_TYPES.map(c => ({ label: c.label, group: 'Chart type', run: () => this.setChartType(c.id) })),
      ...['1', '5', '15', '30', '60', '240', 'D', 'W', 'M'].map(tf => ({ label: `Interval ${tf}`, group: 'Interval', run: () => void this.setInterval(tf) })),
      ...RANGES.map(r => ({ label: r.tip, group: 'Date range', run: () => void this.setRange(r.label) })),
      { label: 'Indicators', hint: '/', group: 'Functions', run: () => void this.openIndicators() },
      { label: 'Compare symbol', group: 'Functions', run: () => void this.openCompare() },
      { label: 'Create alert', group: 'Functions', run: () => void this.openAlert() },
      { label: 'Bar replay', group: 'Functions', run: () => this.toggleReplay() },
      { label: 'Strategy report', group: 'Functions', run: () => this.strategy.toggle(true) },
      { label: 'New backtest', group: 'Functions', run: () => void this.strategy.newBacktest() },
      { label: 'Go to date', group: 'Functions', run: () => void this.goTo() },
      { label: 'Adjust data for dividends', group: 'Settings', run: () => void this.toggleAdjustment() },
      { label: 'Chart settings', group: 'Settings', run: () => void this.openSettings() },
      { label: 'Dark theme', group: 'Settings', run: () => this.setTheme('dark') },
      { label: 'Light theme', group: 'Settings', run: () => this.setTheme('light') },
      { label: 'Download chart data', group: 'Layout', run: () => this.downloadData() },
      { label: 'Save layout', group: 'Layout', run: () => void this.saveLayout() },
      { label: 'Take a snapshot', group: 'Layout', run: () => void this.snapshot('download') },
    ];
    quickSearch(actions);
  }

  // ---------------------------------------------------------------- indicator templates
  async indicatorTemplates(): Promise<Template[]> {
    try { return (await api.getSetting<Template[]>('indicator_templates')) ?? []; } catch { return []; }
  }
  async saveIndicatorTemplate() {
    const v = this.view;
    if (!v.studies.length) { toast('Add indicators to the chart first'); return; }
    const name = await promptText('Save indicator template', v.studies.map(s => s.id).join(' + '));
    if (!name) return;
    const studies = v.studies.map(s => ({ id: s.id, inputs: { ...s.inputs } }));   // as confirmed, before any await
    const list = (await this.indicatorTemplates()).filter(t => t.name !== name);
    list.push({ name, studies });
    await api.setSetting('indicator_templates', list);
    toast(`Template “${esc(name)}” saved`);
  }
  applyIndicatorTemplate(t: Template) {
    const v = this.view;
    for (const s of [...v.studies]) v.removeStudy(s.uid);
    for (const s of t.studies) v.addStudy(s.id, s.inputs);
  }
  async deleteIndicatorTemplate(name: string) {
    await api.setSetting('indicator_templates', (await this.indicatorTemplates()).filter(t => t.name !== name));
  }

  // ---------------------------------------------------------------- crosshair sync
  private onCrosshair(view: ChartView, point: { time: number; price: number } | null) {
    if (view === this.view) this.widgets?.onCrosshair();
    if (!this.sync.crosshair || this.charts.length < 2) return;
    for (const o of this.charts) {
      if (o === view) continue;
      if (!point) { o.syncCrosshair(null); continue; }
      const bar = o.bars.find(b => b.time === point.time);
      if (bar) o.syncCrosshair({ time: point.time, price: o.symbol === view.symbol ? point.price : bar.close });
      else o.syncCrosshair(null);
    }
  }
  setSync(k: keyof LayoutSync, on: boolean) {
    this.sync = { ...this.sync, [k]: on };
    if (on && k === 'symbol') for (const v of this.charts) if (v !== this.view) v.load(this.view.symbol);
    if (on && k === 'interval') for (const v of this.charts) if (v !== this.view) v.setTimeframe(this.view.timeframe);
    this.scheduleSave();
  }

  // ---------------------------------------------------------------- strategy report <-> chart
  setStrategyTrades(r: Report) {
    const qf = r.meta.kind === 'quantifi';
    const marks = r.trades.flatMap(t => {
      const short = t.side === 'short';
      return [
        { date: t.entry_date, time: qf ? t.entry_time : undefined, side: short ? 'sell' as const : 'buy' as const, text: short ? 'Short' : 'Long', symbol: t.symbol },
        ...(t.open ? [] : [{ date: t.exit_date, time: qf ? t.exit_time : undefined, side: short ? 'buy' as const : 'sell' as const,
          text: `${t.pnl >= 0 ? '+' : '−'}${shortMoney(Math.abs(t.pnl))}`, symbol: t.symbol }]),
      ];
    });
    for (const v of this.charts) v.setTrades(marks);
    if (r.meta.kind !== 'quantifi') for (const v of this.charts) v.setRunOverlay(null);
  }
  /** Open a run's instrument with daily history covering the whole run, plus its trade markers. */
  /** Open one instrument of a saved run on the chart with every operation marked: buy / add below the bar,
   *  trim / sell above it (sells carry the holding period's P&L). */
  async showRunInstrument(d: InstrumentDetail, r: Report) {
    if (d.kind === 'quantifi') return this.showQuantifiInstrument(d, r);
    const marks: TradeMark[] = d.operations.filter(o => o.action !== 'open').map(o => (o.action === 'buy' || o.action === 'add'
      ? { date: o.date, side: 'buy' as const, symbol: d.symbol, text: o.action === 'buy' ? 'Buy' : 'Add', color: o.action === 'buy' ? '#2962FF' : '#7FA3FF' }
      : { date: o.date, side: 'sell' as const, symbol: d.symbol, color: o.action === 'sell' ? '#F23645' : '#F7949C',
          text: o.action === 'sell' ? `Sell ${(o.trip_pnl ?? 0) >= 0 ? '+' : '−'}${shortMoney(Math.abs(o.trip_pnl ?? 0))}` : 'Trim' }));
    await this.showRunSymbol(d.symbol, r, marks);
    // frame the chart on this instrument's activity (first operation to last, with a margin)
    const ts = d.operations.map(o => Date.parse(`${o.date}T00:00:00Z`) / 1000);
    if (ts.length) {
      const pad = Math.max(20 * 86400, (ts[ts.length - 1] - ts[0]) * 0.05);
      try { this.view.chart.timeScale().setVisibleRange({ from: (ts[0] - pad) as UTCTimestamp, to: (ts[ts.length - 1] + pad) as UTCTimestamp }); } catch { /* outside loaded data */ }
    }
  }
  /** A QuantiFi product on the upper chart: tick-level book (1 tick per bar unless already zoomed out), every fill (merged per
   *  bar; taken fills dark, resting light; pinned at its price on tick bars) and the run's overlay: best bid/ask, the
   *  strategy's quotes, its position and its own numbers. Framed on the first fills at tick level, on all activity otherwise. */
  private async showQuantifiInstrument(d: InstrumentDetail, r: Report) {
    const run = this.strategy.runId;
    const fills = d.operations.filter(o => o.qty !== 0 && o.time !== undefined);
    const marks: TradeMark[] = fills.map(o => ({ date: o.date, time: o.time, qty: o.qty, price: o.price, symbol: d.symbol, side: o.qty > 0 ? 'buy' as const : 'sell' as const,
      color: o.qty > 0 ? (o.kind === 'passive' ? '#7FA3FF' : '#2962FF') : (o.kind === 'passive' ? '#F7949C' : '#F23645') }));
    const overlay = run ? api.btOverlay(run, d.instrument).catch(() => null) : Promise.resolve(null);
    await this.showRunSymbol(d.symbol, r, marks);
    const o = await overlay;
    for (const v of this.charts) v.setRunOverlay(o && o.symbol === v.symbol ? o : null);
    const ts = fills.map(o => o.time!);
    if (!ts.length) return;
    const step = tickInterval(this.view.timeframe);
    const [from, to] = step ? [ts[0] - 60 * step, ts[0] + 540 * step]
      : [ts[0] - Math.max(300, (ts[ts.length - 1] - ts[0]) * 0.03), ts[ts.length - 1] + Math.max(300, (ts[ts.length - 1] - ts[0]) * 0.03)];
    try { this.view.chart.timeScale().setVisibleRange({ from: from as UTCTimestamp, to: to as UTCTimestamp }); } catch { /* outside loaded data */ }
  }
  async showRunSymbol(symbol: string, r: Report, marks?: TradeMark[]) {
    if (marks) for (const v of this.charts) v.setTrades(marks);
    else this.setStrategyTrades(r);
    if (r.meta.kind === 'quantifi') {                // tick data: one tick per bar, unless already on a QuantiFi intraday interval
      const cur = this.view.timeframe;
      const tf = this.view.symbol.startsWith('QUANTIFI:') && /^\d+S?$/.test(cur) ? cur : '1S';
      await this.view.load(symbol, tf, 40000);
      this.refreshChrome();
      return;
    }
    if (!symbol.includes(':')) {                  // US study tickers are bare: let TradingView name the exchange
      try { symbol = String((await api.symbol(symbol)).pro_name ?? symbol); } catch { /* sidecar down: load as is */ }
    }
    const start = Date.parse(r.meta.start);
    const bars = Math.min(5000, Math.ceil(((Date.now() - start) / 86400000) * 5 / 7) + 60);
    await this.view.load(symbol, 'D', Math.max(600, bars));
    this.refreshChrome();
  }
  async showTrade(t: ReportTrade, r: Report) {
    await this.showRunSymbol(t.symbol, r);
    if (r.meta.kind === 'quantifi') { this.view.goTo(t.entry_time ?? 0); return; }
    this.view.goTo(Date.parse(`${t.entry_date}T00:00:00Z`) / 1000);
  }

  // ---------------------------------------------------------------- snapshot & data export
  async snapshot(kind: 'download' | 'copy' | 'tab') {
    const v = this.view, shot = v.chart.takeScreenshot();
    const head = 30, c = document.createElement('canvas');
    c.width = shot.width; c.height = shot.height + head * devicePixelRatio;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--panel') || '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--fg') || '#000';
    ctx.font = `${14 * devicePixelRatio}px -apple-system, BlinkMacSystemFont, sans-serif`;
    const t = v.title(), last = v.bars.at(-1);
    ctx.fillText(`${t.desc} · ${t.interval} · ${t.exchange}   ${last ? v.fmtPrice(last.close) : ''}   ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, 10 * devicePixelRatio, 20 * devicePixelRatio);
    ctx.drawImage(shot, 0, head * devicePixelRatio);
    const blob = await new Promise<Blob>(ok => c.toBlob(b => ok(b!), 'image/png'));
    const name = `${v.symbol.replace(':', '_')}_${v.timeframe}_${Date.now()}.png`;
    if (kind === 'download') { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href); }
    if (kind === 'copy') {
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Chart image copied to clipboard'); }
      catch { toast('Copying images is not allowed here'); }
    }
    if (kind === 'tab') window.open(URL.createObjectURL(blob), '_blank');
  }
  downloadData() {
    const v = this.view, bars = v.visibleBars();
    const cols = v.studies.flatMap(s => Object.keys(v.studyValues(s, 0)).map(k => ({ s, k, name: `${s.id}_${k}` })));
    const vals = new Map(v.studies.map(s => [s.uid, bars.map((_, i) => v.studyValues(s, i))]));
    const lines = bars.map((b, i) => [new Date(b.time * 1000).toISOString(), b.open, b.high, b.low, b.close, b.volume,
      ...cols.map(c => vals.get(c.s.uid)![i][c.k] ?? '')].join(','));
    const csv = [['time', 'open', 'high', 'low', 'close', 'volume', ...cols.map(c => c.name)].join(','), ...lines].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${v.symbol.replace(':', '_')}_${v.timeframe}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------------------------------------------------------------- keyboard
  private bindKeys() {
    document.addEventListener('keydown', e => {
      const t = e.target as HTMLElement;
      if (isMenuOpen() && e.key === 'Escape') { closeMenu(); return; }
      if (isDialogOpen()) { if (e.key === 'Escape') closeDialog(); return; }
      if (t.closest('input, select, textarea')) return;
      const v = this.view;
      const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
      if (mod && k === 's' && e.altKey) { e.preventDefault(); void this.snapshot('download'); return; }
      if (mod && k === 's' && e.shiftKey) { e.preventDefault(); void this.snapshot('copy'); return; }
      if (mod && k === 's') { e.preventDefault(); void this.saveLayout(); return; }
      if (mod && k === 'k') { e.preventDefault(); this.quickSearch(); return; }
      if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); return; }
      if (mod && k === 'z') { e.preventDefault(); this.undo(); return; }
      if (e.altKey) {
        const code = e.code;
        const map: Record<string, Tool> = { KeyT: 'trend', KeyF: 'fib', KeyV: 'vline', KeyJ: 'hray' };
        if (code === 'KeyH') { e.preventDefault(); this.placeAtCursor('hline'); return; }
        if (code === 'KeyC') { e.preventDefault(); this.placeAtCursor('crossline'); return; }
        if (code === 'KeyR' && e.shiftKey) { e.preventDefault(); this.drawbar.pick('rect'); return; }
        if (code === 'KeyR') { e.preventDefault(); v.resetView(); return; }
        if (code === 'KeyA') { e.preventDefault(); void this.openAlert(); return; }
        if (map[code]) { e.preventDefault(); this.drawbar.pick(map[code]); return; }
        return;
      }
      if (mod) return;
      if (e.key === 'F' && e.shiftKey) { e.preventDefault(); this.toggleFullscreen(); return; }
      if (e.key === 'Escape') {
        if (v.replayPicking) { v.exitReplay(); this.refreshChrome(); return; }
        if (!v.drawingLayer.cancel()) this.drawbar.sync();
        this.typed = '';
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') { if (v.drawingLayer.deleteSelected()) e.preventDefault(); return; }
      if (e.key === '/') { e.preventDefault(); void this.openIndicators(); return; }
      if (e.key === 'Enter' && /^\d+[a-z]?$/i.test(this.typed)) { this.applyTypedInterval(); return; }
      if (/^[a-z0-9.]$/i.test(e.key)) {
        // TradingView: typing a letter on the chart opens symbol search; typing digits builds an interval.
        if (/^\d$/.test(e.key) || (/^\d+$/.test(this.typed) && /^[hdwm]$/i.test(e.key))) {
          this.typed += e.key;
          document.body.dataset.status = `Interval: ${this.typed} (Enter)`;
          clearTimeout(this.typedTimer);
          this.typedTimer = window.setTimeout(() => { this.typed = ''; }, 3000);
          return;
        }
        e.preventDefault();
        this.typed = '';
        void this.openSymbolSearch(e.key.toUpperCase());
      }
    });
  }

  private applyTypedInterval() {
    const tf = parseInterval(this.typed);
    this.typed = '';
    if (tf) void this.setInterval(tf);
  }

  /** Alt+H / Alt+C: horizontal line or crossline at the cursor (or the last close if the pointer is elsewhere). */
  private placeAtCursor(type: Extract<ToolType, 'hline' | 'crossline'>) {
    const v = this.view;
    const p = this.lastPointer?.view === v ? v.drawingLayer.pointAt(this.lastPointer) : null;
    const last = v.bars[v.bars.length - 1];
    if (!p && !last) return;
    v.drawingLayer.add(createDrawing(type, [p ? { time: p.time, price: p.price } : { time: last.time, price: last.close }]));
  }

  // ---------------------------------------------------------------- persistence
  state(): LayoutState {
    return { grid: this.grid, active: this.active, charts: this.charts.map(v => v.state()), watchlistId: this.watchlistId, sync: this.sync };
  }

  scheduleSave() {
    if (this.restoring) return;
    this.dirty = true;
    this.topbar?.sync();
    if (!this.autosave) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), 600);
  }

  async save(name = this.layoutName) {
    const lay = await api.saveLayout(name, this.state(), name === this.layoutName ? this.layoutId : undefined);
    if (this.layoutId !== lay.id) await api.setSetting('last_layout', lay.id);
    this.layoutId = lay.id;
    this.layoutName = lay.name;
    this.dirty = false;
    document.body.dataset.saved = String(Date.now());
    this.topbar?.sync();
    return lay;
  }

  /** Save button / Ctrl+S: an unnamed layout asks for a name first (TradingView behavior). */
  async saveLayout() {
    if (this.layoutName === UNNAMED) {
      const name = await promptText('Save new chart layout', 'My layout');
      if (!name) return;
      this.layoutName = name;
      this.layoutId = undefined;
    }
    clearTimeout(this.saveTimer);
    const lay = await this.save();
    toast(`Layout “${esc(lay.name)}” saved`);
  }
  async renameLayout() {
    const name = await promptText('Rename chart layout', this.layoutName);
    if (!name) return;
    const old = this.layoutId;
    this.layoutName = name;
    await this.save(name);
    if (old && old !== this.layoutId) await api.deleteLayout(old);
  }
  async copyLayout() {
    const name = await promptText('Copy chart layout', `${this.layoutName} copy`);
    if (!name) return;
    this.layoutName = name;
    this.layoutId = undefined;
    await this.save(name);
    toast(`Layout copied to “${esc(name)}”`);
  }
  async newLayout() {
    const name = await promptText('Create new chart layout', 'New layout', 'Create');
    if (!name) return;
    this.layoutName = name;
    this.layoutId = undefined;
    await this.restore({ grid: '1', active: 0, charts: [{ ...DEFAULT_CHART, symbol: this.view.symbol }] });
    await this.save(name);
  }
  async listLayouts(): Promise<(LayoutMeta & { summary?: string })[]> {
    const ls = await api.layouts();
    return ls.map(l => ({ ...l, summary: new Date(l.updated * 1000).toLocaleString() }));
  }
  async loadLayout(id: number) {
    const lay = await api.layout(id);
    this.layoutId = lay.id; this.layoutName = lay.name;
    await api.setSetting('last_layout', lay.id);
    await this.restore(lay.state);
    if (lay.state.watchlistId) await this.widgets.watchlist.init(lay.state.watchlistId);
    toast(`Loaded layout “${esc(lay.name)}”`);
  }
  async deleteLayout(id: number) { await api.deleteLayout(id); }
  async openLayoutDialog() {
    const r = await layoutsDialog(await api.layouts(), this.layoutId);
    if (r?.open) await this.loadLayout(r.open);
    if (r?.delete) { await api.deleteLayout(r.delete); toast('Layout deleted'); }
  }
  async setAutosave(on: boolean) {
    this.autosave = on;
    await api.setSetting('autosave', on);
    if (on && this.dirty) void this.save();
    this.topbar.sync();
  }

  private async pollHealth() {
    const tick = async () => {
      try { this.feedState = (await api.health()).sidecar ? 'tradingview' : 'local'; } catch { this.feedState = 'offline'; }
      this.topbar.sync();
    };
    await tick();
    setInterval(tick, 15000);
  }
}

const shortMoney = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}K` : money(x, 0));

const app = new App();
(window as unknown as { app: App }).app = app;   // exposed for e2e tests and debugging
app.start();
