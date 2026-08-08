/**
 * Word-level Levenshtein diff and normalized edit distance (plan §15.5).
 *
 * The feedback loop captures human edits in the approval queue. Each edit
 * produces a `revision_diff` row: before text, after text, a word-level diff,
 * and the reason_code chip the user picked. This module computes the word-level
 * diff and the normalized distance used as the "median human edit distance per
 * post" shipped metric.
 *
 * Distance is normalized by the maximum of the two token counts, so a long post
 * with one changed word scores near zero and a fully rewritten post scores 1.
 */

export interface WordDiff {
  type: 'same' | 'delete' | 'insert';
  /** Original token (for delete/same) or added token (for insert). */
  token: string;
  /** 1-based position in the *after* sequence for insert/same, else null. */
  afterPos?: number;
}

export interface EditDiff {
  beforeTokens: string[];
  afterTokens: string[];
  /** Operations in before→after order. */
  ops: WordDiff[];
  distance: number;
  normalizedDistance: number;
  deletions: number;
  insertions: number;
  substitutions: number;
}

export interface NormalizedEditMetrics {
  /** Sum of per-post normalized distances. */
  totalNormalized: number;
  medianNormalized: number;
  count: number;
}

/** Word-level tokenization: lowercased ASCII words/numbers, ignores punctuation. */
export function tokenizeWords(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Word-level Levenshtein distance via a DP table, with a traceback producing
 * the operation sequence. `delete` = present in before, absent in after;
 * `insert` = absent in before, present in after; substitution is rendered as a
 * delete followed by an insert.
 */
export function wordLevelDiff(beforeText: string, afterText: string): EditDiff {
  const A = tokenizeWords(beforeText);
  const B = tokenizeWords(afterText);
  const n = A.length;
  const m = B.length;
  // dp[i][j] = edit distance between A[0..i) and B[0..j)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i]![0] = i;
  for (let j = 0; j <= m; j++) dp[0]![j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = A[i - 1] === B[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  const distance = dp[n]![m]!;

  const ops: WordDiff[] = [];
  let i = n;
  let j = m;
  let deletions = 0;
  let insertions = 0;
  let substitutions = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && A[i - 1] === B[j - 1]) {
      ops.unshift({ type: 'same', token: A[i - 1]!, afterPos: j });
      i--;
      j--;
    } else if (i > 0 && (j === 0 || dp[i - 1]![j]! <= dp[i]![j - 1]!)) {
      ops.unshift({ type: 'delete', token: A[i - 1]! });
      deletions++;
      i--;
    } else if (j > 0) {
      ops.unshift({ type: 'insert', token: B[j - 1]!, afterPos: j });
      insertions++;
      j--;
    } else {
      break;
    }
  }
  substitutions = Math.min(deletions, insertions);
  const normalizedDistance = m === 0 && n === 0 ? 0 : distance / Math.max(n, m);

  return {
    beforeTokens: A,
    afterTokens: B,
    ops,
    distance,
    normalizedDistance,
    deletions,
    insertions,
    substitutions,
  };
}

/**
 * Aggregate per-post normalized distances. The shipped target is
 * "median edit distance down ≥ 30% over 60 posts" (plan §15.5): compare
 * medianNormalized over the 30 posts before a voice-pack change against the
 * 30 after.
 */
export function normalizeEditMetrics(diffs: Array<{ normalizedDistance: number }>): NormalizedEditMetrics {
  const totalNormalized = diffs.reduce((acc, d) => acc + d.normalizedDistance, 0);
  const medianNormalized = median(diffs.map((d) => d.normalizedDistance));
  return { totalNormalized, medianNormalized, count: diffs.length };
}

/**
 * Compare a "before" and "after" batch of diffs. Returns true when the median
 * normalized edit distance fell by at least `minImprovement` (default 0.30,
 * i.e. the ≥ 30% target from §15.5).
 */
export function improvedBy(before: NormalizedEditMetrics, after: NormalizedEditMetrics, minImprovement = 0.3): boolean {
  if (before.count === 0) return false;
  const improvement = 1 - after.medianNormalized / before.medianNormalized;
  return improvement >= minImprovement;
}
