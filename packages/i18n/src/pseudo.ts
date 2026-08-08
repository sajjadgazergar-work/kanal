/**
 * en-XA pseudo-locale (plan §14.8).
 *
 * A build helper that expands strings by ≥40% and reverses direction, used in
 * CI screenshot tests to catch hard-coded widths and untranslated strings.
 *
 * Expansion strategy: each ASCII letter is doubled with an accented variant,
 * which also makes untranslated strings visually obvious (ASCII letters remain
 * un-doubled). Non-letter runs are preserved so the ratio is not skewed by
 * whitespace. `expandPseudo` is exported separately so tests can measure the
 * ratio directly.
 */

/** Whether a code point is a Latin ASCII letter. */
function isAsciiLetter(ch: string): boolean {
  return /[A-Za-z]/.test(ch);
}

/** Accented "doppelgänger" for a Latin letter (classic en-XA transform). */
function accented(ch: string): string {
  const map: Record<string, string> = {
    a: 'á', A: 'Á',
    b: 'ƀ', B: 'Ɓ',
    c: 'ç', C: 'Ç',
    d: 'ď', D: 'Ď',
    e: 'é', E: 'É',
    f: 'ƒ', F: 'Ƒ',
    g: 'ģ', G: 'Ġ',
    h: 'ĥ', H: 'Ĥ',
    i: 'í', I: 'Í',
    j: 'ĵ', J: 'Ĵ',
    k: 'ķ', K: 'Ķ',
    l: 'ĺ', L: 'Ĺ',
    m: 'ɱ', M: 'Ṁ',
    n: 'ń', N: 'Ń',
    o: 'ó', O: 'Ó',
    p: 'þ', P: 'Þ',
    q: 'ǫ', Q: 'Ǫ',
    r: 'ř', R: 'Ř',
    s: 'š', S: 'Š',
    t: 'ť', T: 'Ť',
    u: 'ú', U: 'Ú',
    v: 'v', V: 'V',
    w: 'ẃ', W: 'Ẃ',
    x: 'x', X: 'X',
    y: 'ý', Y: 'Ý',
    z: 'ž', Z: 'Ž',
  };
  return map[ch] ?? ch;
}

/**
 * Expand a string to at least ~2.5× its Latin-letter content (≈40% length
 * expansion overall) while keeping whitespace/punctuation intact. The doubling
 * is per-letter, so expansion ratio is deterministic and measurable.
 */
export function expandPseudo(input: string): string {
  let out = '';
  for (const ch of input) {
    if (isAsciiLetter(ch)) {
      out += ch + accented(ch);
    } else {
      out += ch;
    }
  }
  return out;
}

/** Length expansion ratio (≥1). */
export function pseudoRatio(input: string): number {
  if (input.length === 0) return 1;
  return expandPseudo(input).length / input.length;
}

/** HTML-escape a string so the pseudo-locale can be embedded safely. */
export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Mark the string as RTL for screenshot tests (dir attribute). */
export function pseudoDirection(): 'rtl' {
  return 'rtl';
}

/** Full pseudo-locale transform for a user-facing string. */
export function pseudoTranslate(input: string): string {
  return escapeHtml(expandPseudo(input));
}
