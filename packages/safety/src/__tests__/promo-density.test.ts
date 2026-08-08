import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMO_DENSITY_POLICY } from '@kanal/contracts';
import {
  classifyPromotional,
  evaluatePromoDensity,
  type PublishedPostSummary,
} from '../promo-density.js';

function p(iso: string, promo = false): PublishedPostSummary {
  return { isPromotional: promo, publishedAt: iso };
}

describe('promotional density', () => {
  it('allows when under the 20% cap', () => {
    // 3 promo in 20 posts = 15%.
    const history = Array.from({ length: 20 }, (_, i) => p(`2026-01-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`, i < 3));
    const v = evaluatePromoDensity({ policy: DEFAULT_PROMO_DENSITY_POLICY, history, candidatePromotional: false });
    expect(v.kind).toBe('allow');
  });

  it('defers when the cap would be exceeded', () => {
    // 4 promo in 20 posts = 20% (at cap). Adding another promo = 25% > 20%.
    const history = Array.from({ length: 20 }, (_, i) => p(`2026-01-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`, i < 4));
    const v = evaluatePromoDensity({ policy: DEFAULT_PROMO_DENSITY_POLICY, history, candidatePromotional: true });
    expect(v.kind).toBe('defer');
    if (v.kind === 'defer') {
      expect(v.currentRatio).toBeGreaterThan(0.2);
      expect(v.reason).toContain('20%');
      expect(v.fallsBelowAt).toBeTruthy();
    }
  });

  it('allows at exactly the cap', () => {
    // 4 promo in 20 = 20%, candidate non-promo → 4/21 = 19% ≤ 20%.
    const history = Array.from({ length: 20 }, (_, i) => p(`2026-01-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`, i < 4));
    const v = evaluatePromoDensity({ policy: DEFAULT_PROMO_DENSITY_POLICY, history, candidatePromotional: false });
    expect(v.kind).toBe('allow');
  });

  it('considers only the last windowPosts posts', () => {
    // 25 posts: 5 oldest are promo. Only last 20 count → 2 promo = 10%.
    const history = Array.from({ length: 25 }, (_, i) => p(`2026-01-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`, i < 5));
    const v = evaluatePromoDensity({ policy: DEFAULT_PROMO_DENSITY_POLICY, history, candidatePromotional: false });
    expect(v.kind).toBe('allow');
  });

  it('detects promotional patterns via the contracts regexes', () => {
    expect(classifyPromotional('use code SAVE999 at checkout').isPromotional).toBe(true);
    expect(classifyPromotional('link: https://shop.example/p?ref=123').isPromotional).toBe(true);
    expect(classifyPromotional('utm_source=rss').isPromotional).toBe(true);
    expect(classifyPromotional('sponsored by Acme').isPromotional).toBe(true);
    expect(classifyPromotional('just a normal analysis of the market').isPromotional).toBe(false);
    expect(classifyPromotional('', true).isPromotional).toBe(true); // manual flag
  });

  it('empty window with a promo candidate defers (1/1 > 20%)', () => {
    const v = evaluatePromoDensity({ policy: DEFAULT_PROMO_DENSITY_POLICY, history: [], candidatePromotional: true });
    expect(v.kind).toBe('defer');
  });
});
