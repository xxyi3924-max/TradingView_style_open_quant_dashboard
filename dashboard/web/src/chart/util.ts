// Pure chart helpers (no DOM, unit-tested in test/chart.test.ts).
import type { Bar } from '../indicators';

/** "5" -> 5 minutes, "2h" -> 120, "1D"/"D" -> D, "1W" -> W, "1M" -> M (TradingView typed-interval rules). */
export function parseInterval(raw: string): string | null {
  const m = raw.trim().toUpperCase().match(/^(\d*)([HDWM]?)$/);
  if (!m || (!m[1] && !m[2])) return null;
  const n = Number(m[1] || 1);
  if (m[2] === 'H') return String(n * 60);
  if (m[2] === 'D' || m[2] === 'W' || m[2] === 'M') return m[2];
  return n > 0 ? String(n) : null;
}

/** Heikin Ashi candles: close = OHLC/4, open = midpoint of the previous HA body (first: (O+C)/2). */
export function heikinAshi(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = i === 0 ? (b.open + b.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({ time: b.time, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), volume: b.volume });
  }
  return out;
}

/** QuantiFi bars (server tvre.quantifi): training day d sits on the date 2026-01-05 + (d + 2) days and tick n
 *  (timestamp 100 n) at second n of it, so chart times map back to the hackathon's day and timestamp. */
export const QF_BASE = 1_767_571_200;
const qfSplit = (t: number) => {
  const s = t - QF_BASE, day = Math.floor(s / 86400);
  return { day: day - 2, ts: (s - day * 86400) * 100 };
};
const qfDay = (day: number) => `Day ${day < 0 ? '−' : ''}${Math.abs(day)}`;
/** Crosshair / tooltip label: "Day −1 · 412,300". */
export function quantifiLabel(t: number): string {
  const { day, ts } = qfSplit(t);
  return ts === 0 ? qfDay(day) : `${qfDay(day)} · ${ts.toLocaleString('en-US')}`;
}
/** Axis tick: the day at a day boundary, else the timestamp in thousands ("250k"). */
export function quantifiTick(t: number, dayBoundary: boolean): string {
  const { day, ts } = qfSplit(t);
  return dayBoundary ? qfDay(day) : `${Math.round(ts / 1000)}k`;
}

/** For each bar, the index of the last sample before the next bar starts (the value at the bar's close), or -1.
 *  The last bar is taken to be as long as the one before it. Both arrays ascending (unix seconds). */
export function alignToBars(barTimes: number[], sampleTimes: number[]): number[] {
  const out: number[] = [];
  let j = -1;
  for (let i = 0; i < barTimes.length; i++) {
    const end = i + 1 < barTimes.length ? barTimes[i + 1] : barTimes[i] + (i > 0 ? barTimes[i] - barTimes[i - 1] : 60);
    while (j + 1 < sampleTimes.length && sampleTimes[j + 1] < end) j++;
    out.push(j);
  }
  return out;
}

/** "5S" -> 5: seconds intervals, which on QuantiFi charts are ticks (one tick per second). null for anything else. */
export function tickInterval(tf: string): number | null {
  const m = /^(\d+)S$/.exec(tf);
  return m ? Number(m[1]) : null;
}

/** A stress half-life for a slider label: ticks, "1k" for thousands, "∞" for null (the push never decays). */
export function stopLabel(h: number | null): string {
  if (h === null) return '∞';
  return h >= 1000 && h % 1000 === 0 ? `${h / 1000}k` : String(h);
}

/** Index of a remembered value among a slider's stops; the first stop when it is not one of them. */
export function stopIndex<T>(stops: T[], v: T | undefined): number {
  const i = v === undefined ? -1 : stops.indexOf(v);
  return i < 0 ? 0 : i;
}
