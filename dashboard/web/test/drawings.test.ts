import { describe, expect, it } from 'vitest';
import {
  ANCHORS, FIB_ALL_LEVELS, FIB_LEVELS, create, distToLine, distToSegment, fibPrices, formatSpan, hitTest, logicalToTime, magnetSnap,
  moveAnchor, positionStats, rangeStats, timeToLogical, translate, validate,
} from '../src/drawings/model';

const DAY = 86400;
const times = [0, 1, 2, 3, 4].map(i => 1_700_000_000 + i * DAY);

describe('time <-> logical mapping', () => {
  it('is exact on bars and interpolates between them', () => {
    times.forEach((t, i) => expect(timeToLogical(times, t)).toBe(i));
    expect(timeToLogical(times, times[1] + DAY / 2)).toBeCloseTo(1.5);
  });
  it('extrapolates into the future and the past by the bar interval', () => {
    expect(timeToLogical(times, times[4] + 3 * DAY)).toBeCloseTo(7);
    expect(timeToLogical(times, times[0] - 2 * DAY)).toBeCloseTo(-2);
    expect(logicalToTime(times, 7)).toBe(times[4] + 3 * DAY);
  });
  it('round-trips', () => {
    for (const l of [-3, 0.25, 2, 3.5, 9]) expect(timeToLogical(times, logicalToTime(times, l))).toBeCloseTo(l, 6);
  });
});

