import { wordLevelDiff, normalizeEditMetrics, type EditDiff } from './edit-distance.js';

/**
 * Human feedback loop (plan §15.5).
 *
 * 1. **Capture.** Every human edit in the approval queue produces a
 *    `revision_diff` row: before text, after text, a word-level diff, and the
 *    reason_code chip (`too_long`, `wrong_tone`, `factual`, `structure`,
 *    `banned_phrase`, `boring_opening`, `other`).
 * 2. **Classify.** Group diffs by reason_code and by edit shape.
 * 3. **Propose.** When a pattern recurs ≥ 3 times in 30 days, propose exactly
 *    one of three artefact changes: a new `learned_corrections` rule, a
 *    `lexicon.avoid` addition, or a `banned_patterns` regex.
 * 4. **Approve.** Human sees the proposal as a voice-pack diff.
 * 5. **Measure.** After 30 posts: median human edit distance per post before
 *    vs after. If distance did not fall, flag the correction ineffective.
 */

export const REASON_CODES = [
  'too_long',
  'wrong_tone',
  'factual',
  'structure',
  'banned_phrase',
  'boring_opening',
  'other',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface RevisionDiffRow {
  id: string;
  beforeText: string;
  afterText: string;
  reasonCode: ReasonCode;
  createdAt: string; // ISO 8601
  editDistance: EditDiff;
}

export type EditShape =
  | 'deleted_opening'
  | 'replaced_adjective'
  | 'added_number'
  | 'reordered'
  | 'shortened'
  | 'other';

export interface ClassifiedDiff extends RevisionDiffRow {
  shape: EditShape;
}

export type ProposalKind = 'learned_correction' | 'lexicon_avoid' | 'banned_pattern';

export interface VoicePackProposal {
  kind: ProposalKind;
  artefact: {
    rule?: string;
    word?: string;
    pattern?: string;
    severity?: 'hard' | 'soft';
  };
  evidence: string[]; // revision ids
  rationale: string;
  count: number;
}

export interface PatternGroup {
  reasonCode: ReasonCode;
  shape: EditShape;
  diffs: RevisionDiffRow[];
  proposal?: VoicePackProposal;
}

/**
 * Classify a diff by edit shape. The heuristic looks at the word-level ops.
 */
export function classifyEditShape(diff: EditDiff): EditShape {
  const ops = diff.ops;
  const firstOp = ops[0];
  if (firstOp && firstOp.type === 'delete' && diff.beforeTokens.length > 0) {
    // Deletion of the opening sentence: the first op is a delete covering ≥ 3
    // tokens (a sentence-ish span) from the start.
    if (ops.slice(0, 5).every((o) => o.type === 'delete') && ops.length >= 3) {
      return 'deleted_opening';
    }
  }
  if (diff.substitutions > 0 && diff.deletions <= 2 && diff.insertions <= 2) {
    return 'replaced_adjective';
  }
  if (diff.insertions > 0 && diff.insertions >= 1 && diff.deletions === 0) {
    return 'added_number';
  }
  if (diff.distance > 0 && diff.deletions > 0 && diff.insertions > 0) {
    return 'reordered';
  }
  if (diff.normalizedDistance > 0.3) {
    return 'shortened';
  }
  return 'other';
}

/**
 * Group diffs by (reasonCode, shape). Any group with ≥ 3 diffs within 30 days
 * gets a proposal.
 */
export function classifyDiffs(rows: RevisionDiffRow[], nowIso?: string): PatternGroup[] {
  const groups = new Map<string, PatternGroup>();
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  const cutoff = now - 30 * 86_400_000;

  for (const row of rows) {
    const at = Date.parse(row.createdAt);
    if (at < cutoff) continue;
    const shape = classifyEditShape(row.editDistance);
    const key = `${row.reasonCode}:${shape}`;
    let g = groups.get(key);
    if (!g) {
      g = { reasonCode: row.reasonCode, shape, diffs: [] };
      groups.set(key, g);
    }
    g.diffs.push(row);
  }

  const result: PatternGroup[] = [];
  for (const g of groups.values()) {
    if (g.diffs.length >= 3) {
      g.proposal = proposeChange(g.diffs);
    }
    result.push(g);
  }
  return result;
}

/**
 * Propose exactly one artefact change for a recurring pattern. The rule is
 * derived from the most common edit shape:
 *   - deleted_opening → learned_correction ("Do not open with …")
 *   - replaced_adjective → lexicon.avoid (the removed word)
 *   - banned_phrase / too_long → banned_pattern regex (the removed span)
 *   - otherwise → learned_correction
 */
export function proposeChange(diffs: RevisionDiffRow[]): VoicePackProposal {
  const first = diffs[0]!;
  const shape = classifyEditShape(first.editDistance);
  const evidence = diffs.map((d) => d.id);

  if (shape === 'deleted_opening') {
    return {
      kind: 'learned_correction',
      artefact: { rule: 'Do not open with a long preamble; state the claim first.' },
      evidence,
      rationale: `${diffs.length} edits deleted the opening sentence in 30 days`,
      count: diffs.length,
    };
  }
  if (shape === 'replaced_adjective') {
    const removed = first.editDistance.ops.find((o) => o.type === 'delete')?.token;
    return {
      kind: 'lexicon_avoid',
      artefact: { word: removed ?? '' },
      evidence,
      rationale: `${diffs.length} edits replaced an adjective the agent chose`,
      count: diffs.length,
    };
  }
  if (first.reasonCode === 'banned_phrase') {
    const span = first.beforeText.split(/\s+/).slice(0, 8).join(' ');
    return {
      kind: 'banned_pattern',
      artefact: {
        pattern: span.length > 0 ? `(?i)${escapeRegex(span)}` : '',
        severity: 'soft',
      },
      evidence,
      rationale: `${diffs.length} edits flagged a banned phrase`,
      count: diffs.length,
    };
  }
  return {
    kind: 'learned_correction',
    artefact: { rule: `Prefer the human's ${first.reasonCode} edits consistently.` },
    evidence,
    rationale: `${diffs.length} edits share reason_code ${first.reasonCode}`,
    count: diffs.length,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Measure: median normalized edit distance over a batch of diffs. Compare
 * `before` vs `after` batches. Returns the report and whether the target
 * (median down ≥ 30%) was met.
 */
export function measureImprovement(
  before: RevisionDiffRow[],
  after: RevisionDiffRow[],
): {
  beforeMedian: number;
  afterMedian: number;
  beforeCount: number;
  afterCount: number;
  improvementPct: number;
  targetMet: boolean;
} {
  const b = normalizeEditMetrics(before.map((r) => ({ normalizedDistance: r.editDistance.normalizedDistance })));
  const a = normalizeEditMetrics(after.map((r) => ({ normalizedDistance: r.editDistance.normalizedDistance })));
  const improvementPct = b.count > 0 ? ((b.medianNormalized - a.medianNormalized) / b.medianNormalized) * 100 : 0;
  return {
    beforeMedian: b.medianNormalized,
    afterMedian: a.medianNormalized,
    beforeCount: b.count,
    afterCount: a.count,
    improvementPct,
    targetMet: improvementPct >= 30,
  };
}

export { wordLevelDiff };
