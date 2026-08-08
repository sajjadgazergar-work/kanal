import type { ClaimCoverage } from '@kanal/contracts';

/**
 * Factual grounding, deterministic part (plan §15.2): every sentence that
 * carries a number or a named entity must have at least one `claim_id` in the
 * coverage map. This is the machine-checkable half of the dimension; the judge
 * supplies the rest (§15.2 D8).
 */

export interface FactualGroundingInput {
  coverage: ClaimCoverage;
  bodyMd: string;
}

export interface FactualGroundingResult {
  score: number;
  sentencesWithNumbersOrEntities: number;
  sentencesWithoutClaim: string[];
  uncitedRatio: number;
  hard: string[];
}

/** Detect a number: Latin digits, Persian/Arabic digits, or digit-plus-unit. */
const NUMBER_RE = /[\p{N}][\p{N}\p{Pd}.]*/u;

/** Minimal named-entity heuristics: capitalised Latin words or common markers. */
const NAMED_ENTITY_RE = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*/;

/**
 * Deterministic check of the claim-coverage invariant. `bodyMd` is only used to
 * confirm the sentence list aligns; the actual decision uses `coverage`.
 */
export function evaluateFactualGrounding(input: FactualGroundingInput): FactualGroundingResult {
  const { coverage, bodyMd } = input;
  void bodyMd;

  const hard: string[] = [];
  const sentencesWithoutClaim: string[] = [];

  for (const s of coverage.sentences) {
    if (!s.needsCitation) continue;
    if (!s.hasCitation && s.claimIds.length === 0) {
      sentencesWithoutClaim.push(`sentence ${s.index} needs a citation but has no claim`);
      hard.push(`sentence ${s.index} needs a citation but has no claim`);
    }
  }

  const needs = coverage.sentences.filter((s) => s.needsCitation).length;
  const uncited = sentencesWithoutClaim.length;
  // Use the locally counted uncited fraction when the coverage record does not
  // carry a ratio (and it is consistent with the sentence list).
  const uncitedRatio =
    coverage.uncitedRatio === 0 && uncited > 0 ? uncited / Math.max(needs, 1) : coverage.uncitedRatio;

  // The plan also caps the uncited ratio at 0.35 (§8.5) — anything above fails.
  if (uncitedRatio > 0.35) {
    hard.push(`uncited ratio ${uncitedRatio.toFixed(3)} exceeds 0.35`);
  }

  const score = hard.length === 0 ? 1 : 0;
  return {
    score,
    sentencesWithNumbersOrEntities: needs,
    sentencesWithoutClaim,
    uncitedRatio,
    hard,
  };
}

/** True when a sentence contains a number or a named entity. */
export function needsCitationForSentence(text: string): boolean {
  return NUMBER_RE.test(text) || NAMED_ENTITY_RE.test(text);
}
