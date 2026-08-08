import type { VoicePack } from '@kanal/contracts';

/**
 * Deterministic banned-pattern evaluation (plan §15.1, §15.3):
 *
 * - `kind: 'pattern'` → regex test on the post body. Hard blocks, soft scores a
 *   penalty.
 * - `kind: 'density'` → count occurrences of a token per 100 words; if the
 *   density exceeds `maxPer100Words` it is a hard violation (hard) or a soft
 *   penalty.
 *
 * The voice-pack patterns are authored with Python/PCRE-style inline flags such
 * as `(?i)`; JS `RegExp` does not accept those, so `(?i)` (and `(?m)`, `(?s)`)
 * are stripped and their flags moved to the RegExp flag string.
 */

export interface BannedPatternHit {
  patternId: string;
  kind: 'pattern' | 'density';
  severity: 'hard' | 'soft';
  detail: string;
}

export interface BannedEvaluationResult {
  hits: BannedPatternHit[];
  hard: BannedPatternHit[];
  hardCount: number;
}

const INLINE_FLAGS = /^\(\?([a-z]+)\)/;

export function buildRegExp(pattern: string): RegExp {
  let p = pattern;
  let flags = '';
  const m = p.match(INLINE_FLAGS);
  if (m && m[1]) {
    const inline = m[1];
    if (inline.includes('i')) flags += 'i';
    if (inline.includes('m')) flags += 'm';
    if (inline.includes('s')) flags += 's';
    p = p.slice(m[0].length);
  }
  return new RegExp(p, flags);
}

export function tokenizeWords(text: string): string[] {
  // Splits on any non-letter/digit (Unicode-aware) run; keeps Persian and Latin
  // letters and digits, drops punctuation.
  return text.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

export function countTokenOccurrences(text: string, token: string): number {
  let count = 0;
  let idx = 0;
  while (true) {
    const i = text.indexOf(token, idx);
    if (i === -1) break;
    count++;
    idx = i + token.length;
  }
  return count;
}

/** Token occurrences per 100 words of the whole post. */
export function densityPer100Words(text: string, token: string): number {
  const words = tokenizeWords(text).length;
  if (words === 0) return 0;
  return (countTokenOccurrences(text, token) / words) * 100;
}

export function evaluateBannedPatterns(
  voice: VoicePack,
  body: string,
): BannedEvaluationResult {
  const hits: BannedPatternHit[] = [];
  for (const p of voice.spec.bannedPatterns) {
    if (p.kind === 'density') {
      const token = p.token ?? '';
      if (token === '') continue;
      const max = p.maxPer100Words ?? 1;
      const d = densityPer100Words(body, token);
      if (d > max) {
        hits.push({
          patternId: p.id,
          kind: 'density',
          severity: p.severity,
          detail: `density ${d.toFixed(2)} per 100 words exceeds max ${max}`,
        });
      }
    } else {
      const re = buildRegExp(p.pattern);
      re.lastIndex = 0;
      if (re.test(body)) {
        hits.push({
          patternId: p.id,
          kind: 'pattern',
          severity: p.severity,
          detail: `pattern matched (${p.id})`,
        });
      }
    }
  }
  const hard = hits.filter((h) => h.severity === 'hard');
  return { hits, hard, hardCount: hard.length };
}

export function bannedPatternScore(result: BannedEvaluationResult): number {
  if (result.hardCount > 0) return 0;
  const softCount = result.hits.length - result.hardCount;
  // Each soft hit costs 0.1 (capped at zero).
  return Math.max(0, 1 - softCount * 0.1);
}
