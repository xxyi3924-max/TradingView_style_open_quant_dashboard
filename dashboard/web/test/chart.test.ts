import { describe, expect, it } from 'vitest';
import { alignToBars, heikinAshi, parseInterval, QF_BASE, quantifiLabel, quantifiTick, tickInterval, stopLabel, stopIndex } from '../src/chart/util';

describe('typed intervals (TradingView rules)', () => {
  it('maps digits and suffixes', () => {
    expect(parseInterval('5')).toBe('5');
    expect(parseInterval('2h')).toBe('120');
    expect(parseInterval('1H')).toBe('60');
    expect(parseInterval('1D')).toBe('D');
    expect(parseInterval('d')).toBe('D');
    expect(parseInterval('1W')).toBe('W');
    expect(parseInterval('1M')).toBe('M');
  });
  it('rejects junk', () => {
    expect(parseInterval('')).toBeNull();
    expect(parseInterval('abc')).toBeNull();
    expect(parseInterval('0')).toBeNull();
  });
});

describe('Heikin Ashi', () => {
  const bars = [
    { time: 1, open: 10, high: 12, low: 9, close: 11, volume: 1 },
    { time: 2, open: 11, high: 13, low: 10, close: 12, volume: 2 },
    { time: 3, open: 12, high: 12.5, low: 8, close: 9, volume: 3 },
  ];
  const ha = heikinAshi(bars);
  it('close is the OHLC average and open the previous HA body midpoint', () => {
    expect(ha[0].close).toBeCloseTo((10 + 12 + 9 + 11) / 4);
    expect(ha[0].open).toBeCloseTo((10 + 11) / 2);
    expect(ha[1].open).toBeCloseTo((ha[0].open + ha[0].close) / 2);
    expect(ha[2].close).toBeCloseTo((12 + 12.5 + 8 + 9) / 4);
  });
  it('high/low envelope the body and keep time and volume', () => {
    for (const [i, b] of ha.entries()) {
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close, bars[i].high) - 1e-12);
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close, bars[i].low) + 1e-12);
      expect([b.time, b.volume]).toEqual([bars[i].time, bars[i].volume]);
    }
  });
});

describe('QuantiFi time axis', () => {
  it('maps the server times (a date per training day, a second per tick) back to day and timestamp', () => {
    expect(quantifiLabel(QF_BASE)).toBe('Day −2');
    expect(quantifiLabel(QF_BASE + 86400 + 4123)).toBe('Day −1 · 412,300');
    expect(quantifiLabel(QF_BASE + 2 * 86400 + 9999)).toBe('Day 0 · 999,900');
  });
  it('labels axis ticks with the day at day boundaries and thousands of timestamp otherwise', () => {
    expect(quantifiTick(QF_BASE + 86400, true)).toBe('Day −1');
    expect(quantifiTick(QF_BASE + 86400 + 2500, false)).toBe('250k');
  });
});

describe('run series on the chart\'s bars', () => {
  it('takes for each bar the last sample before the next bar starts (the value at its close)', () => {
    expect(alignToBars([0, 60, 120], [0, 10, 50, 60, 130])).toEqual([2, 3, 4]);
  });
  it('carries a sample across bars shorter than the sampling step', () => {
    expect(alignToBars([0, 5, 10, 15], [0, 10])).toEqual([0, 0, 1, 1]);
  });
  it('leaves bars before the first sample empty', () => {
    expect(alignToBars([0, 60], [70])).toEqual([-1, 0]);
  });
});

describe('tick intervals (QuantiFi: one tick per second)', () => {
  it('reads nS as n ticks and leaves other intervals alone', () => {
    expect(tickInterval('1S')).toBe(1);
    expect(tickInterval('30S')).toBe(30);
    expect(tickInterval('5')).toBeNull();
    expect(tickInterval('D')).toBeNull();
  });
});

describe('stress slider stops', () => {
  it('labels half-lives in ticks with k for thousands and ∞ for no decay', () => {
    expect([0, 1, 10, 100, 1000, null].map(stopLabel)).toEqual(['0', '1', '10', '100', '1k', '∞']);
  });
  it('finds a remembered value among the stops, falling back to the first', () => {
    expect(stopIndex([0, 1, 10, null], null)).toBe(3);
    expect(stopIndex([1, 0.75, 0.5], 0.5)).toBe(2);
    expect(stopIndex([1, 0.75, 0.5], 0.3)).toBe(0);
    expect(stopIndex([1, 0.75, 0.5], undefined)).toBe(0);
  });
});
