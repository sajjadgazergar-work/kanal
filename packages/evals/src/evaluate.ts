import type { Critique } from '@kanal/contracts';
import { compositeFromScores, type ScoreMap } from './composite.js';
import { evaluateBannedPatterns, bannedPatternScore } from './banned-patterns.js';
import { evaluateStructure, structuralScore } from './structural.js';
import { evaluateQuoteBudget } from './quote-budget.js';
import { evaluateFormatting } from './formatting.js';
import { evaluateFactualGrounding } from './factual-grounding.js';
import { DEFAULT_GATE_POLICY, evaluateGate, judgeContribution, type GatePolicy, type Judge } from './judge.js';
import {
  DETERMINISTIC_SUB_WEIGHTS,
  type DeterministicResult,
  type DeterministicScores,
  type DimensionIssue,
  type EvalInput,
  type GateMode,
  type JudgeTrust,
} from './types.js';

export interface EvalOptions {
  /** Injectable judge. When absent, only the deterministic half is scored. */
  judge?: Judge;
  /** Judge trust map from calibration (κ ≥ 0.4 per dimension). */
  trust?: JudgeTrust;
  gateMode?: GateMode;
  /** Optional rendered HTML for the formatting scorer. */
  html?: string;
}

export interface EvalResult {
  scores: ScoreMap;
  composite: number;
  passes: boolean;
  issues: DimensionIssue[];
  deterministic: DeterministicResult;
  judgeScores?: ScoreMap;
  verdict: { verdict: 'pass' | 'revise' | 'block'; reasons: string[] };
}

/**
 * Evaluate a post through the deterministic scorers and (optionally) a judge.
 * The composite is the renormalized weighted sum over trusted dimensions; the
 * deterministic floor is guaranteed by construction (the renormalization never
 * drops below the deterministic composite).
 */
