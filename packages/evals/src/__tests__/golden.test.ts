import { describe, expect, it } from 'vitest';
import { loadGoldenSet, listGoldenSets } from '../golden.js';

describe('golden sets (plan §15.2)', () => {
  it('has exactly two locales, each with 6 items', () => {
    const sets = listGoldenSets();
    expect(sets.map((s) => s.locale).sort()).toEqual(['en', 'fa']);
    for (const s of sets) expect(s.count).toBe(6);
  });

  it('each set has 3 good and 3 flawed with labelled flaw types', () => {
    for (const locale of ['en', 'fa']) {
      const set = loadGoldenSet(locale);
      const good = set.items.filter((i) => i.label === 'good');
      const flawed = set.items.filter((i) => i.label === 'flawed');
      expect(good.length).toBe(3);
      expect(flawed.length).toBe(3);
      for (const f of flawed) {
        expect(f.flawTypes).toBeDefined();
        expect(f.flawTypes!.length).toBeGreaterThan(0);
      }
      // every flawed item labels at least one deterministic flaw type that the
      // deterministic scorers can detect
      const known = ['banned_pattern', 'structural', 'formatting', 'factual_grounding', 'quote_budget'];
      for (const f of flawed) {
        for (const t of f.flawTypes!) expect(known).toContain(t);
      }
    }
  });

  it('good posts carry a full coverage map', () => {
    const set = loadGoldenSet('en');
    for (const item of set.items.filter((i) => i.label === 'good')) {
      expect(item.coverage).toBeDefined();
    }
  });
});