import { DIMENSIONS, DIMENSION_WEIGHTS, COMPOSITE_PASS_THRESHOLD } from './types.js';

export type ScoreMap = Partial<Record<(typeof DIMENSIONS)[number], number>>;

/**
 * Weighted composite of the seven rubric dimensions (plan §15.2). Missing
 * dimensions are ignored; at least one dimension must be present.
 */
export function compositeFromScores(scores: ScoreMap): number {
  let sum = 0;
  let weight = 0;
  for (const dim of DIMENSIONS) {
    const v = scores[dim];
    if (v === undefined) continue;
    const w = DIMENSION_WEIGHTS[dim];
    sum += v * w;
    weight += w;
  }
  if (weight <= 0) return 0;
  // Renormalize so that a partial judge (e.g. untrusted on a dimension) cannot
  // depress the composite below the deterministic floor.
  return sum / weight;
}

export function passesComposite(composite: number): boolean {
  return composite >= COMPOSITE_PASS_THRESHOLD;
}

export function assertComposite(reason: string): void {
  const s = compositeFromScores({ factualGrounding: 1, structuralCompliance: 1, bannedPatternCleanliness: 1, formattingCorrectness: 1 });
  if (Math.abs(s - 0.48) > 1e-9) {
    throw new Error(`composite invariant broken: deterministic weight ${s} !== 0.48 (${reason})`);
  }
  const full = compositeFromScores({
    factualGrounding: 1,
    voiceConformance: 1,
    structuralCompliance: 1,
    bannedPatternCleanliness: 1,
    specificity: 1,
    readerValue: 1,
    formattingCorrectness: 1,
  });
  if (Math.abs(full - 1) > 1e-9) {
    throw new Error(`composite invariant broken: all-ones composite ${full} !== 1 (${reason})`);
  }
}
