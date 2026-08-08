import { describe, it, expect } from 'vitest';
import { trustScore, initialTrustScore, canAuthorHighRiskClaim, clamp, MAX_TRUST_TIER } from '../trust.js';

describe('trust score — weighted formula', () => {
  it('computes the weighted sum with the plan weights', () => {
    const s = trustScore({
      humanSignal: 100,
      corroboration: 1,
      correctionRateInv: 1,
      reliability: 1,
    });
    // 0.45*100 + 0.25*100 + 0.15*100 + 0.15*100 = 100
    expect(s).toBeCloseTo(100, 6);
  });

  it('clamps to 0..100', () => {
    expect(trustScore({ humanSignal: 500, corroboration: 2, correctionRateInv: 3, reliability: 4 })).toBe(100);
    expect(trustScore({ humanSignal: -500, corroboration: -2, correctionRateInv: -3, reliability: -4 })).toBe(0);
  });

  it('a mediocre source lands mid-range', () => {
    const s = trustScore({ humanSignal: 50, corroboration: 0.5, correctionRateInv: 0.5, reliability: 0.8 });
    expect(s).toBeGreaterThan(40);
    expect(s).toBeLessThan(60);
  });
});

describe('trust tier is a hard ceiling', () => {
  it('initializes from tier', () => {
    expect(initialTrustScore(0)).toBe(10);
    expect(initialTrustScore(1)).toBe(30);
    expect(initialTrustScore(2)).toBe(50);
    expect(initialTrustScore(3)).toBe(70);
    expect(initialTrustScore(4)).toBe(90);
    expect(initialTrustScore(9)).toBe(100);
  });

  it('tier < 2 can never author high-risk claims even with a maxed learned score', () => {
    expect(canAuthorHighRiskClaim(0, 100)).toBe(false);
    expect(canAuthorHighRiskClaim(1, 100)).toBe(false);
    expect(canAuthorHighRiskClaim(2, 0)).toBe(true);
    expect(canAuthorHighRiskClaim(4, 50)).toBe(true);
  });

  it('clamp works', () => {
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(42, 0, 100)).toBe(42);
  });

  it('MAX_TRUST_TIER is 4', () => {
    expect(MAX_TRUST_TIER).toBe(4);
  });
});
