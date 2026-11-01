// TS indicator ports == Python reference (server/tvre/indicators.py) on a shared fixture.
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/indicators.json';
import { INDICATORS, columns, computeIndicator, type Bar } from '../src/indicators';

const bars = fixture.bars as Bar[];
const cols = columns(bars);

describe('indicator parity with the Python reference', () => {
  for (const c of fixture.cases) {
    it(`${c.id} ${JSON.stringify(c.inputs)}`, () => {
      const out = computeIndicator(c.id, cols, c.inputs as Record<string, number>);
      for (const [key, ref] of Object.entries(c.values as unknown as Record<string, (number | null)[]>)) {
        expect(out[key], `${c.id}.${key} missing`).toBeDefined();
        ref.forEach((r, i) => {
          const v = out[key][i];
          if (r === null) expect(Number.isFinite(v), `${c.id}.${key}[${i}] should be NaN`).toBe(false);
          else expect(Math.abs(v - r) / Math.max(1, Math.abs(r)), `${c.id}.${key}[${i}] ${v} vs ${r}`).toBeLessThan(1e-9);
        });
      }
    });
  }

  it('covers every registered indicator', () => {
    expect(fixture.cases.map(c => c.id).sort()).toEqual(Object.keys(INDICATORS).sort());
  });
});
