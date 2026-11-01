// Drawing layer: a lightweight-charts series primitive that renders drawings and owns the
// pointer interactions for creating, selecting, dragging, erasing and measuring.
import type {
  IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneRenderer, IPrimitivePaneView, SeriesType, Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import {
  ANCHORS, FIB_COLORS, create, fibPrices, formatSpan, hitTest, logicalToTime, magnetSnap, moveAnchor, positionStats,
  rangeStats, timeToLogical, translate,
  type CreateContext, type Drawing, type Hit, type Point, type ToolType, type XY,
} from './model';

/** Drawing tools plus the pointer modes that do not create a stored drawing. */
export type Tool = ToolType | 'cursor' | 'eraser' | 'measure' | 'zoom';
export type Magnet = 'off' | 'weak' | 'strong';
interface BarLike { time: number; open: number; high: number; low: number; close: number }

const FONT = '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, sans-serif';
const clicks = (t: Tool) => (t === 'measure' || t === 'zoom' ? 2 : t === 'cursor' || t === 'eraser' ? 0 : ANCHORS[t]);

export class DrawingLayer implements ISeriesPrimitive<Time> {
  drawings: Drawing[] = [];
  tool: Tool = 'cursor';
  magnetMode: Magnet = 'off';
  keepDrawing = false;      // TradingView "Keep drawing": stay in the tool after finishing a drawing
  locked = false;           // "Lock all drawings"
  hidden = false;           // "Hide all drawings"
  selected: string | null = null;
  onChange: (drawings: Drawing[], what: string) => void = () => {};
  onToolDone: () => void = () => {};
  onZoom: (fromLogical: number, toLogical: number) => void = () => {};
  textProvider: () => string = () => 'Text';
  formatPrice: (p: number) => string = p => p.toFixed(Math.abs(p) < 10 ? 3 : 2);

  private chart!: IChartApi;
  private series!: ISeriesApi<SeriesType>;
  private requestUpdate: () => void = () => {};
  private bars: BarLike[] = [];
  private times: number[] = [];
  private pending: (Point & { logical: number })[] = [];   // anchors placed for the drawing being created
  private preview: (Point & { logical: number }) | null = null;
  private measure: Drawing | null = null;                   // transient result of the measure tool
  private resumeTool: Tool | null = null;                   // Shift+click measure returns to this tool
  private drag: { id: string; part: 'body' | number; start: { logical: number; price: number }; orig: Drawing } | null = null;
  private hover: string | null = null;
  private readonly view: IPrimitivePaneView;

  constructor(private readonly container: HTMLElement) {
    const renderer: IPrimitivePaneRenderer = { draw: target => this.draw(target) };
    this.view = { renderer: () => renderer, zOrder: () => 'top' };
  }

  /** Back-compat boolean view of the magnet (true = weak or strong). */
  get magnet() { return this.magnetMode !== 'off'; }
  set magnet(on: boolean) { this.magnetMode = on ? 'weak' : 'off'; }

  // ---------------------------------------------------------------- primitive lifecycle
  attached({ chart, series, requestUpdate }: { chart: IChartApi; series: ISeriesApi<SeriesType>; requestUpdate: () => void }) {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
    this.container.addEventListener('pointerdown', this.onDown, true);
    this.container.addEventListener('pointermove', this.onMove, true);
    this.container.addEventListener('pointerup', this.onUp, true);
  }
  detached() {
    this.container.removeEventListener('pointerdown', this.onDown, true);
    this.container.removeEventListener('pointermove', this.onMove, true);
    this.container.removeEventListener('pointerup', this.onUp, true);
  }
  paneViews() { return [this.view]; }
  updateAllViews() { /* geometry is computed at draw time */ }

  // ---------------------------------------------------------------- public API
  setBars(bars: BarLike[]) { this.bars = bars; this.times = bars.map(b => b.time); this.requestUpdate(); }
  setDrawings(ds: Drawing[]) { this.drawings = ds; this.selected = null; this.measure = null; this.requestUpdate(); }
  setTool(tool: Tool) {
    this.tool = tool; this.pending = []; this.preview = null;
    this.container.style.cursor = tool === 'cursor' ? '' : tool === 'eraser' ? 'cell' : tool === 'zoom' ? 'zoom-in' : 'crosshair';
    this.requestUpdate();
  }
  remove(id: string) { this.drawings = this.drawings.filter(d => d.id !== id); if (this.selected === id) this.selected = null; this.commit('remove'); }
  clear() { this.drawings = []; this.selected = null; this.commit('remove all'); }
  deleteSelected(): boolean { if (!this.selected) return false; this.remove(this.selected); return true; }
  cancel() {
    if (this.measure) { this.measure = null; this.requestUpdate(); }
    if (this.pending.length || this.tool !== 'cursor') { this.setTool('cursor'); this.onToolDone(); return true; }
    this.selected = null; this.requestUpdate(); return false;
  }
  /** Place a drawing programmatically (keyboard shortcut Alt+H etc. at the cursor price). */
  add(d: Drawing) { this.drawings = [...this.drawings, d]; this.selected = d.id; this.commit('create'); }
  update(d: Drawing) { this.drawings = this.drawings.map(x => (x.id === d.id ? d : x)); this.commit('edit'); }
  redraw() { this.requestUpdate(); }
  get measurement() { return this.measure; }

  // ---------------------------------------------------------------- coordinates
  private toXY(p: Point): XY | null {
    const x = this.chart.timeScale().logicalToCoordinate(timeToLogical(this.times, p.time) as never);
    const y = this.series.priceToCoordinate(p.price);
    return x === null || y === null ? null : { x, y };
  }
  private local(e: PointerEvent): XY {
    const r = this.container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  /** Pointer position -> {time, price, logical}; null if outside the main pane. */
  pointAt(xy: XY): (Point & { logical: number }) | null {
    const pane = this.chart.panes()[0]?.getHTMLElement();
    if (pane && xy.y > pane.clientHeight) return null;
    const width = this.chart.timeScale().width();
    if (xy.x > width) return null;
    const logical = this.chart.timeScale().coordinateToLogical(xy.x);
    let price = this.series.coordinateToPrice(xy.y);
    if (logical === null || price === null) return null;
    const time = logicalToTime(this.times, logical);
    if (this.magnetMode !== 'off' && this.tool !== 'cursor' && this.tool !== 'zoom') {
      const idx = Math.round(logical);
      const px = this.magnetMode === 'strong' ? Infinity : 30;
      price = magnetSnap(price, this.bars[idx], p => this.series.priceToCoordinate(p), xy.y, px) as typeof price;
      return { time: this.times[idx] ?? time, price, logical: this.times[idx] !== undefined ? idx : logical };
    }
    return { time, price, logical };
  }
  private hitAt(xy: XY): Hit {
    if (this.hidden) return null;
    const width = this.chart.timeScale().width();
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i];
      if (d.hidden) continue;
      const pts = d.points.map(p => this.toXY(p));
      if (pts.some(p => p === null)) continue;
      const levelYs = d.type === 'fib' ? fibPrices(d).map(l => this.series.priceToCoordinate(l.price) ?? NaN) : [];
      const h = hitTest(d, pts as XY[], xy, width, levelYs);
      if (h) return h;
    }
    return null;
  }
  private createContext(): CreateContext {
    const pane = this.chart.panes()[0]?.getHTMLElement();
    const top = this.series.coordinateToPrice(0), bottom = this.series.coordinateToPrice(pane?.clientHeight ?? 300);
    const n = this.times.length;
    return { priceSpan: top !== null && bottom !== null ? Math.abs(top - bottom) : undefined,
      barSeconds: n > 1 ? this.times[n - 1] - this.times[n - 2] : 86400 };
  }

  // ---------------------------------------------------------------- pointer handling
  private lockChart(lock: boolean) {
    this.chart.applyOptions({ handleScroll: !lock, handleScale: !lock });
  }
  private finish() {
    if (this.resumeTool) { const t = this.resumeTool; this.resumeTool = null; this.setTool(t); this.onToolDone(); return; }
    this.setTool('cursor');
    this.onToolDone();
  }
  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const xy = this.local(e);
    const pt = this.pointAt(xy);
    if (this.measure && !this.pending.length) { this.measure = null; this.requestUpdate(); if (this.tool === 'cursor' && !e.shiftKey) return; }
    if (this.tool === 'cursor' && e.shiftKey && pt) {          // TradingView: Shift + click starts a measurement
      this.resumeTool = 'cursor';
      this.setTool('measure');
    }
    if (this.tool === 'eraser') {
      const hit = this.hitAt(xy);
      if (hit) { e.stopPropagation(); e.preventDefault(); this.remove(hit.id); }
      return;
    }
    if (this.tool !== 'cursor') {
      if (!pt) return;
      e.stopPropagation(); e.preventDefault();
      this.pending.push(pt);
      if (this.pending.length >= clicks(this.tool)) this.complete();
      this.requestUpdate();
      return;
    }
    const hit = this.hitAt(xy);
    if (hit && pt) {
      e.stopPropagation(); e.preventDefault();
      const d = this.drawings.find(x => x.id === hit.id)!;
      this.selected = hit.id;
      if (!d.locked && !this.locked) {
        this.drag = { id: hit.id, part: hit.part, start: { logical: pt.logical, price: pt.price }, orig: d };
        this.lockChart(true);
        this.container.setPointerCapture?.(e.pointerId);
      }
      this.requestUpdate();
      this.onChange(this.drawings, 'select');
    } else if (this.selected) {
      this.selected = null;
      this.requestUpdate();
      this.onChange(this.drawings, 'select');
    }
  };
  private complete() {
    const tool = this.tool as Exclude<Tool, 'cursor' | 'eraser'>;
    const pts = this.pending.map(p => ({ time: p.time, price: p.price }));
    if (tool === 'zoom') {
      const [a, b] = this.pending;
      this.pending = [];
      if (Math.abs(b.logical - a.logical) >= 2) this.onZoom(Math.min(a.logical, b.logical), Math.max(a.logical, b.logical));
      this.finish();
      return;
    }
    if (tool === 'measure') {
      this.measure = { ...create('datepricerange', pts), id: '__measure' };
      this.pending = [];
      this.finish();
      return;
    }
    const d = create(tool, pts, tool === 'text' ? this.textProvider() : undefined, this.createContext());
    this.drawings = [...this.drawings, d];
    this.selected = d.id;
    this.pending = [];
    if (this.keepDrawing) this.preview = null; else { this.setTool('cursor'); this.onToolDone(); }
    this.commit('create');
  }
  private onMove = (e: PointerEvent) => {
    const xy = this.local(e);
    if (this.tool !== 'cursor' && this.tool !== 'eraser') {
      this.preview = this.pointAt(xy);
      this.requestUpdate();
      return;
    }
    if (this.drag) {
      e.stopPropagation();
      const pt = this.pointAt(xy);
      if (!pt) return;
      const { orig, part, start } = this.drag;
      const next = part === 'body'
        ? translate(orig, this.times, pt.logical - start.logical, pt.price - start.price)
        : moveAnchor(orig, part, { time: pt.time, price: pt.price });
      this.drawings = this.drawings.map(d => (d.id === orig.id ? next : d));
      this.requestUpdate();
      return;
    }
    const hit = this.hitAt(xy);
    const id = hit?.id ?? null;
    if (id !== this.hover) {
      this.hover = id;
      this.container.style.cursor = id ? (this.tool === 'eraser' ? 'cell' : 'pointer') : this.tool === 'eraser' ? 'cell' : '';
      this.requestUpdate();
    }
  };
  private onUp = (e: PointerEvent) => {
    if (!this.drag) return;
    e.stopPropagation();
    const moved = this.drawings.find(d => d.id === this.drag!.id) !== this.drag.orig;
    this.drag = null;
    this.lockChart(false);
    this.container.releasePointerCapture?.(e.pointerId);
    if (moved) this.commit('move');
  };
  private commit(what: string) { this.requestUpdate(); this.onChange(this.drawings, what); }

  // ---------------------------------------------------------------- rendering
  private draw(target: CanvasRenderingTarget2D) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const all = this.hidden ? [] : this.drawings.filter(d => !d.hidden);
      const extra: Drawing[] = [];
      if (this.measure) extra.push(this.measure);
      const t = this.tool;
      if (t !== 'cursor' && t !== 'eraser' && this.pending.length && this.preview) {
        const n = clicks(t);
        const pts = [...this.pending, this.preview].slice(0, n).map(p => ({ time: p.time, price: p.price }));
        while (pts.length < n) pts.push({ time: this.preview.time, price: this.preview.price });
        const type: ToolType = t === 'measure' ? 'datepricerange' : t === 'zoom' ? 'daterange' : t;
        extra.push({ ...create(type, pts, undefined, this.createContext()), id: '__preview' });
      }
      for (const d of [...all, ...extra]) this.drawOne(ctx, d, mediaSize.width, mediaSize.height, d.id === this.selected || d.id === this.hover);
    });
  }

  private label(ctx: CanvasRenderingContext2D, lines: string[], cx: number, y: number, bg: string, above = false) {
    ctx.font = `12px ${FONT}`;
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 16, h = lines.length * 16 + 8;
    const top = above ? y - h - 6 : y + 6;
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.roundRect(cx - w / 2, top, w, h, 4); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    lines.forEach((l, i) => ctx.fillText(l, cx, top + 16 + i * 16));
    ctx.textAlign = 'left';
  }

  private drawOne(ctx: CanvasRenderingContext2D, d: Drawing, width: number, height: number, highlight: boolean) {
    const pts = d.points.map(p => this.toXY(p));
    if (pts.some(p => p === null)) return;
    const [a, b, c] = pts as XY[];
    ctx.save();
    ctx.strokeStyle = d.style.color;
    ctx.fillStyle = d.style.color;
    ctx.lineWidth = d.style.width;
    ctx.setLineDash(d.style.dash ?? []);
    const line = (p: XY, q: XY) => { ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); };
    const extend = (p: XY, q: XY, back: boolean) => {
      const dx = q.x - p.x, dy = q.y - p.y, k = 1e4 / Math.max(Math.hypot(dx, dy), 1e-9);
      line(back ? { x: p.x - dx * k, y: p.y - dy * k } : p, { x: q.x + dx * k, y: q.y + dy * k });
    };
    const arrow = (p: XY, q: XY) => {
      line(p, q);
      const ang = Math.atan2(q.y - p.y, q.x - p.x), s = 7;
      ctx.beginPath(); ctx.moveTo(q.x, q.y);
      ctx.lineTo(q.x - s * Math.cos(ang - 0.45), q.y - s * Math.sin(ang - 0.45));
      ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - s * Math.cos(ang + 0.45), q.y - s * Math.sin(ang + 0.45)); ctx.stroke();
    };
    const box = (p: XY, q: XY, fill?: string) => {
      const x = Math.min(p.x, q.x), y = Math.min(p.y, q.y), w = Math.abs(p.x - q.x), h = Math.abs(p.y - q.y);
      if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }
      return { x, y, w, h };
    };
    const bars = () => Math.round(timeToLogical(this.times, d.points[1].time) - timeToLogical(this.times, d.points[0].time));
    switch (d.type) {
      case 'trend': line(a, b); break;
      case 'ray': extend(a, b, false); break;
      case 'extended': extend(a, b, true); break;
      case 'hline': line({ x: 0, y: a.y }, { x: width, y: a.y }); this.priceTag(ctx, d.points[0].price, a.y, width, d.style.color); break;
      case 'hray': line(a, { x: width, y: a.y }); break;
      case 'vline': line({ x: a.x, y: 0 }, { x: a.x, y: height }); break;
      case 'crossline': line({ x: 0, y: a.y }, { x: width, y: a.y }); line({ x: a.x, y: 0 }, { x: a.x, y: height }); break;
      case 'rect': { const r = box(a, b, d.style.fill); ctx.strokeRect(r.x, r.y, r.w, r.h); break; }
      case 'circle': {
        const r = Math.hypot(b.x - a.x, b.y - a.y);
        ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
        if (d.style.fill) { ctx.fillStyle = d.style.fill; ctx.fill(); }
        ctx.stroke();
        break;
      }
      case 'long': case 'short': {
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
        ctx.fillStyle = 'rgba(8, 153, 129, 0.2)'; ctx.fillRect(x0, Math.min(a.y, b.y), x1 - x0, Math.abs(b.y - a.y));
        ctx.fillStyle = 'rgba(242, 54, 69, 0.2)'; ctx.fillRect(x0, Math.min(a.y, c.y), x1 - x0, Math.abs(c.y - a.y));
        ctx.strokeStyle = '#787B86'; line({ x: x0, y: a.y }, { x: x1, y: a.y });
        const st = positionStats(d), mid = (x0 + x1) / 2, f = this.formatPrice;
        this.label(ctx, [`Target: ${f(st.target)} (${st.targetPct.toFixed(2)}%)`], mid, b.y, '#089981', b.y < a.y);
        this.label(ctx, [`Stop: ${f(st.stop)} (${st.stopPct.toFixed(2)}%)`], mid, c.y, '#F23645', c.y < a.y);
        this.label(ctx, [`Risk/Reward Ratio: ${Number.isFinite(st.rr) ? st.rr.toFixed(2) : '∞'}`], mid, a.y, '#787B86', b.y > a.y);
        break;
      }
      case 'pricerange': case 'daterange': case 'datepricerange': {
        const r = box(a, b, d.style.fill);
        ctx.strokeStyle = d.style.color;
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        if (d.type !== 'daterange') arrow({ x: cx, y: a.y }, { x: cx, y: b.y });
        if (d.type !== 'pricerange') arrow({ x: a.x, y: cy }, { x: b.x, y: cy });
        const s = rangeStats(d.points[0], d.points[1], bars());
        const priceLine = `${s.change >= 0 ? '' : '−'}${this.formatPrice(Math.abs(s.change))} (${s.pct.toFixed(2)}%)`;
        const timeLine = `${s.bars} bars, ${formatSpan(s.seconds)}`;
        const lines = d.type === 'pricerange' ? [priceLine] : d.type === 'daterange' ? [timeLine] : [priceLine, timeLine];
        const down = b.y > a.y;
        this.label(ctx, lines, cx, down ? r.y + r.h : r.y, s.change < 0 && d.type !== 'daterange' ? '#F23645' : '#2962FF', !down);
        break;
      }
      case 'fib': {
        const x0 = Math.min(a.x, b.x);
        ctx.setLineDash([]);
        ctx.font = `11px ${FONT}`;
        fibPrices(d).forEach(({ level, price }, i) => {
          const y = this.series.priceToCoordinate(price);
          if (y === null) return;
          ctx.strokeStyle = ctx.fillStyle = FIB_COLORS[i % FIB_COLORS.length];
          line({ x: x0, y }, { x: Math.max(a.x, b.x), y });
          const t = `${level} (${this.formatPrice(price)})`;
          ctx.fillText(t, x0 - 4 - ctx.measureText(t).width, y + 4);
        });
        ctx.strokeStyle = d.style.color;
        ctx.setLineDash([4, 4]);
        line(a, b);
        break;
      }
      case 'text':
        ctx.font = `14px ${FONT}`;
        ctx.fillText(d.text ?? 'Text', a.x, a.y);
        break;
      case 'pricelabel': {
        const t = this.formatPrice(d.points[0].price);
        ctx.font = `12px ${FONT}`;
        const w = ctx.measureText(t).width + 14;
        ctx.beginPath(); ctx.roundRect(a.x + 4, a.y - 28, w, 22, 4); ctx.fill();
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + 8, a.y - 6); ctx.lineTo(a.x + 14, a.y - 6); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(t, a.x + 11, a.y - 13);
        break;
      }
    }
    if (highlight && d.id !== '__preview' && d.id !== '__measure') {
      ctx.setLineDash([]);
      for (const p of pts as XY[]) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = d.style.color; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
    ctx.restore();
  }

  private priceTag(ctx: CanvasRenderingContext2D, price: number, y: number, width: number, color: string) {
    const text = this.formatPrice(price);
    ctx.font = `11px ${FONT}`;
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = color; ctx.fillRect(width - w, y - 9, w, 18);
    ctx.fillStyle = '#fff'; ctx.fillText(text, width - w + 4, y + 4);
  }
}
