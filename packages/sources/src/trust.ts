/**
 * Trust scoring (plan §8.6).
 *
 * `score = clamp(0,100, 0.45×human_signal + 0.25×corroboration +
 * 0.15×correction_rate_inv + 0.15×reliability)`.
 *
 * `trust_tier` (human, 0–4) is a hard ceiling on authority: a tier-1 source can
 * never be the sole basis for a risk_class ≥ 2 claim regardless of learned
 * score. Learned score only reorders within a tier.
 */

export interface TrustInput {
  humanSignal: number; // 0..100; (↑ per approved post citing it) − (↓×3 per human "bad source" flag)
  corroboration: number; // 0..1 — fraction of its items in a ≥2-witness cluster
  correctionRateInv: number; // 0..1 — 1 − (fact_checker contradictions / claims)
  reliability: number; // 0..1 — fetch success rate over 30 days
}

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

export function trustScore(input: TrustInput): number {
  const raw =
    0.45 * input.humanSignal +
    0.25 * (input.corroboration * 100) +
    0.15 * (input.correctionRateInv * 100) +
    0.15 * (input.reliability * 100);
  return clamp(raw, 0, 100);
}

/** Initial learned score from the human-set tier (plan §8.6). */
export function initialTrustScore(trustTier: number): number {
  return clamp(trustTier * 20 + 10, 0, 100);
}

export const MAX_TRUST_TIER = 4;

/**
 * Whether a source's learned score may be used as authority for a
 * `risk_class ≥ 2` claim. Tier is a hard ceiling: tier < 2 can never be the
 * sole basis for a high-risk claim regardless of learned score.
 */
export function canAuthorHighRiskClaim(trustTier: number, _trustScore: number): boolean {
  return trustTier >= 2;
}
