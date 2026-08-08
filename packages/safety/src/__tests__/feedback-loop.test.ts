import { describe, expect, it } from 'vitest';
import {
  wordLevelDiff,
  tokenizeWords,
  normalizeEditMetrics,
  improvedBy,
} from '../edit-distance.js';
import {
  classifyDiffs,
  classifyEditShape,
  measureImprovement,
  proposeChange,
  type RevisionDiffRow,
} from '../feedback-loop.js';

function rev(id: string, before: string, after: string, reasonCode: RevisionDiffRow['reasonCode'], iso: string): RevisionDiffRow {
  return { id, beforeText: before, afterText: after, reasonCode, createdAt: iso, editDistance: wordLevelDiff(before, after) };
}

describe('word-level edit distance', () => {
  it('computes zero distance for identical text', () => {
    const d = wordLevelDiff('the quick brown fox', 'the quick brown fox');
    expect(d.distance).toBe(0);
    expect(d.normalizedDistance).toBe(0);
  });

  it('computes distance for a substitution', () => {
    const d = wordLevelDiff('the quick brown fox', 'the quick blue fox');
    expect(d.distance).toBe(1);
    expect(d.ops.some((o) => o.type === 'delete' && o.token === 'brown')).toBe(true);
    expect(d.ops.some((o) => o.type === 'insert' && o.token === 'blue')).toBe(true);
  });

  it('computes distance for an insertion', () => {
    const d = wordLevelDiff('the quick fox', 'the very quick fox');
    expect(d.distance).toBe(1);
  });

  it('tokenizes case-insensitively and ignores punctuation', () => {
    expect(tokenizeWords('Hello, WORLD! #AI')).toEqual(['hello', 'world', 'ai']);
  });

  it('normalizes by max token count', () => {
    const d = wordLevelDiff('a b c d e f', 'a b c d e f changed');
    expect(d.normalizedDistance).toBeCloseTo(1 / 7, 5);
  });
});

describe('feedback loop capture + classify', () => {
  const t = '2026-06-01T10:00:00.000Z';

  it('classifies a deleted opening sentence', () => {
    const d = wordLevelDiff('Let me start by saying that the market moved significantly today.', 'The market moved significantly today.');
    expect(classifyEditShape(d)).toBe('deleted_opening');
  });

  it('classifies an adjective replacement', () => {
    const d = wordLevelDiff('a truly remarkable result', 'a good result');
    // substitution of two words → replaced_adjective
    expect(classifyEditShape(d)).toBe('replaced_adjective');
  });

  it('proposes a learned correction after >= 3 recurring edits', () => {
    const rows = [
      rev('r1', 'Let me start by saying the market moved today.', 'The market moved today.', 'structure', t),
      rev('r2', 'Let me start by saying the index rallied.', 'The index rallied.', 'structure', t),
      rev('r3', 'Let me start by saying the bond fell.', 'The bond fell.', 'structure', t),
    ];
    const groups = classifyDiffs(rows, t);
    const g = groups.find((x) => x.shape === 'deleted_opening');
    expect(g).toBeTruthy();
    expect(g!.proposal).toBeTruthy();
    expect(g!.proposal!.kind).toBe('learned_correction');
    expect(g!.proposal!.evidence).toHaveLength(3);
  });

  it('does not propose for fewer than 3 recurrences', () => {
    const rows = [
      rev('r1', 'Let me start by saying the market moved today.', 'The market moved today.', 'structure', t),
      rev('r2', 'Let me start by saying the index rallied.', 'The index rallied.', 'structure', t),
    ];
    const groups = classifyDiffs(rows, t);
    expect(groups.every((g) => !g.proposal)).toBe(true);
  });

  it('proposes a lexicon.avoid for repeated adjective replacement', () => {
    const rows = [
      rev('r1', 'a truly remarkable outcome', 'a good outcome', 'wrong_tone', t),
      rev('r2', 'a truly remarkable chart', 'a clean chart', 'wrong_tone', t),
      rev('r3', 'a truly remarkable insight', 'a sharp insight', 'wrong_tone', t),
    ];
    const groups = classifyDiffs(rows, t);
    const g = groups.find((x) => x.shape === 'replaced_adjective');
    expect(g).toBeTruthy();
    expect(g!.proposal).toBeTruthy();
    expect(g!.proposal!.kind).toBe('lexicon_avoid');
  });

  it('proposes a banned_pattern for recurring banned_phrase', () => {
    const rows = [
      rev('r1', 'This is not just a win, it is a revolution in tech', 'This is a meaningful improvement.', 'banned_phrase', t),
      rev('r2', 'This is not just a win for us', 'A good result.', 'banned_phrase', t),
      rev('r3', 'This is not just a win, believe me', 'Good progress.', 'banned_phrase', t),
    ];
    const groups = classifyDiffs(rows, t);
    const g = groups.find((x) => x.reasonCode === 'banned_phrase');
    expect(g).toBeTruthy();
    expect(g!.proposal).toBeTruthy();
    expect(g!.proposal!.kind).toBe('banned_pattern');
  });

  it('ignores diffs older than 30 days', () => {
    const old = '2026-03-01T10:00:00.000Z';
    const rows = [
      rev('r1', 'Let me start by saying A', 'A.', 'structure', old),
      rev('r2', 'Let me start by saying B', 'B.', 'structure', old),
      rev('r3', 'Let me start by saying C', 'C.', 'structure', old),
    ];
    const groups = classifyDiffs(rows, '2026-06-01T10:00:00.000Z');
    expect(groups.every((g) => !g.proposal)).toBe(true);
  });
});

