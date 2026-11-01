// Drawing model: pure data + geometry, no chart dependency (unit-tested in test/drawings.test.ts).
//
// Points are stored as {time, price} like TradingView line tools, so drawings survive symbol
// switches back, timeframe changes and reloads. Times beyond the last bar are extrapolated by
// the bar interval (drawings can extend into the future area).

export type ToolType =
  | 'trend' | 'ray' | 'extended' | 'hline' | 'hray' | 'vline' | 'crossline'
  | 'fib'
  | 'long' | 'short' | 'pricerange' | 'daterange' | 'datepricerange'
  | 'rect' | 'circle'
  | 'text' | 'pricelabel';
export interface Point { time: number; price: number }
export interface Drawing {
  id: string; type: ToolType; points: Point[];
  style: { color: string; width: number; dash?: number[]; fill?: string };
  text?: string; locked?: boolean; hidden?: boolean;
}

/** Clicks each tool needs (TradingView: trend = 2 clicks, horizontal line = 1, long position = 1). */
export const ANCHORS: Record<ToolType, number> = {
  trend: 2, ray: 2, extended: 2, hline: 1, hray: 1, vline: 1, crossline: 1, fib: 2,
  long: 1, short: 1, pricerange: 2, daterange: 2, datepricerange: 2, rect: 2, circle: 2, text: 1, pricelabel: 1,
};
/** Points stored per drawing (a position stores entry, target and stop). */
export const POINTS: Record<ToolType, number> = { ...ANCHORS, long: 3, short: 3 };

/** Names as TradingView shows them in the toolbar flyouts and the object tree. */
export const TOOL_LABELS: Record<ToolType, string> = {
  trend: 'Trendline', ray: 'Ray', extended: 'Extended line', hline: 'Horizontal line', hray: 'Horizontal ray',
  vline: 'Vertical line', crossline: 'Crossline', fib: 'Fib retracement', long: 'Long position', short: 'Short position',
  pricerange: 'Price range', daterange: 'Date range', datepricerange: 'Date and price range', rect: 'Rectangle',
  circle: 'Circle', text: 'Text', pricelabel: 'Price label',
};

/** Fib retracement levels visible by default, with TradingView's default colors (measured on a
 *  signed-in chart: re/traces/signed_in). The full set has 24 levels; the rest start hidden. */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236];
export const FIB_COLORS = ['#808080', '#F23645', '#FF9800', '#4CAF50', '#089981', '#00BCD4', '#808080', '#2962FF', '#F23645', '#9C27B0', '#E91E63'];
export const FIB_ALL_LEVELS = [...FIB_LEVELS, 1.272, 1.414, 2.272, 2.414, 2, 3, 3.272, 3.414, 4, 4.272, 4.414, 4.618, 4.764];

const BLUE = { color: '#2962FF', width: 2 };
export const DEFAULT_STYLE: Record<ToolType, Drawing['style']> = {
  trend: BLUE, ray: BLUE, extended: BLUE, hline: BLUE, hray: BLUE, vline: BLUE, crossline: BLUE,
  fib: { color: '#787B86', width: 1 },
  long: { color: '#089981', width: 1, fill: 'rgba(8, 153, 129, 0.2)' },
  short: { color: '#F23645', width: 1, fill: 'rgba(242, 54, 69, 0.2)' },
  pricerange: { color: '#2962FF', width: 1, fill: 'rgba(41, 98, 255, 0.2)' },
  daterange: { color: '#2962FF', width: 1, fill: 'rgba(41, 98, 255, 0.2)' },
  datepricerange: { color: '#2962FF', width: 1, fill: 'rgba(41, 98, 255, 0.2)' },
  rect: { color: '#9C27B0', width: 1, fill: 'rgba(156, 39, 176, 0.2)' },
  circle: { color: '#FF9800', width: 1, fill: 'rgba(255, 152, 0, 0.2)' },
  text: { color: '#2962FF', width: 1 }, pricelabel: { color: '#2962FF', width: 1 },
};

/** Hit tolerance in CSS px around a line (TradingView-like grab distance). */
export const HIT_TOLERANCE = 6;

let seq = 0;
export const newId = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Context for one-click tools: the visible price span and the bar interval in seconds. */
export interface CreateContext { priceSpan?: number; barSeconds?: number }

