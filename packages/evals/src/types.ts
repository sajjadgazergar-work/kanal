import type { Brief, ClaimCoverage, PostDraft, VoicePack } from '@kanal/contracts';

/**
 * The seven rubric dimensions (plan §15.2). Each is scored 0–1 and carries a
 * stated weight; the composite is the weighted sum and ≥ 0.72 passes.
 */
export type DimensionId =
  | 'factualGrounding'
  | 'voiceConformance'
  | 'structuralCompliance'
  | 'bannedPatternCleanliness'
  | 'specificity'
  | 'readerValue'
  | 'formattingCorrectness';

export const DIMENSIONS: readonly DimensionId[] = [
  'factualGrounding',
  'voiceConformance',
  'structuralCompliance',
  'bannedPatternCleanliness',
  'specificity',
  'readerValue',
  'formattingCorrectness',
];

export const DIMENSION_WEIGHTS: Record<DimensionId, number> = {
  factualGrounding: 0.22,
  voiceConformance: 0.18,
  structuralCompliance: 0.12,
  bannedPatternCleanliness: 0.12,
  specificity: 0.14,
  readerValue: 0.12,
  formattingCorrectness: 0.10,
};

/**
 * The deterministic sub-weights. 48% of the rubric weight is machine-checkable
 * (plan §15.2, D8): factualGrounding (0.22 total) splits into a 0.14
 * deterministic ClaimCoverage share and a 0.08 judge share; structural,
 * banned-pattern and formatting are fully deterministic.
 */
export const DETERMINISTIC_SUB_WEIGHTS: Record<
  'factualGrounding' | 'structuralCompliance' | 'bannedPatternCleanliness' | 'formattingCorrectness',
  number
> = {
  factualGrounding: 0.14,
  structuralCompliance: 0.12,
  bannedPatternCleanliness: 0.12,
  formattingCorrectness: 0.10,
};

export const DETERMINISTIC_WEIGHT_TOTAL = Object.values(DETERMINISTIC_SUB_WEIGHTS).reduce(
  (a, b) => a + b,
  0,
);

export const COMPOSITE_PASS_THRESHOLD = 0.72;

/** Per-item judge gating policy (plan A6). Default 'aggregate': judge never gates a post. */
export type GateMode = 'aggregate' | 'per_item';

export const DEFAULT_GATE_MODE: GateMode = 'aggregate';

/** The policy constant name that selects the gate mode: `eval.gate_mode`. */
export const GATE_MODE_POLICY = 'eval.gate_mode';

export interface SourceText {
  sourceItemId: string;
  bodyText: string;
}

export interface EvalInput {
  post: PostDraft;
  brief: Brief;
  voice: VoicePack;
  coverage?: ClaimCoverage;
  sources: SourceText[];
  renderedHtml?: string;
  /** Opaque per-post metadata (e.g. a golden-set id), ignored by the scorers. */
  meta?: Record<string, unknown>;
}

export interface DimensionIssue {
  dimension: string;
  severity: 'info' | 'warning' | 'hard';
  message: string;
}

export interface DeterministicScores {
  factualGrounding: number;
  structuralCompliance: number;
  bannedPatternCleanliness: number;
  formattingCorrectness: number;
}

export interface QuoteBudgetMatch {
  start: number;
  end: number;
  len: number;
  sourceItemId: string;
  insideBlockquote: boolean;
  attributed: boolean;
}

export interface QuoteBudgetViolation {
  kind: 'overlength_unquoted' | 'total_cap_exceeded';
  matchLen?: number;
  sourceItemId?: string;
  detail: string;
}

export interface QuoteBudgetResult {
  ok: boolean;
  violations: QuoteBudgetViolation[];
  matches: QuoteBudgetMatch[];
  /** Number of body characters that are verbatim from any cited source. */
  verbatimChars: number;
  /** The cap that applied: min(25% of post length, 400). */
  cap: number;
}

export interface DeterministicResult {
  scores: DeterministicScores;
  issues: DimensionIssue[];
  /** Renormalized composite over the deterministic sub-weights (the 48% floor). */
  composite: number;
  quoteBudget: QuoteBudgetResult;
}

export interface JudgeOutput {
  scores: Record<DimensionId, number>;
  issues: DimensionIssue[];
}

export interface JudgeTrust {
  /** Trust map per dimension from calibration (κ ≥ 0.4). */
  trusted: Record<DimensionId, boolean>;
  /** The κ that produced the trust decision. */
  kappa: Record<DimensionId, number>;
}