describe('geometry', () => {
  it('distance to segment clamps at the ends', () => {
    expect(distToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });
  it('rays extend forward only, extended lines both ways', () => {
    const a = { x: 0, y: 0 }, b = { x: 10, y: 0 };
    expect(distToLine({ x: 100, y: 3 }, a, b, true)).toBe(3);
    expect(distToLine({ x: -100, y: 3 }, a, b, true)).toBeCloseTo(Math.hypot(100, 3));
    expect(distToLine({ x: -100, y: 3 }, a, b, false)).toBe(3);
  });
});

describe('hit testing', () => {
  const t = create('trend', [{ time: 0, price: 0 }, { time: 1, price: 1 }]);
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
  it('grabs anchors before the body', () => {
    expect(hitTest(t, pts, { x: 101, y: 99 }, 500)).toEqual({ id: t.id, part: 1 });
    expect(hitTest(t, pts, { x: 50, y: 53 }, 500)).toEqual({ id: t.id, part: 'body' });
    expect(hitTest(t, pts, { x: 50, y: 70 }, 500)).toBeNull();
  });
  it('horizontal line spans the pane', () => {
    const h = create('hline', [{ time: 0, price: 1 }]);
    expect(hitTest(h, [{ x: 10, y: 40 }], { x: 480, y: 44 }, 500)?.part).toBe('body');
    expect(hitTest(h, [{ x: 10, y: 40 }], { x: 480, y: 60 }, 500)).toBeNull();
  });
  it('rectangle hit inside and on the border', () => {
    const r = create('rect', [{ time: 0, price: 0 }, { time: 1, price: 1 }]);
    const rp = [{ x: 10, y: 10 }, { x: 60, y: 40 }];
    expect(hitTest(r, rp, { x: 30, y: 20 }, 500)?.part).toBe('body');
    expect(hitTest(r, rp, { x: 64, y: 20 }, 500)?.part).toBe('body');
    expect(hitTest(r, rp, { x: 90, y: 20 }, 500)).toBeNull();
  });
});

describe('fib retracement', () => {
  it('level 0 at the second anchor, 1 at the first, 0.618 in between', () => {
    const f = create('fib', [{ time: 0, price: 100 }, { time: 1, price: 200 }]);
    const lv = Object.fromEntries(fibPrices(f).map(x => [x.level, x.price]));
    expect(lv[0]).toBe(200);
    expect(lv[1]).toBe(100);
    expect(lv[0.618]).toBeCloseTo(138.2);
    expect(lv[1.618]).toBeCloseTo(38.2);
    expect(FIB_LEVELS).toContain(0.786);
    expect(FIB_ALL_LEVELS).toHaveLength(24);
  });
});

describe('editing', () => {
  it('translate moves every anchor by the same logical/price delta', () => {
    const d = create('trend', [{ time: times[1], price: 10 }, { time: times[3], price: 12 }]);
    const m = translate(d, times, 1, 0.5);
    expect(m.points).toEqual([{ time: times[2], price: 10.5 }, { time: times[4], price: 12.5 }]);
    expect(d.points[0].price).toBe(10);   // original untouched
  });
  it('magnet snaps to the closest OHLC value within range', () => {
    const bar = { open: 10, high: 12, low: 9, close: 11 };
    const y = (p: number) => 100 - p * 10;
    expect(magnetSnap(11.8, bar, y, 100 - 11.8 * 10)).toBe(12);
    expect(magnetSnap(20, bar, y, 100 - 20 * 10)).toBe(20);   // too far: unchanged
  });
  it('validate rejects malformed drawings', () => {
    expect(validate(create('hline', [{ time: 1, price: 2 }]))).toBe(true);
    expect(validate({ id: 'x', type: 'trend', points: [{ time: 1, price: 2 }] })).toBe(false);
    expect(validate({ id: 'x', type: 'nope', points: [] })).toBe(false);
    expect(Object.keys(ANCHORS)).toHaveLength(17);   // 9 original tools + crossline, positions, ranges, circle, price label
  });
});

describe('new tools', () => {
  it('one-click long/short positions place target and stop around the entry', () => {
    const e = { time: times[2], price: 100 };
    const long = create('long', [e], undefined, { priceSpan: 50, barSeconds: DAY });
    expect(long.points).toHaveLength(3);
    expect(long.points[1].price).toBeCloseTo(104);          // target = entry + 8% of the visible span
    expect(long.points[2].price).toBeCloseTo(98);           // stop = half the target distance below
    expect(long.points[1].time).toBe(times[2] + 20 * DAY);
    const short = create('short', [e], undefined, { priceSpan: 50 });
    expect(short.points[1].price).toBeLessThan(100);
    expect(short.points[2].price).toBeGreaterThan(100);
    const st = positionStats(long);
    expect(st.targetPct).toBeCloseTo(4);
    expect(st.stopPct).toBeCloseTo(-2);
    expect(st.rr).toBeCloseTo(2);
    expect(validate(long)).toBe(true);
  });
  it('dragging a position anchor keeps target and stop on one right edge', () => {
    const d = create('long', [{ time: times[0], price: 100 }], undefined, { priceSpan: 50, barSeconds: DAY });
    const t = moveAnchor(d, 1, { time: times[4], price: 110 });
    expect(t.points[1]).toEqual({ time: times[4], price: 110 });
    expect(t.points[2]).toEqual({ time: times[4], price: d.points[2].price });
    const s = moveAnchor(d, 0, { time: times[1], price: 101 });
    expect(s.points[0]).toEqual({ time: times[1], price: 101 });
    expect(s.points.slice(1)).toEqual(d.points.slice(1));
    const tr = moveAnchor(create('trend', [{ time: 0, price: 0 }, { time: 1, price: 1 }]), 1, { time: 5, price: 5 });
    expect(tr.points[1]).toEqual({ time: 5, price: 5 });
  });
  it('range stats and span formatting', () => {
    const r = rangeStats({ time: 0, price: 50 }, { time: 3 * DAY + 2 * 3600, price: 55 }, 3);
    expect(r.change).toBe(5);
    expect(r.pct).toBeCloseTo(10);
    expect(formatSpan(r.seconds)).toBe('3d 2h');
    expect(formatSpan(90 * 60)).toBe('1h 30m');
  });
  it('hit tests for crossline, circle and position', () => {
    const cl = create('crossline', [{ time: 0, price: 0 }]);
    expect(hitTest(cl, [{ x: 50, y: 50 }], { x: 300, y: 52 }, 400)?.part).toBe('body');
    expect(hitTest(cl, [{ x: 50, y: 50 }], { x: 52, y: 300 }, 400)?.part).toBe('body');
    expect(hitTest(cl, [{ x: 50, y: 50 }], { x: 200, y: 200 }, 400)).toBeNull();
    const c = create('circle', [{ time: 0, price: 0 }, { time: 1, price: 1 }]);
    expect(hitTest(c, [{ x: 100, y: 100 }, { x: 130, y: 100 }], { x: 110, y: 110 }, 400)?.part).toBe('body');
    expect(hitTest(c, [{ x: 100, y: 100 }, { x: 130, y: 100 }], { x: 160, y: 100 }, 400)).toBeNull();
    const p = create('long', [{ time: 0, price: 10 }], undefined, { priceSpan: 10 });
    const pts = [{ x: 0, y: 100 }, { x: 80, y: 60 }, { x: 80, y: 120 }];
    expect(hitTest(p, pts, { x: 40, y: 80 }, 400)?.part).toBe('body');    // inside the target box
    expect(hitTest(p, pts, { x: 40, y: 110 }, 400)?.part).toBe('body');   // inside the stop box
    expect(hitTest(p, pts, { x: 200, y: 80 }, 400)).toBeNull();
  });
});