describe('measurement', () => {
  it('reports median normalized distance before vs after', () => {
    const before = [
      rev('b1', 'This is a long rambling opening paragraph that the editor hated and trimmed hard', 'Short.', 'too_long', '2026-06-01T10:00:00.000Z'),
      rev('b2', 'Another verbose paragraph full of fluff that nobody reads and everything', 'Tight.', 'too_long', '2026-06-02T10:00:00.000Z'),
      rev('b3', 'Yet another overly long paragraph that keeps going on and on forever here', 'Brief.', 'too_long', '2026-06-03T10:00:00.000Z'),
    ];
    const after = [
      rev('a1', 'A concise opener', 'A concise opener', 'too_long', '2026-07-01T10:00:00.000Z'),
      rev('a2', 'Another concise opener', 'Another concise opener', 'too_long', '2026-07-02T10:00:00.000Z'),
      rev('a3', 'Third concise opener', 'Third concise opener', 'too_long', '2026-07-03T10:00:00.000Z'),
    ];
    const m = measureImprovement(before, after);
    expect(m.beforeMedian).toBeGreaterThan(0.5);
    expect(m.afterMedian).toBeLessThanOrEqual(0);
    expect(m.targetMet).toBe(true);
    expect(m.improvementPct).toBeGreaterThanOrEqual(30);
  });

  it('improvedBy compares medians with a minimum threshold', () => {
    const high = normalizeEditMetrics([{ normalizedDistance: 0.8 }, { normalizedDistance: 0.7 }]);
    const low = normalizeEditMetrics([{ normalizedDistance: 0.1 }, { normalizedDistance: 0.2 }]);
    expect(improvedBy(high, low, 0.3)).toBe(true);
    const notMuch = normalizeEditMetrics([{ normalizedDistance: 0.6 }, { normalizedDistance: 0.6 }]);
    expect(improvedBy(high, notMuch, 0.3)).toBe(false);
  });
});

describe('proposeChange shapes', () => {
  it('every proposal is exactly one artefact kind', () => {
    const kinds = ['learned_correction', 'lexicon_avoid', 'banned_pattern'];
    const rows = [
      rev('p1', 'Let me start by saying X', 'X', 'structure', '2026-06-01T10:00:00.000Z'),
      rev('p2', 'Let me start by saying Y', 'Y', 'structure', '2026-06-02T10:00:00.000Z'),
      rev('p3', 'Let me start by saying Z', 'Z', 'structure', '2026-06-03T10:00:00.000Z'),
    ];
    const proposal = proposeChange(rows);
    expect(kinds).toContain(proposal.kind);
    expect(proposal.count).toBe(3);
  });
});