export function create(type: ToolType, points: Point[], text?: string, ctx: CreateContext = {}): Drawing {
  let pts = points.map(p => ({ ...p }));
  if ((type === 'long' || type === 'short') && pts.length === 1) {
    // TradingView places a position with target/stop at a fraction of the visible range, ~20 bars wide
    const e = pts[0];
    const dist = ctx.priceSpan ? ctx.priceSpan * 0.08 : Math.abs(e.price) * 0.02 || 1;
    const right = e.time + 20 * (ctx.barSeconds ?? 86400);
    const sign = type === 'long' ? 1 : -1;
    pts = [e, { time: right, price: e.price + sign * dist }, { time: right, price: e.price - sign * dist / 2 }];
  }
  return { id: newId(), type, points: pts, style: { ...DEFAULT_STYLE[type] }, text };
}

/** Fib level prices: level 0 at the second anchor, level 1 at the first (TradingView orientation). */
export function fibPrices(d: Drawing, levels = FIB_LEVELS): { level: number; price: number }[] {
  const [a, b] = d.points;
  return levels.map(level => ({ level, price: b.price + (a.price - b.price) * level }));
}

/** Long/short position numbers: target and stop distances, % and the risk/reward ratio. */
export function positionStats(d: Drawing) {
  const [e, t, s] = d.points;
  const reward = Math.abs(t.price - e.price), risk = Math.abs(e.price - s.price);
  return {
    entry: e.price, target: t.price, stop: s.price,
    targetPct: (t.price / e.price - 1) * 100, stopPct: (s.price / e.price - 1) * 100,
    rr: risk > 0 ? reward / risk : Infinity,
  };
}

/** Measurement label for the range tools (price change, %, bars, calendar span). */
export function rangeStats(a: Point, b: Point, bars: number) {
  const dp = b.price - a.price;
  return { change: dp, pct: a.price ? (dp / a.price) * 100 : 0, bars, seconds: b.time - a.time };
}

export function formatSpan(seconds: number): string {
  const s = Math.abs(seconds), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d >= 1) return h ? `${d}d ${h}h` : `${d}d`;
  if (h >= 1) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

// ---------------------------------------------------------------- time <-> logical index
/** Map a time to a (fractional) logical bar index using the loaded bar times; extrapolates on both ends. */
export function timeToLogical(times: ArrayLike<number>, t: number): number {
  const n = times.length;
  if (n === 0) return 0;
  if (n === 1) return t === times[0] ? 0 : 0;
  const step = n > 1 ? times[n - 1] - times[n - 2] : 86400;
  if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / step;
  const firstStep = times[1] - times[0];
  if (t <= times[0]) return (t - times[0]) / firstStep;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
  return lo + (t - times[lo]) / (times[hi] - times[lo]);
}

export function logicalToTime(times: ArrayLike<number>, logical: number): number {
  const n = times.length;
  if (n === 0) return 0;
  if (n === 1) return times[0];
  if (logical >= n - 1) return Math.round(times[n - 1] + (logical - (n - 1)) * (times[n - 1] - times[n - 2]));
  if (logical <= 0) return Math.round(times[0] + logical * (times[1] - times[0]));
  const i = Math.floor(logical), f = logical - i;
  return Math.round(times[i] + f * (times[i + 1] - times[i]));
}

// ---------------------------------------------------------------- hit testing (screen space)
export interface XY { x: number; y: number }

