/**
 * Plain-text normalization (plan §8.2).
 *
 * The pipeline: readability extraction (in fetcher.ts) → normalizeText →
 * trim. NFC normalization plus zero-width stripping removes one prompt-injection
 * vector (§16.2 #4): an attacker cannot hide instructions inside zero-width
 * spaces, BOMs, or confusable soft-hyphens before the text reaches any model.
 */

// Zero-width and other invisible / direction-control characters. This is an
// explicit list rather than a Unicode category sweep: we want to remove the
// injection-capable invisibles without mangling legitimate diacritics.
// Written as \u escapes (not literal invisibles) so the source stays
// lint-clean and diff-able: ZWSP, ZWNJ, ZWJ, word joiner, BOM, soft hyphen,
// LRM, RLM, LRE, RLE, PDF, LRO, RLO.
// The format chars below (ZWNJ, soft hyphen, etc.) ARE the injection vectors.
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_PATTERN = /[\u200b\u200c\u200d\u2060\ufeff\u00ad\u200e\u200f\u202a\u202b\u202c\u202d\u202e]/g;

/**
 * Normalize untrusted text: NFC normalization, strip zero-width and direction
 * characters, collapse all whitespace runs to a single space, trim.
 *
 * Collapsing whitespace is deliberate even for languages without spaces —
 * Persian text contains legitimate spaces and the collapse only merges runs,
 * it never splits a run.
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFC')
    .replace(INVISIBLE_PATTERN, '')
    // Collapse runs of whitespace (incl. NBSP / narrow NBSP / thin space) to
    // a single space.
    .replace(/[ \t\n\r\f\v\u00a0\u202f\u2009]+/g, ' ')
    .trim();
}

/**
 * Normalize a title: same pipeline as body text but also collapses internal
 * spaces fully. Titles are used for trigram similarity, so stable tokenization
 * matters.
 */
export function normalizeTitle(input: string | null | undefined): string | null {
  if (!input) return null;
  const t = normalizeText(input);
  return t.length > 0 ? t : null;
}

/**
 * Tokenize text for simhash: lowercase, split on non-alphanumeric runs, drop
 * tokens shorter than 3 chars and the classic English stopword set.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her',
  'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man',
  'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let',
  'put', 'say', 'she', 'too', 'use', 'that', 'with', 'have', 'this', 'will',
  'your', 'from', 'they', 'know', 'want', 'been', 'good', 'much', 'some',
  'time', 'very', 'when', 'come', 'here', 'just', 'like', 'long', 'make',
  'many', 'over', 'such', 'take', 'than', 'them', 'well', 'were', 'what',
  'into', 'about', 'after', 'before', 'could', 'would', 'their', 'there',
  'where', 'which', 'while', 'these', 'those', 'might', 'should', 'during',
  'through', 'because', 'however', 'although', 'another', 'between',
]);

export function tokenize(text: string, minLength = 3): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_À-ɏ؀-ۿ一-鿿぀-ヿ가-힯]+/i)
    .filter((t) => t.length >= minLength && !STOPWORDS.has(t));
  return tokens;
}
