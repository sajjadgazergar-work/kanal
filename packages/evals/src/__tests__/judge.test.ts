import { describe, expect, it } from 'vitest';
import { cohensKappa, calibrateJudge, KAPPA_TRUST_THRESHOLD, judgeContribution } from '../judge.js';
import type { JudgeOutput } from '../types.js';

describe("Cohen's kappa (plan §15.2)", () => {
  it('perfect agreement gives κ = 1', () => {
    expect(cohensKappa([true, false, true], [true, false, true])).toBe(1);
  });

  it('chance-level agreement gives κ ≈ 0', () => {
    // Rater B always guesses "flawed" while the truth is mixed 50/50.
    const k = cohensKappa([true, false, true, false], [true, true, true, true]);
    expect(k).toBeLessThan(0.4);
  });

  it('κ > 0.4 on a known label set', () => {
    const human = [true, false, true, true, false];
    const judge = [true, false, true, false, false];
    const k = cohensKappa(human, judge);
    expect(k).toBeGreaterThan(KAPPA_TRUST_THRESHOLD);
  });

  it('throws on mismatched lengths', () => {
    expect(() => cohensKappa([true], [true, false])).toThrow();
  });

  it('empty sets are treated as perfect agreement', () => {
    expect(cohensKappa([], [])).toBe(1);
  });

  it('calibration marks a dimension untrusted below 0.4', () => {
    const samples = {
      factualGrounding: { human: [true, false, true, false], judge: [true, true, true, true] },
      structuralCompliance: { human: [true, false, true], judge: [true, false, true] },
      voiceConformance: { human: [true, false, true], judge: [true, false, true] },
      bannedPatternCleanliness: { human: [true, false, true], judge: [true, false, true] },
      specificity: { human: [true, false, true], judge: [true, false, true] },
      readerValue: { human: [true, false, true], judge: [true, false, true] },
      formattingCorrectness: { human: [true, false, true], judge: [true, false, true] },
    };
    const c = calibrateJudge(samples);
    expect(c.trusted.factualGrounding).toBe(false);
    expect(c.trusted.structuralCompliance).toBe(true);
  });

  it('judgeContribution drops untrusted dimensions', () => {
    const output: JudgeOutput = {
      scores: {
        factualGrounding: 0.2,
        voiceConformance: 0.9,
        specificity: 0.8,
        readerValue: 0.8,
        structuralCompliance: 1,
        bannedPatternCleanliness: 1,
        formattingCorrectness: 1,
      },
      issues: [],
    };
    const contributed = judgeContribution(output, {
      trusted: {
        factualGrounding: false,
        voiceConformance: true,
        specificity: true,
        readerValue: true,
        structuralCompliance: true,
        bannedPatternCleanliness: true,
        formattingCorrectness: true,
      },
    });
    expect(contributed.factualGrounding).toBeUndefined();
    expect(contributed.voiceConformance).toBe(0.9);
  });
});