export function distToSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from p to the infinite line (extended) or ray (from a through b). */
export function distToLine(p: XY, a: XY, b: XY, ray: boolean): number {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  if (ray) t = Math.max(0, t);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distToBox(p: XY, x0: number, y0: number, x1: number, y1: number, filled: boolean): number {
  const inside = p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  if (inside && filled) return 0;
  return Math.min(
    distToSegment(p, { x: x0, y: y0 }, { x: x1, y: y0 }), distToSegment(p, { x: x1, y: y0 }, { x: x1, y: y1 }),
    distToSegment(p, { x: x1, y: y1 }, { x: x0, y: y1 }), distToSegment(p, { x: x0, y: y1 }, { x: x0, y: y0 }));
}

export type Hit = { id: string; part: 'body' | number } | null;   // number = anchor index

/**
 * Hit-test one drawing whose anchors are already projected to screen. `levelYs` are fib level
 * y-coordinates; `width` is the pane width (for horizontal lines).
 */
export function hitTest(d: Drawing, pts: XY[], p: XY, width: number, levelYs: number[] = [], tol = HIT_TOLERANCE): Hit {
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(p.x - pts[i].x, p.y - pts[i].y) <= tol + 2) return { id: d.id, part: i };
  }
  const [a, b, c] = pts;
  let dist = Infinity;
  switch (d.type) {
    case 'trend': dist = distToSegment(p, a, b); break;
    case 'ray': dist = distToLine(p, a, b, true); break;
    case 'extended': dist = distToLine(p, a, b, false); break;
    case 'hline': dist = Math.abs(p.y - a.y); break;
    case 'hray': dist = p.x >= a.x - tol ? Math.abs(p.y - a.y) : Infinity; break;
    case 'vline': dist = Math.abs(p.x - a.x); break;
    case 'crossline': dist = Math.min(Math.abs(p.x - a.x), Math.abs(p.y - a.y)); break;
    case 'rect': case 'pricerange': case 'daterange': case 'datepricerange':
      dist = distToBox(p, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), true);
      break;
    case 'long': case 'short': {
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
      dist = Math.min(distToBox(p, x0, Math.min(a.y, b.y), x1, Math.max(a.y, b.y), true),
        distToBox(p, x0, Math.min(a.y, c.y), x1, Math.max(a.y, c.y), true));
      break;
    }
    case 'circle': {
      const r = Math.hypot(b.x - a.x, b.y - a.y), q = Math.hypot(p.x - a.x, p.y - a.y);
      dist = q <= r ? 0 : q - r;
      break;
    }
    case 'fib': {
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
      for (const y of levelYs) dist = Math.min(dist, distToSegment(p, { x: x0, y }, { x: Math.max(x1, width), y }));
      dist = Math.min(dist, distToSegment(p, a, b));
      break;
    }
    case 'text': dist = p.x >= a.x - 4 && p.x <= a.x + 8 * (d.text?.length ?? 4) && p.y <= a.y + 4 && p.y >= a.y - 16 ? 0 : Infinity; break;
    case 'pricelabel': dist = p.x >= a.x && p.x <= a.x + 80 && p.y <= a.y && p.y >= a.y - 30 ? 0 : Infinity; break;
  }
  void width;
  return dist <= tol ? { id: d.id, part: 'body' } : null;
}

/** Move a whole drawing by a delta in (logical, price) space; returns a new drawing. */
export function translate(d: Drawing, times: ArrayLike<number>, dLogical: number, dPrice: number): Drawing {
  return {
    ...d,
    points: d.points.map(p => ({ time: logicalToTime(times, timeToLogical(times, p.time) + dLogical), price: p.price + dPrice })),
  };
}

/** Drag one anchor. Positions keep target/stop on one right edge; the entry anchor moves the left edge. */
export function moveAnchor(d: Drawing, idx: number, pt: Point): Drawing {
  if (d.type === 'long' || d.type === 'short') {
    const [e, t, s] = d.points;
    if (idx === 0) return { ...d, points: [{ ...pt }, t, s] };
    const right = pt.time;
    return { ...d, points: [e, { time: right, price: idx === 1 ? pt.price : t.price }, { time: right, price: idx === 2 ? pt.price : s.price }] };
  }
  return { ...d, points: d.points.map((p, i) => (i === idx ? { ...pt } : p)) };
}

/** Magnet: snap a price to the nearest OHLC value of the bar under the cursor if within `px` pixels
 *  (weak magnet); `px = Infinity` always snaps (strong magnet). */
export function magnetSnap(price: number, bar: { open: number; high: number; low: number; close: number } | undefined,
  priceToY: (p: number) => number | null, y: number, px = 30): number {
  if (!bar) return price;
  let best = price, bestD = px;
  for (const v of [bar.open, bar.high, bar.low, bar.close]) {
    const vy = priceToY(v);
    if (vy !== null && Math.abs(vy - y) < bestD) { bestD = Math.abs(vy - y); best = v; }
  }
  return best;
}

export function validate(d: unknown): d is Drawing {
  const x = d as Drawing;
  return !!x && typeof x.id === 'string' && x.type in POINTS && Array.isArray(x.points)
    && x.points.length === POINTS[x.type] && x.points.every(p => Number.isFinite(p.time) && Number.isFinite(p.price));
}