export async function evaluate(input: EvalInput, opts: EvalOptions = {}): Promise<EvalResult> {
  const issues: DimensionIssue[] = [];
  const scores: ScoreMap = {};
  const policy: GatePolicy = { gateMode: opts.gateMode ?? DEFAULT_GATE_POLICY.gateMode };

  // --- Deterministic scorers -------------------------------------------------

  const struct = evaluateStructure(input.post.bodyMd, input.brief, input.voice);
  scores.structuralCompliance = structuralScore(struct);
  pushIssues(issues, 'structuralCompliance', struct.hard, struct.soft);

  const banned = evaluateBannedPatterns(input.voice, input.post.bodyMd);
  scores.bannedPatternCleanliness = bannedPatternScore(banned);
  for (const h of banned.hits) {
    issues.push({
      dimension: 'bannedPatternCleanliness',
      severity: h.severity === 'hard' ? 'hard' : 'warning',
      message: h.detail,
    });
  }

  const quoteBudget = evaluateQuoteBudget(input.post.bodyMd, input.sources);
  for (const v of quoteBudget.violations) {
    issues.push({ dimension: 'formattingCorrectness', severity: 'hard', message: v.detail });
  }
  const fmt = evaluateFormatting(input.post, {
    html: opts.html ?? input.renderedHtml,
    quoteBudgetOk: quoteBudget.ok,
    quoteBudgetErrors: quoteBudget.violations.map((v) => v.detail),
  });
  scores.formattingCorrectness = fmt.score;
  for (const e of fmt.errors) {
    issues.push({ dimension: 'formattingCorrectness', severity: 'hard', message: e });
  }

  let factualScore: number;
  if (input.coverage) {
    const fg = evaluateFactualGrounding({ coverage: input.coverage, bodyMd: input.post.bodyMd });
    factualScore = fg.score;
    for (const m of fg.hard) issues.push({ dimension: 'factualGrounding', severity: 'hard', message: m });
  } else {
    // No coverage supplied: the deterministic half cannot be checked, so it is
    // scored neutral (no penalty, no credit).
    factualScore = 0.5;
    issues.push({ dimension: 'factualGrounding', severity: 'info', message: 'no ClaimCoverage provided; deterministic grounding check skipped' });
  }

  // The deterministic factualGrounding share is renormalized with the judge
  // share when a judge is present; here we store the deterministic value under
  // a separate key so the judge fold can blend it.
  const deterministicScores: DeterministicScores = {
    factualGrounding: factualScore,
    structuralCompliance: scores.structuralCompliance as number,
    bannedPatternCleanliness: scores.bannedPatternCleanliness as number,
    formattingCorrectness: scores.formattingCorrectness as number,
  };

  const deterministicIssues = issues.filter((i) =>
    i.dimension === 'factualGrounding' ||
    i.dimension === 'structuralCompliance' ||
    i.dimension === 'bannedPatternCleanliness' ||
    i.dimension === 'formattingCorrectness',
  );

  const deterministicComposite =
    (deterministicScores.factualGrounding * DETERMINISTIC_SUB_WEIGHTS.factualGrounding +
      deterministicScores.structuralCompliance * DETERMINISTIC_SUB_WEIGHTS.structuralCompliance +
      deterministicScores.bannedPatternCleanliness * DETERMINISTIC_SUB_WEIGHTS.bannedPatternCleanliness +
      deterministicScores.formattingCorrectness * DETERMINISTIC_SUB_WEIGHTS.formattingCorrectness) /
    Object.values(DETERMINISTIC_SUB_WEIGHTS).reduce((a, b) => a + b, 0);

  const deterministic: DeterministicResult = {
    scores: deterministicScores,
    issues: deterministicIssues,
    composite: deterministicComposite,
    quoteBudget,
  };

  // --- Judge ----------------------------------------------------------------

  let judgeScores: ScoreMap | undefined;
  if (opts.judge && opts.trust) {
    const output = await opts.judge.evaluate(input);
    judgeScores = judgeContribution(output, opts.trust);
  } else if (opts.judge) {
    const output = await opts.judge.evaluate(input);
    judgeScores = judgeContribution(output, { trusted: allTrusted().trusted });
    for (const i of output.issues) issues.push(i);
  }

  // Blend deterministic + trusted judge dimensions into one score map.
  const blended: ScoreMap = {
    structuralCompliance: deterministicScores.structuralCompliance,
    bannedPatternCleanliness: deterministicScores.bannedPatternCleanliness,
    formattingCorrectness: deterministicScores.formattingCorrectness,
  };

  const fgTrusted = opts.trust?.trusted.factualGrounding ?? true;
  const fgJudge = judgeScores?.factualGrounding;
  if (fgTrusted && fgJudge !== undefined) {
    // 14% deterministic share + 8% judge share of the 22% factualGrounding
    // weight. The deterministic half is authoritative: a 0 judge on the
    // deterministic share still contributes.
    const detShare = 0.14 / 0.22;
    blended.factualGrounding = deterministicScores.factualGrounding * detShare + fgJudge * (1 - detShare);
  } else {
    blended.factualGrounding = deterministicScores.factualGrounding;
  }

  // Judge-only dimensions, only when trusted.
  for (const dim of ['voiceConformance', 'specificity', 'readerValue'] as const) {
    const trusted = opts.trust?.trusted[dim] ?? true;
    const j = judgeScores?.[dim];
    if (trusted && j !== undefined) blended[dim] = j;
  }

  const composite = compositeFromScores(blended);
  const hardFailures = issues
    .filter((i) => i.severity === 'hard')
    .map((i) => i.message);

  // The gate under 'aggregate' uses the deterministic floor; the judge-inclusive
  // composite only feeds the per-item gate when explicitly enabled (plan A6).
  const verdict = evaluateGate(
    deterministicComposite,
    hardFailures,
    policy,
    policy.gateMode === 'per_item' ? composite : undefined,
  );

  // The gate is authoritative for pass/block. `composite` is informational
  // (judge-inclusive); a judge score alone can never block, so `passes` follows
  // the verdict rather than the raw blended composite.
  const passes = verdict.verdict === 'pass';

  return {
    scores: blended,
    composite,
    passes,
    issues,
    deterministic,
    judgeScores,
    verdict,
  };
}

function pushIssues(
  issues: DimensionIssue[],
  dimension: string,
  hard: string[],
  soft: string[] = [],
): void {
  for (const m of hard) issues.push({ dimension, severity: 'hard', message: m });
  for (const m of soft) issues.push({ dimension, severity: 'warning', message: m });
}

function allTrusted(): JudgeTrust {
  return {
    trusted: {
      factualGrounding: true,
      voiceConformance: true,
      structuralCompliance: true,
      bannedPatternCleanliness: true,
      specificity: true,
      readerValue: true,
      formattingCorrectness: true,
    },
    kappa: {
      factualGrounding: 1,
      voiceConformance: 1,
      structuralCompliance: 1,
      bannedPatternCleanliness: 1,
      specificity: 1,
      readerValue: 1,
      formattingCorrectness: 1,
    },
  };
}

/** Build a Critique-shape record from an EvalResult (for pipeline stage 6). */
export function toCritique(result: EvalResult): Critique {
  return {
    scores: {
      factualGrounding: result.scores.factualGrounding ?? 0,
      voiceConformance: result.scores.voiceConformance ?? 0,
      structuralCompliance: result.scores.structuralCompliance ?? 0,
      bannedPatternCleanliness: result.scores.bannedPatternCleanliness ?? 0,
      specificity: result.scores.specificity ?? 0,
      readerValue: result.scores.readerValue ?? 0,
      formattingCorrectness: result.scores.formattingCorrectness ?? 0,
    },
    issues: result.issues.map((i) => ({
      dimension: i.dimension,
      severity: i.severity,
      message: i.message,
    })),
    composite: result.composite,
  };
}
