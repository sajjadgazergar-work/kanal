import { describe, expect, it } from 'vitest';
import { runRegression, regressionItems, REGRESSION_BASELINE } from '../regression.js';

describe('regression runner (plan §15.2)', () => {
  it('executes all 12 fixed golden items', () => {
    const items = regressionItems();
    expect(items.length).toBe(12);
    expect(items.filter((i) => i.locale === 'en').length).toBe(6);
    expect(items.filter((i) => i.locale === 'fa').length).toBe(6);
  });

  it('reports a composite distribution and a pass/fail vs the baseline', async () => {
    const r = await runRegression();
    expect(r.distribution.n).toBe(12);
    expect(r.distribution.mean).toBeGreaterThan(0);
    expect(r.distribution.mean).toBeLessThanOrEqual(1);
    expect(r.distribution.min).toBeLessThanOrEqual(r.distribution.max);
    expect(r.pass).toBe(true);
    expect(r.drop).toBeLessThan(0.05);
  });

  it('fails when the mean drops ≥ 0.05 against the committed baseline', async () => {
    const r = await runRegression();
    // A baseline far above the measured mean forces a failure.
    const forced = await runRegression({ baseline: r.distribution.mean + 0.06 });
    expect(forced.drop).toBeGreaterThanOrEqual(0.05);
    expect(forced.pass).toBe(false);
  });

  it('baseline is the committed 0.85', () => {
    expect(REGRESSION_BASELINE).toBe(0.85);
  });
});