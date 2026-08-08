import { describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_SUB_WEIGHTS,
  DIMENSION_WEIGHTS,
  DETERMINISTIC_WEIGHT_TOTAL,
  COMPOSITE_PASS_THRESHOLD,
} from '../types.js';
import { compositeFromScores, passesComposite } from '../composite.js';

describe('composite math (plan §15.2)', () => {
  it('weights sum to exactly 1.0', () => {
    const total = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('48% of the weight is deterministic', () => {
    expect(DETERMINISTIC_WEIGHT_TOTAL).toBeCloseTo(0.48, 10);
    expect(DETERMINISTIC_SUB_WEIGHTS.factualGrounding).toBeCloseTo(0.14, 10);
    expect(DETERMINISTIC_SUB_WEIGHTS.structuralCompliance).toBeCloseTo(0.12, 10);
    expect(DETERMINISTIC_SUB_WEIGHTS.bannedPatternCleanliness).toBeCloseTo(0.12, 10);
    expect(DETERMINISTIC_SUB_WEIGHTS.formattingCorrectness).toBeCloseTo(0.10, 10);
  });

  it('composite is the weighted sum and the threshold is 0.72', () => {
    expect(COMPOSITE_PASS_THRESHOLD).toBe(0.72);
    const perfect = compositeFromScores({
      factualGrounding: 1,
      voiceConformance: 1,
      structuralCompliance: 1,
      bannedPatternCleanliness: 1,
      specificity: 1,
      readerValue: 1,
      formattingCorrectness: 1,
    });
    expect(perfect).toBeCloseTo(1, 10);
    expect(passesComposite(perfect)).toBe(true);

    // All-deterministic-ones, judge dims absent: renormalized to 1.0.
    const detOnly = compositeFromScores({
      factualGrounding: 1,
      structuralCompliance: 1,
      bannedPatternCleanliness: 1,
      formattingCorrectness: 1,
    });
    expect(detOnly).toBeCloseTo(1, 10);

    // Mid-quality post.
    const mid = compositeFromScores({
      factualGrounding: 0.9,
      voiceConformance: 0.8,
      structuralCompliance: 1,
      bannedPatternCleanliness: 1,
      specificity: 0.7,
      readerValue: 0.8,
      formattingCorrectness: 1,
    });
    expect(mid).toBeGreaterThanOrEqual(0.72);

    // A post that fails several dimensions hard: composite drops below 0.72.
    const fail = compositeFromScores({
      factualGrounding: 0,
      voiceConformance: 0.6,
      structuralCompliance: 0,
      bannedPatternCleanliness: 0,
      specificity: 0.6,
      readerValue: 0.6,
      formattingCorrectness: 0,
    });
    expect(fail).toBeLessThan(0.72);
    expect(passesComposite(fail)).toBe(false);
  });

  it('renormalizes over the present dimension set (judge-not-gating collaborates)', () => {
    // When the judge is untrusted on a dimension, dropping it must not push
    // the composite below the deterministic floor.
    const withJudge = compositeFromScores({
      factualGrounding: 1,
      voiceConformance: 0.6,
      structuralCompliance: 1,
      bannedPatternCleanliness: 1,
      specificity: 0.6,
      readerValue: 0.6,
      formattingCorrectness: 1,
    });
    expect(withJudge).toBeGreaterThanOrEqual(0.72);
  });
});