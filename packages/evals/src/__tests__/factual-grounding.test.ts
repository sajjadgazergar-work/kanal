import { describe, expect, it } from 'vitest';
import type { ClaimCoverage } from '@kanal/contracts';
import { evaluateFactualGrounding, needsCitationForSentence } from '../factual-grounding.js';

function coverage(sentences: { needs: boolean; has: boolean }[]): ClaimCoverage {
  const mapped = sentences.map((s, index) => ({
    index,
    claimIds: s.has ? ['00000000-0000-0000-0000-000000000001'] : [],
    needsCitation: s.needs,
    hasCitation: s.has,
    contradiction: false,
  }));
  const needs = mapped.filter((s) => s.needsCitation).length;
  const uncited = mapped.filter((s) => s.needsCitation && !s.hasCitation).length;
  return { uncitedRatio: needs === 0 ? 0 : uncited / needs, sentences: mapped };
}

describe('factual grounding, deterministic part (plan §15.2)', () => {
  it('every numeric/entity sentence must have a claim', () => {
    const r = evaluateFactualGrounding({
      bodyMd: 'The farm adds 45 gigawatts by 2030.',
      coverage: coverage([{ needs: true, has: true }]),
    });
    expect(r.score).toBe(1);
    expect(r.sentencesWithoutClaim).toEqual([]);
  });

  it('a numeric sentence without a claim fails', () => {
    const r = evaluateFactualGrounding({
      bodyMd: 'The farm adds 45 gigawatts by 2030.',
      coverage: coverage([{ needs: true, has: false }]),
    });
    expect(r.score).toBe(0);
    expect(r.sentencesWithoutClaim.length).toBe(1);
  });

  it('uncited ratio above 0.35 fails', () => {
    const c: ClaimCoverage = {
      uncitedRatio: 0.5,
      sentences: [
        { index: 0, claimIds: [], needsCitation: true, hasCitation: false, contradiction: false },
        { index: 1, claimIds: ['x'], needsCitation: true, hasCitation: true, contradiction: false },
      ],
    };
    const r = evaluateFactualGrounding({ bodyMd: 'a. b.', coverage: c });
    expect(r.score).toBe(0);
    expect(r.hard.some((m) => m.includes('0.35'))).toBe(true);
  });

  it('detects numbers and named entities in a sentence', () => {
    expect(needsCitationForSentence('The farm adds 45 gigawatts.')).toBe(true);
    expect(needsCitationForSentence('Aurora Labs shipped the controller.')).toBe(true);
    expect(needsCitationForSentence('It is designed for grid storage.')).toBe(false);
  });
});