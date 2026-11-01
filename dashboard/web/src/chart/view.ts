// One chart: main series (TradingView's chart types) + volume, studies (overlay or own pane), compare
// symbols, TradingView-style legend, lazy history, live updates, bar replay, drawings and strategy
// trade markers. Rendering is lightweight-charts; everything else is ours.
import {
  AreaSeries, BarSeries, BaselineSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries,
  LineStyle, LineType, PriceScaleMode, TickMarkType, createChart, createSeriesMarkers,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type LogicalRange, type MouseEventParams,
  type SeriesMarker, type SeriesType, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { api, subscribe, type ChartState, type StrategyRun, type StrategyState } from '../api';
import { INDICATORS, columns, computeIndicator, type Bar, type Inputs } from '../indicators';
import { DrawingLayer, type Tool } from '../drawings/layer';
import { validate, type Drawing } from '../drawings/model';
import { icon } from '../ui/icons';
import { alignToBars, heikinAshi, quantifiLabel, quantifiTick, tickInterval } from './util';
export { heikinAshi, parseInterval } from './util';

const DAILY = new Set(['D', 'W', 'M']);
const HISTORY_PAGE = 500;
const INITIAL_BARS = 600;
const COMPARE_COLORS = ['#FF9800', '#9C27B0', '#00BCD4', '#E91E63', '#795548'];

export type ChartType = 'bars' | 'candles' | 'hollow' | 'line' | 'linemarkers' | 'stepline' | 'area' | 'baseline' | 'columns' | 'heikin';
export const CHART_TYPES: { id: ChartType; label: string; icon: string }[] = [
  { id: 'bars', label: 'Bars', icon: 'bars' }, { id: 'candles', label: 'Candles', icon: 'candles' },
  { id: 'hollow', label: 'Hollow candles', icon: 'hollow' }, { id: 'line', label: 'Line', icon: 'line' },
  { id: 'linemarkers', label: 'Line with markers', icon: 'linemarkers' }, { id: 'stepline', label: 'Step line', icon: 'stepline' },
  { id: 'area', label: 'Area', icon: 'area' }, { id: 'baseline', label: 'Baseline', icon: 'baseline' },
  { id: 'columns', label: 'Columns', icon: 'columns' }, { id: 'heikin', label: 'Heikin Ashi', icon: 'heikin' },
];
export type CursorStyle = 'cross' | 'dot' | 'arrow';

/** Chart properties (TradingView "Settings" dialog subset), shared by all charts. */
export interface ChartProps {
  upColor: string; downColor: string; body: boolean; borders: boolean; wick: boolean; prevClose: boolean;
  bg: string; vertGrid: boolean; horzGrid: boolean; scaleMode: 'normal' | 'log' | 'percent';
  lastPriceLine: boolean; showOHLC: boolean; showChange: boolean; showVolume: boolean; showStudyValues: boolean;
  timezone: string;        // 'exchange' | 'UTC' | IANA zone
}
export const DEFAULT_PROPS: ChartProps = {
  upColor: '#089981', downColor: '#F23645', body: true, borders: false, wick: true, prevClose: false,
  bg: '', vertGrid: true, horzGrid: true, scaleMode: 'normal', lastPriceLine: true,
  showOHLC: true, showChange: true, showVolume: true, showStudyValues: true, timezone: 'exchange',
};

export interface Study {
  uid: string; id: string; inputs: Inputs; series: Map<string, ISeriesApi<SeriesType>>; pane: number; levels: IPriceLine[]; visible: boolean;
}
export interface Compare { symbol: string; color: string; series: ISeriesApi<'Line'>; bars: Bar[] }
/** A run's trade on the chart. `time` (unix seconds) overrides the day-resolution `date`; marks with a `qty` that land on the
 *  same bar and side merge into one arrow labelled with the summed size (QuantiFi fills, many per bar). */
/** What a QuantiFi run draws on its product's chart (server tvre.quantifi.overlay): lines as change points in unix
 *  seconds; `pane` 'price' shares the candles' pane, any other name gets a pane of its own; `group` is one legend row. */
export interface RunLine { group: string; label: string; pane: string; style: 'line' | 'step' | 'dots'; color: string; time: number[]; value: (number | null)[] }
export interface RunOverlay { run: string; product: string; symbol: string; lines: RunLine[] }
interface OverlayGroup { name: string; pane: string; lines: RunLine[]; series: ISeriesApi<SeriesType>[]; idx: number[][] }

export interface TradeMark { date: string; side: 'buy' | 'sell'; text?: string; symbol: string; color?: string; time?: number; qty?: number; price?: number }
export interface Snapshot { studies: { id: string; inputs: Inputs; visible?: boolean }[]; drawings: Record<string, Drawing[]>; compare: string[] }

export interface ChartEvents {
  onActivate?(view: ChartView): void;
  onChange?(view: ChartView, kind: 'data' | 'edit' | 'select', what?: string): void;
  onStatus?(view: ChartView, msg: string): void;
  onCrosshair?(view: ChartView, index: number | null, point: { time: number; price: number } | null): void;
  onRange?(view: ChartView, range: { from: number; to: number } | null): void;
  onReplay?(view: ChartView): void;
  onStrategy?(view: ChartView, run: StrategyRun | null, error?: string): void;
}

export class ChartView {
  readonly chart: IChartApi;
  main!: ISeriesApi<SeriesType>;
  readonly volume: ISeriesApi<'Histogram'>;
  readonly drawingLayer: DrawingLayer;
  readonly legend: HTMLElement;
  readonly host: HTMLElement;
  symbol = '';
  timeframe = 'D';
  chartType: ChartType = 'candles';
  adjustment: 'splits' | 'dividends' = 'splits';
  loading = false;
  source = '';
  info: Record<string, string | number | null> = {};
  marketStatus: string | null = null;
  bars: Bar[] = [];
  studies: Study[] = [];
  compares: Compare[] = [];
  volumeVisible = true;
  studiesHidden = false;
  legendCollapsed = false;
  replay: { index: number; playing: boolean; speed: number; timer: number } | null = null;
  strategy: StrategyState | null = null;
  strategyRun: StrategyRun | null = null;
  strategyBusy = false;
  private strategyPlots: ISeriesApi<'Line'>[] = [];
  private strategySeq = 0;
  replayPicking = false;
  props: ChartProps = { ...DEFAULT_PROPS };
  private drawingsBySymbol: Record<string, Drawing[]> = {};
  private markers!: ISeriesMarkersPluginApi<Time>;
  private trades: TradeMark[] = [];
  private stopStream: (() => void) | null = null;
  private loadingMore = false;
  private historyDone = false;
  private loadToken = 0;
  private uidSeq = 0;
  private crosshairIndex: number | null = null;
  private precision = 2;
  private syncing = false;

  constructor(readonly el: HTMLElement, private readonly events: ChartEvents = {}, props?: Partial<ChartProps>) {
    if (props) this.props = { ...DEFAULT_PROPS, ...props };
    el.classList.add('chart-cell');
    this.host = document.createElement('div');
    this.host.className = 'chart-host';
    el.appendChild(this.host);
    this.legend = document.createElement('div');
    this.legend.className = 'legend';
    el.appendChild(this.legend);

    this.chart = createChart(this.host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: getCss('--chart-bg') }, textColor: getCss('--fg'), fontSize: 12,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif',
        panes: { separatorColor: getCss('--line'), separatorHoverColor: getCss('--hover'), enableResize: true } },
      grid: { vertLines: { color: getCss('--grid'), style: LineStyle.Dotted }, horzLines: { color: getCss('--grid'), style: LineStyle.Dotted } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#9598A1', style: LineStyle.Dashed, labelBackgroundColor: '#131722' },
        horzLine: { color: '#9598A1', style: LineStyle.Dashed, labelBackgroundColor: '#131722' } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, rightOffset: 10, barSpacing: 6, timeVisible: true, secondsVisible: false,
        tickMarkFormatter: (t: Time, type: TickMarkType) => this.tickLabel(t as number, type) },
      localization: { timeFormatter: (t: Time) => this.formatTime(t as number) },
    });
    this.volume = this.chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    this.drawingLayer = new DrawingLayer(this.host);
    this.drawingLayer.formatPrice = p => this.fmtPrice(p);
    this.drawingLayer.onChange = (ds, what) => {
      this.drawingsBySymbol[this.symbol] = ds;
      this.events.onChange?.(this, what === 'select' ? 'select' : 'edit', what);
    };
    this.drawingLayer.onZoom = (from, to) => this.chart.timeScale().setVisibleLogicalRange({ from, to });
    this.createMain();

    this.chart.subscribeCrosshairMove(p => this.onCrosshair(p));
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(r => {
      this.maybeLoadMore(r);
      if (!this.syncing) {
        const tr = this.chart.timeScale().getVisibleRange();
        this.events.onRange?.(this, tr ? { from: tr.from as number, to: tr.to as number } : null);
      }
    });
    el.addEventListener('pointerdown', e => {
      this.events.onActivate?.(this);
      if (this.replayPicking && !(e.target as HTMLElement).closest('.replay-bar')) this.pickReplayAt(e);
    }, true);
    this.legend.addEventListener('click', e => this.onLegendClick(e));
    this.applyProps();
  }

  // ---------------------------------------------------------------- main series & chart type
  private createMain() {
    const p = this.props, t = this.chartType;
    const up = p.upColor, down = p.downColor;
    const common = { priceLineVisible: p.lastPriceLine, priceLineStyle: LineStyle.Dotted, lastValueVisible: true };
    const old = this.main;
    if (old) { old.detachPrimitive(this.drawingLayer); this.markers.detach(); this.chart.removeSeries(old); }
    if (t === 'candles' || t === 'heikin' || t === 'hollow') {
      this.main = this.chart.addSeries(CandlestickSeries, {
        ...common, upColor: t === 'hollow' ? 'rgba(0,0,0,0)' : p.body ? up : 'rgba(0,0,0,0)', downColor: p.body ? down : 'rgba(0,0,0,0)',
        borderVisible: t === 'hollow' || p.borders, borderUpColor: up, borderDownColor: down,
        wickVisible: p.wick, wickUpColor: up, wickDownColor: down,
      });
    } else if (t === 'bars') {
      this.main = this.chart.addSeries(BarSeries, { ...common, upColor: up, downColor: down, thinBars: false });
    } else if (t === 'line' || t === 'linemarkers' || t === 'stepline') {
      this.main = this.chart.addSeries(LineSeries, { ...common, color: '#2962FF', lineWidth: 2,
        lineType: t === 'stepline' ? LineType.WithSteps : LineType.Simple, pointMarkersVisible: t === 'linemarkers', pointMarkersRadius: 3 });
    } else if (t === 'area') {
      this.main = this.chart.addSeries(AreaSeries, { ...common, lineColor: '#2962FF', lineWidth: 2, topColor: 'rgba(41,98,255,0.28)', bottomColor: 'rgba(41,98,255,0.05)' });
    } else if (t === 'baseline') {
      this.main = this.chart.addSeries(BaselineSeries, { ...common, lineWidth: 2,
        topLineColor: up, topFillColor1: 'rgba(8,153,129,0.28)', topFillColor2: 'rgba(8,153,129,0.05)',
        bottomLineColor: down, bottomFillColor1: 'rgba(242,54,69,0.05)', bottomFillColor2: 'rgba(242,54,69,0.28)' });
    } else {
      this.main = this.chart.addSeries(HistogramSeries, { ...common, color: up });
    }
    this.main.applyOptions({ priceFormat: { type: 'price', precision: this.precision, minMove: 1 / 10 ** this.precision } });
    this.main.attachPrimitive(this.drawingLayer);
    this.markers = createSeriesMarkers(this.main, []);
    if (old) { this.renderData(false); this.applyMarkers(); }
  }

  setChartType(t: ChartType) {
    if (t === this.chartType) return;
    this.chartType = t;
    this.createMain();
    this.renderLegend();
    this.events.onChange?.(this, 'edit', 'chart type');
  }

  private mainData(bars: Bar[]) {
    const t = this.chartType, p = this.props;
    if (t === 'line' || t === 'linemarkers' || t === 'stepline' || t === 'area' || t === 'baseline')
      return bars.map(b => ({ time: b.time as UTCTimestamp, value: b.close }));
    if (t === 'columns')
      return bars.map((b, i) => ({ time: b.time as UTCTimestamp, value: b.close,
        color: b.close >= (i ? bars[i - 1].close : b.open) ? p.upColor : p.downColor }));
    const src = t === 'heikin' ? heikinAshi(bars) : bars;
    return src.map((b, i) => {
      const row = { time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close };
      if (!p.prevClose || i === 0) return row;
      const c = b.close >= src[i - 1].close ? p.upColor : p.downColor;   // "Color bars based on previous close"
      return { ...row, color: t === 'hollow' && b.close >= b.open ? 'rgba(0,0,0,0)' : c, borderColor: c, wickColor: c };
    });
  }

  // ---------------------------------------------------------------- properties
  setProps(p: Partial<ChartProps>) {
    this.props = { ...this.props, ...p };
    this.applyProps();
    this.createMain();
    this.renderLegend();
  }
  private applyProps() {
    const p = this.props;
    this.chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: p.bg || getCss('--chart-bg') }, textColor: getCss('--fg'),
        panes: { separatorColor: getCss('--line'), separatorHoverColor: getCss('--hover') } },
      grid: { vertLines: { visible: p.vertGrid, color: getCss('--grid') }, horzLines: { visible: p.horzGrid, color: getCss('--grid') } },
      rightPriceScale: { mode: this.compares.length ? PriceScaleMode.Percentage
        : p.scaleMode === 'log' ? PriceScaleMode.Logarithmic : p.scaleMode === 'percent' ? PriceScaleMode.Percentage : PriceScaleMode.Normal },
    });
    this.volume.applyOptions({ visible: this.volumeVisible && p.showVolume });
  }
  setCursor(style: CursorStyle) {
    const lines = style === 'cross';
    this.chart.applyOptions({ crosshair: { vertLine: { visible: lines, labelVisible: true }, horzLine: { visible: lines, labelVisible: true } } });
    this.host.dataset.cursor = style;
    this.host.style.cursor = style === 'dot' ? 'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2710%27 height=%2710%27%3E%3Ccircle cx=%275%27 cy=%275%27 r=%272.5%27/%3E%3C/svg%3E") 5 5, crosshair'
      : style === 'arrow' ? 'default' : '';
  }

  // ---------------------------------------------------------------- data
  async load(symbol: string, timeframe = this.timeframe, count = INITIAL_BARS): Promise<void> {
    const token = ++this.loadToken;
    this.loading = true;
    try { await this.doLoad(token, symbol, timeframe, count); } finally { if (token === this.loadToken) this.loading = false; }
  }

  private async doLoad(token: number, symbol: string, timeframe: string, count: number): Promise<void> {
    const symbolChanged = symbol !== this.symbol;
    this.exitReplay(false);
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.stopStream?.();
    this.stopStream = null;
    this.historyDone = false;
    this.events.onStatus?.(this, `Loading ${symbol} ${timeframe}…`);
    if (symbolChanged) { this.info = {}; this.marketStatus = null; }
    this.renderLegend();
    let resp;
    try {
      resp = await api.bars(symbol, timeframe, count, undefined, 'auto', this.adjustment);
    } catch (e) {
      if (token !== this.loadToken) return;
      this.bars = [];
      this.renderData(false);
      this.legend.querySelector('.legend-title')?.setAttribute('data-error', '1');
      this.events.onStatus?.(this, `${symbol}: ${(e as Error).message}`);
      this.events.onChange?.(this, 'data');
      return;
    }
    if (token !== this.loadToken) return;   // a newer load superseded this one
    this.source = resp.source;
    this.bars = resp.bars;
    if (symbolChanged || !this.info.description) {
      api.symbol(symbol).then(info => {
        if (symbol !== this.symbol) return;
        this.info = info;
        this.applyPriceFormat(info);
        this.renderLegend();
      }).catch(() => {});
      api.details(symbol).then(d => { if (symbol === this.symbol) { this.marketStatus = d.session.status; this.renderLegend(); } }).catch(() => {});
    }
    this.renderData(true);
    this.drawingLayer.setDrawings(this.drawingsBySymbol[symbol] ?? []);
    this.applyMarkers();
    for (const c of this.compares) this.loadCompare(c);
    this.events.onStatus?.(this, `${symbol} ${timeframe}: ${this.bars.length} bars from ${resp.source}`);
    this.events.onChange?.(this, 'data');
    if (resp.source === 'tradingview') this.startStream();
    if (this.strategy) void this.runStrategy();
  }

  setTimeframe(tf: string) { return this.load(this.symbol, tf); }
  setAdjustment(a: 'splits' | 'dividends') { this.adjustment = a; return this.load(this.symbol, this.timeframe, Math.max(INITIAL_BARS, this.bars.length)); }

  private applyPriceFormat(info: Record<string, string | number | null>) {
    const scale = Number(info.pricescale) || 100;
    this.precision = Math.max(0, Math.round(Math.log10(scale)));
    this.main.applyOptions({ priceFormat: { type: 'price', precision: this.precision, minMove: 1 / scale } });
    this.drawingLayer.redraw();
  }
  fmtPrice(x: number) { return Number.isFinite(x) ? x.toFixed(this.precision) : '∅'; }

  /** Bars currently shown (all of them, or up to the replay cursor). */
  visibleBars(): Bar[] { return this.replay ? this.bars.slice(0, this.replay.index + 1) : this.bars; }

  private renderData(fit: boolean) {
    const bars = this.visibleBars();
    this.main.setData(this.mainData(bars) as never);
    if (this.chartType === 'baseline' && bars.length) {
      const closes = bars.slice(-150).map(b => b.close);
      this.main.applyOptions({ baseValue: { type: 'price', price: (Math.max(...closes) + Math.min(...closes)) / 2 } } as never);
    }
    this.volume.setData(bars.map(b => ({ time: b.time as UTCTimestamp, value: b.volume, color: volColor(b, this.props) })));
    this.drawingLayer.setBars(bars);
    this.recomputeStudies();
    this.syncOverlay();
    if (fit) {
      const n = bars.length;
      this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 150), to: n + 10 });
    }
    this.renderLegend();
  }

  private async maybeLoadMore(range: LogicalRange | null) {
    if (!range || this.loadingMore || this.historyDone || !this.bars.length || range.from > 15 || this.replay) return;
    this.loadingMore = true;
    const token = this.loadToken;
    try {
      const older = await api.bars(this.symbol, this.timeframe, HISTORY_PAGE, this.bars[0].time - 1, this.source, this.adjustment);
      if (token !== this.loadToken) return;
      const fresh = older.bars.filter(b => b.time < this.bars[0].time);
      if (!fresh.length) { this.historyDone = true; return; }
      this.bars = [...fresh, ...this.bars];
      this.renderData(false);
      this.events.onStatus?.(this, `${this.symbol}: loaded ${fresh.length} older bars (${this.bars.length} total)`);
    } catch {
      this.historyDone = true;
    } finally {
      this.loadingMore = false;
    }
  }

  private startStream() {
    const { symbol, timeframe } = this;
    this.stopStream = subscribe(`/api/stream/bars?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`, {
      bars: (candles: Bar[]) => {
        if (symbol !== this.symbol || timeframe !== this.timeframe) return;
        for (const c of candles) this.applyTick(c);
      },
    });
  }

  /** Merge a live bar: update the last bar in place or append a new one (TradingView semantics). */
  applyTick(c: Bar) {
    const last = this.bars[this.bars.length - 1];
    if (!last || c.time < last.time) return;
    if (c.time === last.time) this.bars[this.bars.length - 1] = { ...c };
    else this.bars.push({ ...c });
    if (this.replay) return;                       // replay shows history only; keep collecting live bars
    if (this.chartType === 'heikin' || this.chartType === 'columns' || this.props.prevClose) this.main.setData(this.mainData(this.bars) as never);
    else this.main.update(this.mainData([c])[0] as never);
    this.volume.update({ time: c.time as UTCTimestamp, value: c.volume, color: volColor(c, this.props) });
    if (c.time !== last.time) this.drawingLayer.setBars(this.bars);
    this.recomputeStudies();
    if (this.crosshairIndex === null) this.renderLegend();
  }

  // ---------------------------------------------------------------- compare symbols
  async addCompare(symbol: string) {
    if (symbol === this.symbol || this.compares.some(c => c.symbol === symbol)) return;
    const color = COMPARE_COLORS[this.compares.length % COMPARE_COLORS.length];
    const series = this.chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: '' });
    const c: Compare = { symbol, color, series, bars: [] };
    this.compares.push(c);
    this.applyProps();
    await this.loadCompare(c);
    this.events.onChange?.(this, 'edit', 'compare');
  }
  removeCompare(symbol: string) {
    const c = this.compares.find(x => x.symbol === symbol);
    if (!c) return;
    this.chart.removeSeries(c.series);
    this.compares = this.compares.filter(x => x !== c);
    this.applyProps();
    this.renderLegend();
    this.events.onChange?.(this, 'edit', 'compare');
  }
  private async loadCompare(c: Compare) {
    try {
      const r = await api.bars(c.symbol, this.timeframe, Math.max(INITIAL_BARS, this.bars.length), undefined, 'auto', this.adjustment);
      if (!this.compares.includes(c)) return;
      const first = this.bars[0]?.time ?? 0;
      c.bars = r.bars.filter(b => b.time >= first);
      c.series.setData(c.bars.map(b => ({ time: b.time as UTCTimestamp, value: b.close })));
    } catch { c.bars = []; }
    this.renderLegend();
  }

  // ---------------------------------------------------------------- studies
  addStudy(id: string, inputs: Inputs = {}, uid?: string, visible = true): Study {
    const def = INDICATORS[id];
    if (!def) throw new Error(`unknown indicator ${id}`);
    const pane = def.pane === 'overlay' ? 0 : this.nextPaneIndex();
    const series = new Map<string, ISeriesApi<SeriesType>>();
    const show = visible && !this.studiesHidden;
    for (const o of def.outputs) {
      const opts = { color: o.color, lineWidth: 2 as const, priceLineVisible: false, lastValueVisible: true, title: '', visible: show };
      series.set(o.key, o.kind === 'histogram'
        ? this.chart.addSeries(HistogramSeries, { color: o.color, priceLineVisible: false, visible: show }, pane)
        : this.chart.addSeries(LineSeries, opts, pane));
    }
    const first = series.values().next().value!;
    const levels = (def.levels ?? []).map(price => first.createPriceLine({ price, color: '#787B86', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false }));
    const study: Study = { uid: uid ?? `s${++this.uidSeq}`, id, inputs: { ...def.inputs, ...inputs }, series, pane, levels, visible };
    this.studies.push(study);
    if (pane > 0) this.chart.panes()[pane]?.setStretchFactor(0.35);
    this.computeStudy(study);
    this.renderLegend();
    this.events.onChange?.(this, 'edit', `add ${id}`);
    return study;
  }

  removeStudy(uid: string) {
    const s = this.studies.find(x => x.uid === uid);
    if (!s) return;
    for (const ser of s.series.values()) this.chart.removeSeries(ser);
    this.studies = this.studies.filter(x => x !== s);
    // empty separate panes collapse automatically when their last series is removed
    this.renderLegend();
    this.events.onChange?.(this, 'edit', `remove ${s.id}`);
  }

  updateStudyInputs(uid: string, inputs: Inputs) {
    const s = this.studies.find(x => x.uid === uid);
    if (!s) return;
    s.inputs = { ...s.inputs, ...inputs };
    this.computeStudy(s);
    this.renderLegend();
    this.events.onChange?.(this, 'edit', `edit ${s.id}`);
  }

  setStudyVisible(uid: string, visible: boolean) {
    const s = this.studies.find(x => x.uid === uid);
    if (!s) return;
    s.visible = visible;
    for (const ser of s.series.values()) ser.applyOptions({ visible: visible && !this.studiesHidden });
    this.renderLegend();
    this.events.onChange?.(this, 'edit', `${visible ? 'show' : 'hide'} ${s.id}`);
  }
  setStudiesHidden(hidden: boolean) {
    this.studiesHidden = hidden;
    for (const s of this.studies) for (const ser of s.series.values()) ser.applyOptions({ visible: s.visible && !hidden });
    for (const g of this.overlayGroups) for (const ser of g.series) ser.applyOptions({ visible: !this.overlayHidden.has(g.name) && !hidden });
    this.renderLegend();
  }
  setVolumeVisible(v: boolean) { this.volumeVisible = v; this.applyProps(); this.renderLegend(); }

  private nextPaneIndex() { return this.chart.panes().length; }

  private computeStudy(s: Study) {
    const bars = this.visibleBars();
    if (!bars.length) { for (const ser of s.series.values()) ser.setData([]); return; }
    const cols = columns(bars);
    const out = computeIndicator(s.id, cols, s.inputs);
    const def = INDICATORS[s.id];
    for (const o of def.outputs) {
      const vals = out[o.key];
      const data = bars.map((b, i) => (Number.isFinite(vals[i])
        ? { time: b.time as UTCTimestamp, value: vals[i], ...(o.kind === 'histogram' ? { color: vals[i] >= 0 ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)' } : {}) }
        : { time: b.time as UTCTimestamp }));
      s.series.get(o.key)!.setData(data);
    }
  }

  private recomputeStudies() { for (const s of this.studies) this.computeStudy(s); }

  /** Study values at a bar index (for the legend, the data window and tests). */
  studyValues(s: Study, index = this.visibleBars().length - 1): Record<string, number> {
    const out = computeIndicator(s.id, columns(this.visibleBars()), s.inputs);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v[index]]));
  }

  // ---------------------------------------------------------------- drawings & markers
  setTool(tool: Tool) { this.drawingLayer.setTool(tool); }
  drawings(): Drawing[] { return this.drawingLayer.drawings; }

  setTrades(trades: TradeMark[]) { this.trades = trades; this.applyMarkers(); }

  // ---------------------------------------------------------------- run overlay (QuantiFi strategy on its product)
  private overlay: RunOverlay | null = null;
  private overlayGroups: OverlayGroup[] = [];
  private overlayHidden = new Set<string>();
  private overlayRemoved = new Set<string>();

  /** Draw (or with null, drop) a run's quotes, position and indicators while its product is on this chart. */
  setRunOverlay(o: RunOverlay | null) {
    if (o === this.overlay) return;
    this.overlay = o;
    this.overlayRemoved.clear();
    this.clearOverlay();
    this.syncOverlay();
    this.renderLegend();
  }
  private clearOverlay() {
    for (const g of this.overlayGroups) for (const s of g.series) this.chart.removeSeries(s);   // empty panes collapse
    this.overlayGroups = [];
  }
  /** Build the series on first use, then align every line to the bars on screen (each bar shows the value at its close). */
  private syncOverlay() {
    const o = this.overlay, bars = this.visibleBars();
    if (!o || o.symbol !== this.symbol || !bars.length) { if (this.overlayGroups.length) this.clearOverlay(); return; }
    const want = new Map<string, RunLine[]>();
    for (const l of o.lines) if (!this.overlayRemoved.has(l.group)) want.set(l.group, [...(want.get(l.group) ?? []), l]);
    if ([...want.keys()].join('|') !== this.overlayGroups.map(g => g.name).join('|')) {
      this.clearOverlay();
      for (const [name, lines] of want) {
        const pane = lines[0].pane === 'price' ? 0 : this.nextPaneIndex(), show = !this.overlayHidden.has(name) && !this.studiesHidden;
        const series = lines.map(l => this.chart.addSeries(LineSeries, {
          color: l.color, lineWidth: name === 'Book' ? 1 : 2, priceLineVisible: false, title: '', visible: show,
          lastValueVisible: pane > 0, crosshairMarkerVisible: l.style !== 'dots' && name !== 'Book',
          ...(l.style === 'dots' ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2 } : {}),
          ...(l.style === 'step' ? { lineType: LineType.WithSteps } : {}),
        }, pane));
        if (pane > 0) this.chart.panes()[pane]?.setStretchFactor(0.25);
        this.overlayGroups.push({ name, pane: lines[0].pane, lines, series, idx: [] });
      }
    }
    const times = bars.map(b => b.time);
    for (const g of this.overlayGroups) {
      g.idx = g.lines.map(l => alignToBars(times, l.time));
      g.lines.forEach((l, k) => g.series[k].setData(bars.map((b, i) => {
        const j = g.idx[k][i], v = j >= 0 ? l.value[j] : null;
        return v === null || v === undefined ? { time: b.time as UTCTimestamp } : { time: b.time as UTCTimestamp, value: v };
      })));
    }
  }
  private overlayRows(index: number | undefined, ctl: (uid: string, visible: boolean, settings?: boolean) => string): string[] {
    return this.overlayGroups.map(g => {
      const on = !this.overlayHidden.has(g.name);
      const vals = on && index !== undefined ? g.lines.map((l, k) => {
        const j = g.idx[k]?.[index] ?? -1, v = j >= 0 ? l.value[j] : null;
        const txt = v === null || v === undefined ? '∅' : g.pane === 'price' ? this.fmtPrice(v) : fmtNum(v);
        return `<span class="lval" style="color:${l.color}" title="${l.label}">${txt}</span>`;
      }).join(' ') : '';
      return `<div class="legend-row ${on ? '' : 'hidden-study'}" data-uid="o:${g.name}"><span class="lname">${g.name}</span> ${vals}${ctl(`o:${g.name}`, on, false)}</div>`;
    });
  }

  private applyMarkers() {
    const bare = this.symbol.split(':').pop();
    const mine = this.trades.filter(t => t.symbol === this.symbol || (!t.symbol.includes(':') && t.symbol === bare));
    const bars = this.visibleBars();
    const strat = this.strategyMarkers(bars);
    if ((!mine.length && !strat.length) || !bars.length) { this.markers.setMarkers(strat); return; }
    const toStamp = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 1000;
    const times = bars.map(b => b.time);
    const snap = (t: number) => {   // place on the bar containing the trade date (handles W/M bars)
      let lo = 0, hi = times.length - 1;
      if (t < times[0] || t > times[times.length - 1] + 86400 * 31) return null;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= t) lo = mid; else hi = mid - 1; }
      return times[lo];
    };
    const markers: SeriesMarker<Time>[] = [];
    const merged = new Map<string, { time: number; side: 'buy' | 'sell'; qty: number; color?: string; value: number; priced: boolean }>();
    for (const t of mine) {
      const time = snap(t.time ?? toStamp(t.date));
      if (time === null) continue;
      if (t.qty !== undefined) {
        const k = `${time}|${t.side}`, m = merged.get(k);
        const q = Math.abs(t.qty), value = q * (t.price ?? 0);
        if (m) { m.qty += q; m.value += value; m.priced &&= t.price !== undefined; }
        else merged.set(k, { time, side: t.side, qty: q, color: t.color, value, priced: t.price !== undefined });
        continue;
      }
      markers.push(t.side === 'buy'
        ? { time: time as UTCTimestamp, position: 'belowBar', color: t.color ?? '#2962FF', shape: 'arrowUp', text: t.text ?? 'B' }
        : { time: time as UTCTimestamp, position: 'aboveBar', color: t.color ?? '#F23645', shape: 'arrowDown', text: t.text ?? 'S' });
    }
    const atPrice = tickInterval(this.timeframe) === 1;    // one tick per bar: pin each fill at its (volume-weighted) price
    for (const m of merged.values()) {
      if (atPrice && m.priced) {
        markers.push({ time: m.time as UTCTimestamp, position: m.side === 'buy' ? 'atPriceBottom' : 'atPriceTop', price: m.value / m.qty,
          color: m.color ?? (m.side === 'buy' ? '#2962FF' : '#F23645'), shape: m.side === 'buy' ? 'arrowUp' : 'arrowDown', text: `${m.side === 'buy' ? '+' : '−'}${m.qty}` });
        continue;
      }
      markers.push(m.side === 'buy'
        ? { time: m.time as UTCTimestamp, position: 'belowBar', color: m.color ?? '#2962FF', shape: 'arrowUp', text: `+${m.qty}` }
        : { time: m.time as UTCTimestamp, position: 'aboveBar', color: m.color ?? '#F23645', shape: 'arrowDown', text: `−${m.qty}` });
    }
    markers.push(...strat);
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    this.markers.setMarkers(markers);
  }

  /** TradingView-style strategy order labels: one arrow per bar and direction, text = the order's name and the
   *  signed size it traded (a reversal is one order: closes the old position and opens the new one). Buys sit
   *  below the bar, sells above; entries are blue (long) / red (short), pure exits purple. */
  private strategyMarkers(bars: Bar[]): SeriesMarker<Time>[] {
    const run = this.strategyRun;
    if (!run || !bars.length) return [];
    const first = bars[0].time, last = bars[bars.length - 1].time;
    const orders = new Map<string, { time: number; buy: boolean; qty: number; label: string; entry: boolean }>();
    const add = (time: number, buy: boolean, qty: number, label: string, entry: boolean) => {
      if (time < first || time > last) return;
      const k = `${time}:${buy}`, o = orders.get(k);
      if (!o) orders.set(k, { time, buy, qty, label, entry });
      else { o.qty += qty; if (entry && !o.entry) { o.label = label; o.entry = true; } }
    };
    for (const t of run.trades) {
      const long = t.side !== 'short';
      add(t.entry_time ?? 0, long, t.qty, t.entry_label ?? t.name, true);
      if (!t.open) add(t.exit_time ?? 0, !long, t.qty, t.exit_label ?? '', false);
    }
    const q = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 6 });
    return [...orders.values()].map(o => ({
      time: o.time as UTCTimestamp, position: o.buy ? 'belowBar' : 'aboveBar', shape: o.buy ? 'arrowUp' : 'arrowDown',
      color: !o.entry ? '#9C27B0' : o.buy ? '#2962FF' : '#F23645', text: `${o.label} ${o.buy ? '+' : '−'}${q(o.qty)}`,
    }));
  }

  // ---------------------------------------------------------------- Pine strategy
  /** Put a strategy on the chart (or remove it with null); it runs on the server over this chart's symbol. */
  async setStrategy(st: StrategyState | null) {
    this.strategy = st;
    if (!st) {
      this.strategyRun = null;
      this.clearStrategyPlots();
      this.applyMarkers();
      this.renderLegend();
      this.events.onStrategy?.(this, null);
      this.events.onChange?.(this, 'edit', 'remove strategy');
      return;
    }
    this.events.onChange?.(this, 'edit', 'strategy');
    await this.runStrategy();
  }

  async runStrategy() {
    const st = this.strategy;
    if (!st || !this.symbol) return;
    const my = ++this.strategySeq;
    this.strategyBusy = true;
    this.renderLegend();
    try {
      const run = await api.runStrategy({ symbol: this.symbol, timeframe: this.timeframe, script: st.script, inputs: st.inputs, props: st.props,
        count: 5000, adjustment: this.adjustment === 'dividends' ? 'dividends' : undefined });
      if (my !== this.strategySeq) return;
      this.strategyRun = run;
      if (!st.name) st.name = run.meta.name;
      this.drawStrategyPlots(run);
      this.applyMarkers();
      this.events.onStrategy?.(this, run);
    } catch (e) {
      if (my !== this.strategySeq) return;
      this.strategyRun = null;
      this.events.onStrategy?.(this, null, (e as Error).message);
    } finally {
      if (my === this.strategySeq) { this.strategyBusy = false; this.renderLegend(); }
    }
  }

  private clearStrategyPlots() {
    for (const p of this.strategyPlots) this.chart.removeSeries(p);
    this.strategyPlots = [];
  }

  private drawStrategyPlots(run: StrategyRun) {
    this.clearStrategyPlots();
    const colors = ['#FF9800', '#00BCD4', '#9C27B0', '#E91E63'];
    const times = run.series.time;
    Object.entries(run.chart.plots).forEach(([title, vals], k) => {
      if (!vals.some(v => v !== null)) return;
      const ser = this.chart.addSeries(LineSeries, { color: colors[k % colors.length], lineWidth: 1, lineVisible: false,
        pointMarkersVisible: true, pointMarkersRadius: 2, priceLineVisible: false, lastValueVisible: false, title: '' });
      ser.setData(times.map((t, i) => (vals[i] === null ? { time: t as UTCTimestamp } : { time: t as UTCTimestamp, value: vals[i] as number })));
      this.strategyPlots.push(ser);
      void title;
    });
  }

  // ---------------------------------------------------------------- navigation
  /** Show the last `seconds` of data (bottom range bar). */
  showSpan(seconds: number | null) {
    const bars = this.visibleBars();
    if (!bars.length) return;
    const last = bars[bars.length - 1].time;
    if (seconds === null) { this.chart.timeScale().setVisibleLogicalRange({ from: 0, to: bars.length + 5 }); return; }
    const from = bars.findIndex(b => b.time >= last - seconds);
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, from), to: bars.length + 3 });
  }
  /** Scroll so that `time` sits in the middle of the view, keeping the zoom (bottom bar "Go to"). */
  goTo(time: number) {
    const bars = this.visibleBars();
    if (!bars.length) return false;
    let i = bars.findIndex(b => b.time >= time);
    if (i < 0) i = bars.length - 1;
    const r = this.chart.timeScale().getVisibleLogicalRange();
    const half = r ? (r.to - r.from) / 2 : 75;
    this.chart.timeScale().setVisibleLogicalRange({ from: i - half, to: i + half });
    return true;
  }
  resetView() {
    this.chart.timeScale().resetTimeScale();
    this.chart.priceScale('right').applyOptions({ autoScale: true });
  }
  /** Mirror another chart's visible time range (layout "Time" sync). */
  syncRange(range: { from: number; to: number } | null) {
    if (!range || !this.bars.length) return;
    this.syncing = true;
    try { this.chart.timeScale().setVisibleRange({ from: range.from as UTCTimestamp, to: range.to as UTCTimestamp }); } catch { /* outside data */ }
    setTimeout(() => { this.syncing = false; }, 0);
  }
  /** Mirror another chart's crosshair (layout "Crosshair" sync). */
  syncCrosshair(point: { time: number; price: number } | null) {
    if (!point) { this.chart.clearCrosshairPosition(); return; }
    this.chart.setCrosshairPosition(point.price, point.time as UTCTimestamp, this.main);
  }

  // ---------------------------------------------------------------- bar replay
  startReplayPick() {
    this.replayPicking = true;
    this.el.dataset.replayPick = '1';
    this.renderReplayBar();
    this.events.onReplay?.(this);
  }
  private pickReplayAt(e: PointerEvent) {
    const r = this.host.getBoundingClientRect();
    const logical = this.chart.timeScale().coordinateToLogical(e.clientX - r.left);
    if (logical === null) return;
    e.stopPropagation(); e.preventDefault();
    this.enterReplay(Math.max(1, Math.min(this.bars.length - 1, Math.round(logical))));
  }
  enterReplay(index: number) {
    this.replayPicking = false;
    delete this.el.dataset.replayPick;
    this.stopReplayTimer();
    this.replay = { index, playing: false, speed: 1, timer: 0 };
    this.renderData(false);
    this.applyMarkers();
    this.renderReplayBar();
    this.events.onReplay?.(this);
  }
  replayStep() {
    if (!this.replay) return;
    if (this.replay.index >= this.bars.length - 1) { this.stopReplayTimer(); this.renderReplayBar(); return; }
    this.replay.index++;
    const b = this.bars[this.replay.index];
    this.main.update(this.mainData(this.visibleBars()).at(-1) as never);
    this.volume.update({ time: b.time as UTCTimestamp, value: b.volume, color: volColor(b, this.props) });
    this.drawingLayer.setBars(this.visibleBars());
    this.recomputeStudies();
    this.applyMarkers();
    this.renderLegend();
    this.renderReplayBar();
  }
  replayToggle() {
    if (!this.replay) return;
    if (this.replay.playing) { this.stopReplayTimer(); } else {
      this.replay.playing = true;
      this.replay.timer = window.setInterval(() => this.replayStep(), 1000 / this.replay.speed);
    }
    this.renderReplayBar();
  }
  replaySpeed(speed: number) {
    if (!this.replay) return;
    this.replay.speed = speed;
    if (this.replay.playing) { this.stopReplayTimer(); this.replayToggle(); } else this.renderReplayBar();
  }
  private stopReplayTimer() { if (this.replay) { clearInterval(this.replay.timer); this.replay.playing = false; } }
  exitReplay(render = true) {
    const was = this.replay || this.replayPicking;
    this.stopReplayTimer();
    this.replay = null;
    this.replayPicking = false;
    delete this.el.dataset.replayPick;
    this.el.querySelector('.replay-bar')?.remove();
    if (was && render) { this.renderData(false); this.applyMarkers(); this.events.onReplay?.(this); }
  }
  private renderReplayBar() {
    let bar = this.el.querySelector<HTMLElement>('.replay-bar');
    if (!this.replay && !this.replayPicking) { bar?.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'replay-bar';
      bar.addEventListener('click', e => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-r]')?.dataset.r;
        if (act === 'pick') this.startReplayPick();
        if (act === 'play') this.replayToggle();
        if (act === 'step') this.replayStep();
        if (act === 'speed') this.replaySpeed(this.replay?.speed === 1 ? 3 : this.replay?.speed === 3 ? 10 : 1);
        if (act === 'end' || act === 'exit') this.exitReplay();
      });
      this.el.appendChild(bar);
    }
    const r = this.replay;
    const date = r ? this.formatTime(this.bars[r.index].time) : 'Click on the chart to select the starting bar';
    bar.innerHTML = `<button data-r="pick" data-tip="Select bar" data-side="top">${icon('pickbar')}</button>
      <span class="rb-sep"></span>
      <button data-r="play" data-tip="${r?.playing ? 'Pause' : 'Play'}" data-side="top" ${r ? '' : 'disabled'}>${icon(r?.playing ? 'pause' : 'play')}</button>
      <button data-r="step" data-tip="Forward" data-side="top" ${r ? '' : 'disabled'}>${icon('stepfwd')}</button>
      <button data-r="speed" data-tip="Replay speed" data-side="top" ${r ? '' : 'disabled'}>${r?.speed ?? 1}x</button>
      <span class="rb-date">${date}</span><span class="rb-sep"></span>
      <button data-r="end" data-tip="Jump to real-time" data-side="top">${icon('jumpend')}</button>
      <button data-r="exit" data-tip="Exit replay" data-side="top">${icon('close')}</button>`;
  }

  // ---------------------------------------------------------------- legend & time format
  get timezone(): string {
    const tz = this.props.timezone;
    return tz === 'exchange' ? String(this.info.timezone ?? 'UTC') : tz;
  }
  private tickLabel(t: number, type: TickMarkType): string {
    if (this.symbol.startsWith('QUANTIFI:')) return quantifiTick(t, type <= TickMarkType.DayOfMonth);
    const d = new Date(t * 1000), tz = DAILY.has(this.timeframe) ? 'UTC' : this.timezone;
    const f = (o: Intl.DateTimeFormatOptions) => { try { return new Intl.DateTimeFormat('en-US', { ...o, timeZone: tz }).format(d); } catch { return d.toISOString().slice(0, 10); } };
    if (type === TickMarkType.Year) return f({ year: 'numeric' });
    if (type === TickMarkType.Month) return f({ month: 'short' });
    if (type === TickMarkType.DayOfMonth) return f({ day: 'numeric' });
    return f({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  formatTime(t: number): string {
    if (this.symbol.startsWith('QUANTIFI:')) return quantifiLabel(t);
    const daily = DAILY.has(this.timeframe);
    const d = new Date(t * 1000);
    const tz = daily ? 'UTC' : this.timezone;
    const opt: Intl.DateTimeFormatOptions = daily
      ? { weekday: 'short', day: '2-digit', month: 'short', year: '2-digit' }
      : { weekday: 'short', day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    try { return new Intl.DateTimeFormat('en-GB', { ...opt, timeZone: tz }).format(d).replace(',', '').replace(/ (\d\d)$/, " '$1").replace(/ (\d\d) (\d\d:\d\d)$/, " '$1 $2"); }
    catch { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }

  private onCrosshair(p: MouseEventParams<Time>) {
    const bars = this.visibleBars();
    if (p.time === undefined || p.logical === undefined) {
      this.crosshairIndex = null; this.renderLegend(); this.events.onCrosshair?.(this, null, null); return;
    }
    const idx = Math.round(p.logical as number);
    this.crosshairIndex = idx >= 0 && idx < bars.length ? idx : null;
    this.renderLegend();
    const price = p.point ? this.main.coordinateToPrice(p.point.y) : null;
    if (!p.sourceEvent) return;   // programmatic (synced) moves don't echo
    this.events.onCrosshair?.(this, this.crosshairIndex, price === null ? null : { time: p.time as number, price });
  }

  /** Values shown in the legend and the Data Window for a bar index (default: crosshair or last bar). */
  valuesAt(index = this.crosshairIndex ?? this.visibleBars().length - 1) {
    const bars = this.visibleBars();
    const b = bars[index], prev = bars[index - 1];
    if (!b) return null;
    const chg = prev ? b.close - prev.close : 0;
    return {
      time: b.time, bar: b, change: chg, changePct: prev ? (chg / prev.close) * 100 : 0, up: b.close >= (prev?.close ?? b.open),
      studies: this.studies.map(s => {
        const def = INDICATORS[s.id], vals = this.studyValues(s, index);
        return { uid: s.uid, id: s.id, name: `${s.id} ${Object.values(s.inputs).join(' ')}`, visible: s.visible,
          outputs: def.outputs.map(o => ({ key: o.key, color: o.color, value: vals[o.key] })) };
      }),
    };
  }

  title() {
    const desc = String(this.info.description ?? '') || this.symbol.split(':').pop() || '';
    const ex = String(this.info.exchange ?? this.symbol.split(':')[0] ?? '');
    return { desc, interval: tfLegend(this.timeframe), exchange: ex };
  }

  renderLegend() {
    const p = this.props, v = this.valuesAt();
    const fmtV = (x: number) => (Number.isFinite(x) ? fmtNum(x) : '∅');
    const t = this.title();
    const cls = v ? (v.up ? 'up' : 'down') : '';
    const f = (x: number) => this.fmtPrice(x);
    const ohlc = v && p.showOHLC ? `<span class="ohlc ${cls}"><span>O<span class="v">${f(v.bar.open)}</span></span><span>H<span class="v">${f(v.bar.high)}</span></span>
      <span>L<span class="v">${f(v.bar.low)}</span></span><span>C<span class="v">${f(v.bar.close)}</span></span>
      ${p.showChange ? `<span class="v">${v.change >= 0 ? '+' : '−'}${f(Math.abs(v.change))} (${v.change >= 0 ? '+' : '−'}${Math.abs(v.changePct).toFixed(2)}%)</span>` : ''}</span>` : '';
    const ctl = (uid: string, visible: boolean, settings = true) => `<span class="ctl">
      <button data-act="toggle" data-tip="${visible ? 'Hide' : 'Show'}">${icon(visible ? 'eye' : 'eyeoff', 18)}</button>
      ${settings ? `<button data-act="settings" data-tip="Settings">${icon('hexgear', 18)}</button>` : ''}
      <button data-act="remove" data-tip="Remove">${icon('close', 18)}</button></span>`;
    const rows: string[] = [];
    if (!this.legendCollapsed) {
      if (p.showVolume) rows.push(`<div class="legend-row vol ${cls}" data-uid="__vol" data-study="Vol"><span class="lname">Vol</span>
        <span class="lval">${v && this.volumeVisible ? fmtNum(v.bar.volume) : ''}</span>${ctl('__vol', this.volumeVisible, false)}</div>`);
      if (this.strategy) {
        const st = this.strategy, run = this.strategyRun;
        const args = (run?.inputs ?? []).map(i => String(st.inputs[i.title] ?? i.default)).join(' ');
        const pnl = run ? run.key_stats.total_pnl : null;
        rows.push(`<div class="legend-row" data-uid="__strategy" data-study="strategy"><span class="lname">${st.name || run?.meta.name || 'Strategy'} ${args}</span>
          ${this.strategyBusy ? '<span class="lval muted">…</span>' : pnl === null ? '<span class="lval down">error</span>'
            : `<span class="lval" style="color:${pnl >= 0 ? 'var(--up)' : 'var(--down)'}">${pnl >= 0 ? '+' : '−'}${fmtNum(Math.abs(pnl))}</span>`}
          <span class="ctl"><button data-act="report" data-tip="Strategy report">${icon('strategy', 18)}</button>
          <button data-act="settings" data-tip="Settings">${icon('hexgear', 18)}</button>
          <button data-act="remove" data-tip="Remove">${icon('close', 18)}</button></span></div>`);
      }
      for (const c of this.compares) {
        const cb = v ? c.bars.find(b => b.time === v.time) : undefined;
        rows.push(`<div class="legend-row" data-uid="cmp:${c.symbol}" data-compare="${c.symbol}"><span class="lname" style="color:${c.color}">${c.symbol.split(':').pop()}</span>
          <span class="lval" style="color:${c.color}">${cb ? cb.close.toFixed(this.precision) : ''}</span>
          <span class="ctl"><button data-act="remove" data-tip="Remove">${icon('close', 18)}</button></span></div>`);
      }
      for (const s of v?.studies ?? this.studies.map(s => ({ uid: s.uid, id: s.id, name: `${s.id} ${Object.values(s.inputs).join(' ')}`, visible: s.visible, outputs: [] }))) {
        const vals = p.showStudyValues && s.visible ? s.outputs.map(o => `<span class="lval" style="color:${o.color}">${fmtV(o.value)}</span>`).join(' ') : '';
        rows.push(`<div class="legend-row ${s.visible ? '' : 'hidden-study'}" data-uid="${s.uid}" data-study="${s.id}"><span class="lname">${s.name}</span> ${vals}${ctl(s.uid, s.visible)}</div>`);
      }
      rows.push(...this.overlayRows(v ? this.crosshairIndex ?? this.visibleBars().length - 1 : undefined, ctl));
    }
    const n = 1 + this.studies.length + this.compares.length + (this.strategy ? 1 : 0) + this.overlayGroups.length;
    this.legend.innerHTML = `<div class="legend-row main"><span class="legend-title" data-act="symbol" title="${this.symbol}">${t.desc} · ${t.interval} · ${t.exchange}</span>
      <span class="mstatus" data-s="${this.marketStatus ?? ''}" title="${this.marketStatus ?? ''}"></span>${ohlc}</div>${rows.join('')}
      ${n > 1 ? `<button class="legend-toggle" data-act="collapse" data-tip="${this.legendCollapsed ? 'Show indicator legend' : 'Hide indicator legend'}">${icon(this.legendCollapsed ? 'chevronDown' : 'chevronDown', 8)}</button>` : ''}`;
    const tg = this.legend.querySelector<HTMLElement>('.legend-toggle svg');
    if (tg && !this.legendCollapsed) tg.style.transform = 'rotate(180deg)';
  }

  /** Legend controls: hide/show, settings, remove; settings are delegated via the `legend-settings` event. */
  private onLegendClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act!;
    if (act === 'collapse') { this.legendCollapsed = !this.legendCollapsed; this.renderLegend(); return; }
    if (act === 'symbol') { this.el.dispatchEvent(new CustomEvent('legend-symbol', { bubbles: true })); return; }
    const uid = btn.closest<HTMLElement>('[data-uid]')?.dataset.uid;
    if (!uid) return;
    if (uid === '__vol') { if (act === 'toggle' || act === 'remove') this.setVolumeVisible(!this.volumeVisible); return; }
    if (uid === '__strategy') {
      if (act === 'remove') void this.setStrategy(null);
      else this.el.dispatchEvent(new CustomEvent(act === 'report' ? 'strategy-report' : 'strategy-settings', { bubbles: true }));
      return;
    }
    if (uid.startsWith('cmp:')) { this.removeCompare(uid.slice(4)); return; }
    if (uid.startsWith('o:')) {
      const k = uid.slice(2);
      if (act === 'remove') { this.overlayRemoved.add(k); this.syncOverlay(); }
      if (act === 'toggle') {
        if (this.overlayHidden.has(k)) this.overlayHidden.delete(k); else this.overlayHidden.add(k);
        for (const g of this.overlayGroups) if (g.name === k) for (const ser of g.series) ser.applyOptions({ visible: !this.overlayHidden.has(k) && !this.studiesHidden });
      }
      this.renderLegend();
      return;
    }
    const s = this.studies.find(x => x.uid === uid);
    if (!s) return;
    if (act === 'toggle') this.setStudyVisible(uid, !s.visible);
    if (act === 'remove') this.removeStudy(uid);
    if (act === 'settings') this.el.dispatchEvent(new CustomEvent('legend-settings', { bubbles: true, detail: { uid } }));
  }

  // ---------------------------------------------------------------- state
  state(): ChartState {
    return {
      symbol: this.symbol, timeframe: this.timeframe, chartType: this.chartType, adjustment: this.adjustment,
      studies: this.studies.map(s => ({ id: s.id, inputs: s.inputs, ...(s.visible ? {} : { visible: false }) })),
      compare: this.compares.map(c => c.symbol),
      strategy: this.strategy,
      drawings: { ...this.drawingsBySymbol, [this.symbol]: this.drawingLayer.drawings },
    };
  }

  /** Studies + drawings + compares, without data (undo/redo history). */
  snapshot(): Snapshot {
    return {
      studies: this.studies.map(s => ({ id: s.id, inputs: { ...s.inputs }, visible: s.visible })),
      drawings: JSON.parse(JSON.stringify({ ...this.drawingsBySymbol, [this.symbol]: this.drawingLayer.drawings })),
      compare: this.compares.map(c => c.symbol),
    };
  }
  applySnapshot(s: Snapshot) {
    const silent = this.events.onChange;
    this.events.onChange = undefined;
    try {
      for (const st of [...this.studies]) this.removeStudy(st.uid);
      for (const st of s.studies) if (INDICATORS[st.id]) this.addStudy(st.id, st.inputs, undefined, st.visible ?? true);
      this.drawingsBySymbol = JSON.parse(JSON.stringify(s.drawings));
      this.drawingLayer.setDrawings(this.drawingsBySymbol[this.symbol] ?? []);
      for (const c of [...this.compares]) if (!s.compare.includes(c.symbol)) this.removeCompare(c.symbol);
      for (const sym of s.compare) if (!this.compares.some(c => c.symbol === sym)) void this.addCompare(sym);
    } finally {
      this.events.onChange = silent;
    }
    this.renderLegend();
    this.events.onChange?.(this, 'data');
  }

  async restore(st: ChartState) {
    for (const s of [...this.studies]) this.removeStudy(s.uid);
    for (const c of [...this.compares]) this.removeCompare(c.symbol);
    this.drawingsBySymbol = {};
    for (const [sym, ds] of Object.entries(st.drawings ?? {})) this.drawingsBySymbol[sym] = (ds as unknown[]).filter(validate) as Drawing[];
    for (const s of st.studies ?? []) if (INDICATORS[s.id]) this.addStudy(s.id, s.inputs, undefined, s.visible ?? true);
    if (st.chartType && st.chartType !== this.chartType) { this.chartType = st.chartType as ChartType; this.createMain(); }
    this.adjustment = st.adjustment === 'dividends' ? 'dividends' : 'splits';
    for (const sym of st.compare ?? []) {
      const color = COMPARE_COLORS[this.compares.length % COMPARE_COLORS.length];
      this.compares.push({ symbol: sym, color, series: this.chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false }), bars: [] });
    }
    this.applyProps();
    this.strategy = st.strategy ?? null;
    this.strategyRun = null;
    this.clearStrategyPlots();
    await this.load(st.symbol, st.timeframe);
  }

  destroy() { this.exitReplay(false); this.stopStream?.(); this.chart.remove(); this.el.remove(); }
}

/** Interval as TradingView shows it in the legend: 5, 15, 1h, 4h, 1D, 1W, 1M. */
export function tfLegend(tf: string): string {
  if (tf === 'D' || tf === 'W' || tf === 'M') return `1${tf}`;
  const ticks = tickInterval(tf);
  if (ticks) return `${ticks} tick${ticks > 1 ? 's' : ''}`;
  const m = Number(tf);
  return m >= 60 && m % 60 === 0 ? `${m / 60}h` : tf;
}
/** Interval as the top-bar button shows it: 5m, 1h, D, W, M. */
export function tfLabel(tf: string): string {
  if (tf === 'D' || tf === 'W' || tf === 'M') return tf;
  const ticks = tickInterval(tf);
  if (ticks) return `${ticks}T`;
  const m = Number(tf);
  return m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${tf}m`;
}

const volColor = (b: Bar, p: ChartProps) => `${b.close >= b.open ? p.upColor : p.downColor}80`;
export function fmtNum(x: number): string {
  const a = Math.abs(x);
  if (a >= 1e9) return `${(x / 1e9).toFixed(2)} B`;
  if (a >= 1e6) return `${(x / 1e6).toFixed(2)} M`;
  if (a >= 1e3) return `${(x / 1e3).toFixed(2)} K`;
  return a >= 10 ? x.toFixed(2) : x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function getCss(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000';
}
