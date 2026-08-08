import { describe, expect, it } from 'vitest';
import { detectAnomalies, zScore } from '../anomaly.js';

/** 5-minute slot, count N. */
function sample(count: number, windowMs = 300_000): { count: number; windowMs: number } {
  return { count, windowMs };
}

describe('anomaly detector', () => {
  it('halts when posting rate z-score exceeds |3|', () => {
    // Baseline: 100 samples of ~2 posts per slot (mean 2, std small).
    const baseline = Array.from({ length: 100 }, () => sample(2));
    // Current: 14 posts in a slot → huge z.
    const r = detectAnomalies({
      currentCount: 14,
      baselineSamples: baseline,
      rateLimited15m: 0,
      success15m: 10,
      subscribersNow: 1000,
      subscribersHourAgo: 1000,
      failures15m: 0,
      publishes15m: 10,
    });
    expect(r.halted).toBe(true);
    expect(r.findings.some((f) => f.metric === 'posting_rate')).toBe(true);
    expect(Math.abs(r.metrics.zScore)).toBeGreaterThan(3);
  });

  it('does not halt on subthreshold posting rate', () => {
    const baseline = Array.from({ length: 100 }, () => sample(2));
    const r = detectAnomalies({
      currentCount: 2,
      baselineSamples: baseline,
      rateLimited15m: 0,
      success15m: 10,
      subscribersNow: 1000,
      subscribersHourAgo: 1000,
      failures15m: 0,
      publishes15m: 10,
    });
    expect(r.halted).toBe(false);
    expect(Math.abs(r.metrics.zScore)).toBeLessThan(3);
  });

  it('halts when 429 rate exceeds 5% over 15 minutes', () => {
    const r = detectAnomalies({
      currentCount: 2,
      baselineSamples: [sample(2)],
      rateLimited15m: 1,
      success15m: 1, // 50% 429
      subscribersNow: 1000,
      subscribersHourAgo: 1000,
      failures15m: 0,
      publishes15m: 2,
    });
    expect(r.halted).toBe(true);
    expect(r.findings.some((f) => f.metric === 'rate_429')).toBe(true);
  });

  it('does not halt on a low 429 rate', () => {
    const r = detectAnomalies({
      currentCount: 2,
      baselineSamples: [sample(2)],
      rateLimited15m: 1,
      success15m: 99,
      subscribersNow: 1000,
      subscribersHourAgo: 1000,
      failures15m: 0,
      publishes15m: 100,
    });
    expect(r.findings.some((f) => f.metric === 'rate_429')).toBe(false);
  });

  it('halts when subscriber drop exceeds 2% in an hour', () => {
    const r = detectAnomalies({
      currentCount: 2,
      baselineSamples: [sample(2)],
      rateLimited15m: 0,
      success15m: 10,
      subscribersNow: 950,
      subscribersHourAgo: 1000, // -5%
      failures15m: 0,
      publishes15m: 10,
    });
    expect(r.halted).toBe(true);
    expect(r.findings.some((f) => f.metric === 'subscriber_drop')).toBe(true);
  });

  it('does not halt on a mild subscriber dip', () => {
    const r = detectAnomalies({
      currentCount: 2,
      baselineSamples: [sample(2)],
      rateLimited15m: 0,
      success15m: 10,
      subscribersNow: 999,
      subscribersHourAgo: 1000, // -0.1%
      failures15m: 0,
      publishes15m: 10,
    });
    expect(r.halted).toBe(false);
  });

  it('halts on a high publish failure rate', () => {
    const r = detectAnomalies({
      currentCount: 2,
      baselineSamples: [sample(2)],
      rateLimited15m: 0,
      success15m: 1,
      subscribersNow: 1000,
      subscribersHourAgo: 1000,
      failures15m: 4,
      publishes15m: 5, // 80% failure
    });
    expect(r.halted).toBe(true);
    expect(r.findings.some((f) => f.metric === 'publish_failure')).toBe(true);
  });

  it('is deliberately trigger-happy: a borderline 429 halts', () => {
    // 1 429 in 18 success = 5.26% > 5% → halt.
    const r = detectAnomalies({
      currentCount: 2,
      baselineSamples: [sample(2)],
      rateLimited15m: 1,
      success15m: 18,
      subscribersNow: 1000,
      subscribersHourAgo: 1000,
      failures15m: 0,
      publishes15m: 19,
    });
    expect(r.halted).toBe(true);
  });

  it('zScore returns 0 when baseline std is 0', () => {
    expect(zScore(5, 2, 0)).toBe(0);
  });

  it('returns a full metrics report', () => {
    const r = detectAnomalies({
      currentCount: 2,
      baselineSamples: [sample(2)],
      rateLimited15m: 0,
      success15m: 10,
      subscribersNow: 1000,
      subscribersHourAgo: 1000,
      failures15m: 0,
      publishes15m: 10,
    });
    expect(r.metrics.zScore).toBe(0);
    expect(r.metrics.rate429Ratio).toBe(0);
    expect(r.metrics.subscriberDeltaPct).toBe(0);
    expect(r.metrics.failureRate).toBe(0);
  });
});
