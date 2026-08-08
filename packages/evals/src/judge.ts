import type { Critique } from '@kanal/contracts';
import type { DimensionId, EvalInput, GateMode, JudgeOutput, JudgeTrust } from './types.js';

/**
 * The Judge interface (plan §15.2). A judge is injectable — the pipeline never
 * constructs a real model call; tests always inject a stub. A judge scores the
 * seven dimensions and reports issues. Judge output contributes to the
 * composite but a judge score alone can never block a post (per-item judge
 * never gates; only aggregates over 30 posts drive the trend series).
 */
export interface Judge {
  readonly id: string;
  readonly model?: string;
  /** Score a post. Never throws; returns best-effort scores. */
  evaluate(input: EvalInput): Promise<JudgeOutput>;
}

/** A judge that can produce a Critique-shape verdict for the pipeline (stage 6). */
export interface CritiqueJudge extends Judge {
  critique(input: EvalInput): Promise<Critique>;
}

export interface GatePolicy {
  gateMode: GateMode;
}

export const DEFAULT_GATE_POLICY: GatePolicy = { gateMode: 'aggregate' };

/**
 * The gate decision for a single post. Under `aggregate` a judge score never
 * blocks; the deterministic dimensions can still hard-fail a post, and the
 * composite ≥ 0.72 gate applies to the deterministic floor plus trusted judge
 * dimensions.
 */
export interface GateVerdict {
  verdict: 'pass' | 'revise' | 'block';
  reasons: string[];
}

export const COMPOSITE_THRESHOLD = 0.72;

/**
 * The per-item gate (plan §15.2, D8). Two invariants:
 *
 * 1. A deterministic hard failure always blocks — that is the machine-checkable
 *    half, and no judge can argue it away.
 * 2. A judge score alone can never block a post. Under `aggregate` (the
 *    default, `eval.gate_mode`), the gate is driven only by the deterministic
 *    floor, so judge noise cannot flip an individual post. Under `per_item`
 *    the judge-inclusive composite is allowed to force `revise`, but `block`
 *    still requires a deterministic hard failure.
 */
export function evaluateGate(
  deterministicComposite: number,
  deterministicHardFailures: string[],
  policy: GatePolicy,
  judgeInclusiveComposite?: number,
): GateVerdict {
  const reasons: string[] = [];

  if (deterministicHardFailures.length > 0) {
    reasons.push(...deterministicHardFailures);
    return { verdict: 'block', reasons };
  }

  if (policy.gateMode === 'per_item' && judgeInclusiveComposite !== undefined) {
    if (judgeInclusiveComposite < COMPOSITE_THRESHOLD) {
      reasons.push(`composite ${judgeInclusiveComposite.toFixed(3)} below 0.72`);
      return { verdict: 'revise', reasons };
    }
    return { verdict: 'pass', reasons };
  }

  // Aggregate mode: the deterministic 48% floor gates the post.
  if (deterministicComposite < COMPOSITE_THRESHOLD) {
    reasons.push(`deterministic composite ${deterministicComposite.toFixed(3)} below 0.72`);
    return { verdict: 'revise', reasons };
  }

  return { verdict: 'pass', reasons };
}

/**
 * Cohen's kappa for binary ratings (agree/disagree per item) between two
 * raters. Used to calibrate a judge dimension against human labels (§15.2).
 *  - po: observed agreement
 *  - pe: expected agreement by chance (marginal products)
 */
export function cohensKappa(
  human: readonly boolean[],
  judge: readonly boolean[],
): number {
  if (human.length !== judge.length) {
    throw new Error(`label sets differ in length: ${human.length} vs ${judge.length}`);
  }
  const n = human.length;
  if (n === 0) return 1;

  let h1 = 0;
  let j1 = 0;
  let agree = 0;
  for (let i = 0; i < n; i++) {
    const h = human[i] ? 1 : 0;
    const j = judge[i] ? 1 : 0;
    if (h === 1) h1++;
    if (j === 1) j1++;
    if (h === j) agree++;
  }

  const po = agree / n;
  const pH = h1 / n;
  const pJ = j1 / n;
  const pe = pH * pJ + (1 - pH) * (1 - pJ);
  if (pe === 1) return 1;
  return (po - pe) / (1 - pe);
}

export const KAPPA_TRUST_THRESHOLD = 0.4;
export const KAPPA_PER_ITEM_PROMOTE_THRESHOLD = 0.7;

export interface CalibrationSample {
  /** The golden post label: true when the post is flawed on this dimension. */
  human: boolean;
  judge: boolean;
}

/**
 * Calibrate a judge's binary reliability per dimension. Returns the trust map
 * (κ ≥ 0.4 ⇒ trusted) and the κ per dimension. A judge is not used on a
 * dimension where κ < 0.4.
 */
export function calibrateJudge(
  samples: Record<DimensionId, { human: boolean[]; judge: boolean[] }>,
): { trusted: Record<DimensionId, boolean>; kappa: Record<DimensionId, number> } {
  const trusted = {} as Record<DimensionId, boolean>;
  const kappa = {} as Record<DimensionId, number>;
  for (const dim of Object.keys(samples) as DimensionId[]) {
    const s = samples[dim];
    const k = cohensKappa(s.human, s.judge);
    kappa[dim] = k;
    trusted[dim] = k >= KAPPA_TRUST_THRESHOLD;
  }
  return { trusted, kappa };
}

/**
 * Fold the judge output into the composite. Untrusted dimensions are dropped
 * (the composite renormalizes over the trusted set, which includes the
 * deterministic dimensions).
 */
export function judgeContribution(
  judge: JudgeOutput,
  trust: Pick<JudgeTrust, 'trusted'>,
): Partial<Record<DimensionId, number>> {
  const out: Partial<Record<DimensionId, number>> = {};
  for (const dim of Object.keys(judge.scores) as DimensionId[]) {
    if (trust.trusted[dim]) out[dim] = judge.scores[dim];
  }
  return out;
}
