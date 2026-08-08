import { createHash } from 'node:crypto';
import { type Token, tokenize } from './html.js';

/**
 * Telegram message splitter (plan §10.3).
 *
 * When the visible text exceeds textMaxChars (4096) or captionMaxChars (1024):
 *
 * 1. Split on paragraph boundaries (blank-line separated).
 * 2. If a paragraph alone exceeds the limit, split on sentence boundaries via
 *    `Intl.Segmenter(locale, { granularity: 'sentence' })`.
 * 3. If a sentence alone exceeds the limit, split on grapheme clusters —
 *    never mid-grapheme, never mid-surrogate-pair.
 * 4. Never split inside an open HTML tag pair; the splitter closes and reopens
 *    formatting across the boundary.
 * 5. Append `(۱/۳)`-style part markers using the channel's `numeral_system`.
 *
 * Lengths are measured in UTF-16 code units of the *visible* text (entities
 * decoded), which is what Telegram's Bot API counts (plan D5).
 */

export type NumeralSystem = 'latn' | 'arabext';

const ARABEXT_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Render a number in the channel's numeral system ('latn' | 'arabext'). */
export function toNumerals(n: number, system: NumeralSystem): string {
  const s = String(n);
  if (system === 'latn') return s;
  return s.replace(/[0-9]/g, (d) => ARABEXT_DIGITS[Number(d)] as string);
}

/** The part marker, e.g. `(۱/۳)`. */
export function partMarkerText(index: number, total: number, system: NumeralSystem): string {
  return `(${toNumerals(index, system)}/${toNumerals(total, system)})`;
}

function markerWidth(total: number, system: NumeralSystem): number {
  return partMarkerText(total, total, system).length;
}

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};

/** Decode the HTML entities our sanitizer emits back to single characters. */
export function unescapeHtml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (m) => ENTITY_MAP[m] ?? m);
}

/**
 * Visible length in UTF-16 code units after entity decoding — what Telegram
 * counts (plan D5: entity offsets are UTF-16).
 */
export function visibleLength(s: string): number {
  return unescapeHtml(s).length;
}

const VOID = new Set(['br', 'tg-emoji']);

/** Raw UTF-16 length of a token list (what the original body occupies). */
function rawLength(tokens: Token[]): number {
  let n = 0;
  for (const t of tokens) n += t.kind === 'text' ? t.text.length : t.raw.length;
  return n;
}

/** Slice a token list to the raw span [rawA, rawB). */
function sliceTokensByRaw(tokens: Token[], rawA: number, rawB: number): Token[] {
  const out: Token[] = [];
  let raw = 0;
  for (const t of tokens) {
    const start = raw;
    const end = raw + (t.kind === 'text' ? t.text.length : t.raw.length);
    raw = end;
    if (end <= rawA || start >= rawB) continue;
    if (t.kind === 'tag') {
      out.push(t);
    } else {
      const s = Math.max(start, rawA);
      const e = Math.min(end, rawB);
      const text = t.text.slice(s - start, e - start);
      if (text.length > 0) out.push({ kind: 'text', text });
    }
  }
  return out;
}

/** Render a raw token list back to a string. */
function tokensToString(tokens: Token[]): string {
  let out = '';
  for (const t of tokens) out += t.kind === 'text' ? t.text : t.raw;
  return out;
}

/**
 * Render a list of token-chunks as self-contained, tag-balanced HTML messages.
 * Formatting that spans a boundary is closed at the end of one part and
 * reopened at the start of the next (plan §10.3 "closes and reopens formatting
 * across the boundary").
 */
export function renderPartsBalanced(parts: Token[][]): string[] {
  const stack: { name: string; raw: string }[] = [];
  const outputs: string[] = [];
  for (const tokens of parts) {
    let out = '';
    for (const s of stack) out += s.raw; // reopen carried-over formatting
    for (const tok of tokens) {
      if (tok.kind === 'text') {
        out += tok.text;
        continue;
      }
      if (tok.closing) {
        const names = stack.map((s) => s.name);
        const idx = names.lastIndexOf(tok.name);
        if (idx >= 0) {
          for (let k = stack.length - 1; k >= idx; k--) out += `</${stack[k]!.name}>`;
          stack.splice(idx);
        } else {
          out += tok.raw; // stray closing — sanitized input should not produce these
        }
      } else {
        out += tok.raw;
        if (!VOID.has(tok.name)) stack.push({ name: tok.name, raw: tok.raw });
      }
    }
    for (let k = stack.length - 1; k >= 0; k--) out += `</${stack[k]!.name}>`;
    outputs.push(out);
  }
  return outputs;
}

// ---- visible <-> raw mapping ---------------------------------------------

interface VisibleModel {
  /** raw offset of each visible code unit (tags skipped) */
  charRaw: number[];
  /** full unescaped visible text */
  text: string;
  /** total raw length of the token list (incl. tags, entities, pairs) */
  rawLength: number;
}

/**
 * Build the visible text and a raw-offset map for every visible UTF-16 code
 * unit. `Intl.Segmenter` reports offsets in UTF-16 code units, so `charRaw`
 * MUST have one entry per code unit (plan D5: entity offsets are UTF-16).
 * A surrogate pair contributes two entries, both pointing at the pair's raw
 * start; `rawAt` uses the FIRST entry of a pair so a cut at a code-unit offset
 * lands on a grapheme boundary (never mid-surrogate-pair).
 */
function buildVisibleModel(tokens: Token[]): VisibleModel {
  const charRaw: number[] = [];
  let raw = 0;
  let text = '';
  for (const t of tokens) {
    if (t.kind === 'tag') {
      raw += t.raw.length;
      continue;
    }
    let i = 0;
    while (i < t.text.length) {
      const m = t.text.slice(i).match(/^&(?:amp|lt|gt|quot|#39|#x27);/);
      let rawLen: number;
      let visChar: string;
      if (m) {
        rawLen = m[0].length;
        visChar = unescapeHtml(m[0]);
      } else {
        const cp = t.text.codePointAt(i)!;
        rawLen = cp > 0xffff ? 2 : 1;
        visChar = String.fromCodePoint(cp);
      }
      if (rawLen === 2) {
        charRaw.push(raw, raw); // one entry per code unit of the pair
      } else {
        charRaw.push(raw);
      }
      text += visChar;
      raw += rawLen;
      i += rawLen;
    }
  }
  return { charRaw, text, rawLength: raw };
}

/**
 * Raw offset where the visible code unit at index `v` starts.
 *
 * INVARIANT: for `v` at the END of the model, returns the full raw length. A
 * naive `last + 1` can land MID-surrogate-pair when the last visible code unit
 * is the first unit of an astral char (charRaw has two identical entries, so
 * last + 1 would be one raw unit past the pair's start — inside the pair).
 */
function rawAt(model: VisibleModel, v: number): number {
  if (v <= 0) return 0;
  if (v >= model.charRaw.length) return model.rawLength;
  return model.charRaw[v] ?? 0;
}

/** Visible offsets of paragraph breaks (after each blank line). */
function paragraphBoundaries(model: VisibleModel): number[] {
  const out: number[] = [];
  const re = /\n{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(model.text))) out.push(m.index + m[0].length);
  return out;
}

function sentenceBoundaries(model: VisibleModel, locale: string): number[] {
  if (typeof Intl.Segmenter !== 'function') return [model.text.length];
  const seg = new Intl.Segmenter(locale, { granularity: 'sentence' });
  const out: number[] = [];
  for (const s of seg.segment(model.text)) out.push(s.index + s.segment.length);
  if (out.length === 0 || out[out.length - 1] !== model.text.length) out.push(model.text.length);
  return out;
}

function graphemeBoundaries(model: VisibleModel, locale: string): number[] {
  if (typeof Intl.Segmenter !== 'function') {
    return Array.from(model.text).map((_, i) => i + 1);
  }
  const seg = new Intl.Segmenter(locale, { granularity: 'grapheme' });
  const out: number[] = [];
  for (const s of seg.segment(model.text)) out.push(s.index + s.segment.length);
  return out;
}

/**
 * Choose the cut point. Prefer the largest paragraph boundary ≤ max, then the
 * largest sentence boundary ≤ max, then the largest grapheme boundary ≤ max.
 *
 * INVARIANT: the chosen boundary is always a grapheme boundary. Paragraph and
 * sentence boundaries are subsets of grapheme boundaries for well-formed text,
 * but a sentence segmenter can return mid-grapheme offsets on pure-emoji or
 * RTL text; those are snapped down to the nearest grapheme boundary so the
 * "never mid-grapheme, never mid-surrogate-pair" rule (plan §10.3) always
 * holds.
 *
 * If NO grapheme boundary lands ≤ max — meaning a single grapheme cluster is
 * longer than the limit (e.g. a ZWJ family emoji of 11 code units under a tiny
 * max) — fall back to the FIRST grapheme boundary, which necessarily exceeds
 * max. A single over-long grapheme must travel whole.
 */
function chooseBoundary(model: VisibleModel, max: number, locale: string, preferBoundary: boolean): number {
  const graphemes = graphemeBoundaries(model, locale);
  const bestAtOrBelow = (cands: number[]): number | undefined => {
    let b: number | undefined;
    for (const c of cands) {
      if (c > max || b !== undefined && c <= b) continue;
      if (c <= max) b = c;
    }
    return b;
  };
  // Snap any candidate to the largest grapheme boundary at or below it, so a
  // sentence/paragraph boundary can never fall mid-grapheme.
  const snapDown = (v: number): number | undefined => {
    for (let i = graphemes.length - 1; i >= 0; i--) {
      if ((graphemes[i] ?? 0) <= v) return graphemes[i];
    }
    return undefined;
  };

  const para = bestAtOrBelow(paragraphBoundaries(model));
  if (para !== undefined) {
    const snapped = snapDown(para);
    if (snapped !== undefined && snapped > 0) return snapped;
  }
  const sent = bestAtOrBelow(sentenceBoundaries(model, locale));
  if (sent !== undefined && (sent > 0 || !preferBoundary)) {
    const snapped = snapDown(sent);
    if (snapped !== undefined && snapped > 0) return snapped;
  }
  const gra = bestAtOrBelow(graphemes);
  if (gra !== undefined && gra > 0) return gra;
  // No boundary at or below max: a single grapheme exceeds the limit.
  const first = graphemes[0];
  if (first !== undefined && first > 0) return first;
  return Math.max(1, max); // should be unreachable for non-empty text
}

/** Trim trailing/leading whitespace runs off a token list at the edges. */
function trimWhitespace(tokens: Token[]): Token[] {
  return trimTrailing(trimLeading(tokens));
}

/** Strip leading whitespace only (keeps the trailing edge intact). */
function trimLeading(tokens: Token[]): Token[] {
  const out: Token[] = [...tokens];
  while (out.length > 0 && out[0]!.kind === 'text' && (out[0] as { text: string }).text.trim() === '') {
    out.shift();
  }
  if (out.length > 0 && out[0]!.kind === 'text') {
    const first = (out[0] as { text: string }).text;
    const stripped = first.replace(/^\s+/, '');
    if (stripped !== first) out[0] = { kind: 'text', text: stripped };
  }
  return out;
}

/** Strip trailing whitespace only (keeps the leading edge intact). */
function trimTrailing(tokens: Token[]): Token[] {
  const out: Token[] = [...tokens];
  while (
    out.length > 0 &&
    out[out.length - 1]!.kind === 'text' &&
    (out[out.length - 1] as { text: string }).text.trim() === ''
  ) {
    out.pop();
  }
  if (out.length > 0 && out[out.length - 1]!.kind === 'text') {
    const last = (out[out.length - 1] as { text: string }).text;
    const stripped = last.replace(/\s+$/, '');
    if (stripped !== last) out[out.length - 1] = { kind: 'text', text: stripped };
  }
  return out;
}

/**
 * Compute the set of tags left open at a raw cut point in a token list.
 * Returns them as `{ name, raw }` in nesting order (outermost first).
 */
function openTagsAt(tokens: Token[], rawCut: number): { name: string; raw: string }[] {
  const stack: { name: string; raw: string }[] = [];
  let raw = 0;
  for (const t of tokens) {
    if (raw >= rawCut) break;
    if (t.kind === 'text') {
      raw += t.text.length;
      continue;
    }
    const end = raw + t.raw.length;
    if (end <= rawCut) {
      if (t.closing) {
        const names = stack.map((s) => s.name);
        const idx = names.lastIndexOf(t.name);
        if (idx >= 0) stack.splice(idx);
      } else if (!VOID.has(t.name)) {
        stack.push({ name: t.name, raw: t.raw });
      }
    }
    raw = end;
  }
  return stack;
}

/**
 * Cut a sanitized body at the first ≤ max visible chars, preferring paragraph
 * boundaries, then sentences, then graphemes. Returns a tag-balanced head and
 * the raw remainder (no part markers). Formatting that spans the boundary is
 * closed at the end of the head and reopened at the start of the rest
 * (plan §10.3 "closes and reopens formatting across the boundary"). Neither
 * edge carries dangling whitespace.
 */
export function cutBodyAtMax(
  body: string,
  max: number,
  locale: string,
): { head: string; rest: string } {
  if (visibleLength(body) <= max) return { head: body, rest: '' };
  const tokens = tokenize(body);
  const model = buildVisibleModel(tokens);
  const cut = chooseBoundary(model, max, locale, true);
  const rawB = rawAt(model, cut);
  const headTokens = trimWhitespace(sliceTokensByRaw(tokens, 0, rawB));
  const head = renderPartsBalanced([headTokens])[0] ?? '';
  const open = openTagsAt(tokens, rawB);
  const reopen = open.map((o) => o.raw).join('');
  const restTokens = trimWhitespace(sliceTokensByRaw(tokens, rawB, rawLength(tokens)));
  return { head, rest: `${reopen}${tokensToString(restTokens)}` };
}

// ---- full split with markers ---------------------------------------------

/**
 * Split a token stream into ≤ max visible chunks (no markers, tag-balanced).
 *
 * Interior cuts slice EXACTLY at the raw boundary — whitespace that sits right
 * at an interior cut (e.g. the space after a sentence terminator) belongs
 * entirely to one side, so the reassembled content is byte-identical to the
 * original. Only the very first part's leading edge and the very last part's
 * trailing edge are trimmed (clean part edges; those whitespace runs are the
 * original body's outer edges, not content between parts).
 */
function splitTokensAtMax(tokens: Token[], max: number, locale: string): string[] {
  const model = buildVisibleModel(tokens);
  if (model.text.length === 0) return [];
  const rawParts: string[] = [];
  let remaining = tokens;
  let restModel = model;
  let rawCursor = 0;
  while (restModel.text.length > 0) {
    const para = paragraphBoundaries(restModel).sort((a, b) => b - a)[0];
    let cut: number;
    if (para !== undefined && para <= max) {
      cut = para;
    } else {
      cut = chooseBoundary(restModel, max, locale, true);
    }
    const rawB = rawAt(restModel, cut);
    if (rawB <= 0) {
      // no progress possible — force a one-code-unit hard cut to avoid an infinite loop
      const one = rawAt(restModel, 1);
      if (one <= 0) break;
      cut = 1;
      const hardTokens = sliceTokensByRaw(tokens, rawCursor, rawCursor + one);
      rawParts.push(...renderPartsBalanced([hardTokens]));
      rawCursor += one;
      remaining = sliceTokensByRaw(tokens, rawCursor, rawLength(tokens));
      restModel = buildVisibleModel(remaining);
      continue;
    }
    // Reopen any formatting left open at the cut (plan §10.3 "closes and
    // reopens formatting across the boundary"), so each part is self-contained.
    const open = openTagsAt(tokens, rawCursor);
    const openTokens: Token[] = open.map((o) => ({
      kind: 'tag',
      name: o.name,
      raw: o.raw,
      closing: false,
    }));
    const chunkTokens = [...openTokens, ...sliceTokensByRaw(tokens, rawCursor, rawCursor + rawB)];
    rawParts.push(...renderPartsBalanced([chunkTokens]));
    rawCursor += rawB;
    remaining = sliceTokensByRaw(tokens, rawCursor, rawLength(tokens));
    restModel = buildVisibleModel(remaining);
  }
  // Trim only the outer edges of the whole part list (see comment above).
  if (rawParts.length > 0) {
    const first = trimLeading(tokenize(rawParts[0]!));
    rawParts[0] = tokensToString(first);
    const last = trimTrailing(tokenize(rawParts[rawParts.length - 1]!));
    rawParts[rawParts.length - 1] = tokensToString(last);
  }
  return rawParts;
}

/**
 * Split a sanitized HTML body into parts, each ≤ `max` visible code units
 * (excluding the part marker), and append `(i/n)` part markers in the channel's
 * numeral system. Returns a single-element array when the body fits.
 */
export function splitBody(
  body: string,
  opts: { max: number; locale: string; numeralSystem: NumeralSystem },
): string[] {
  if (visibleLength(body) <= opts.max) return [body];
  // Marker budget: markers eat into the limit. Iterate to a stable total.
  let budget = opts.max - markerWidth(2, opts.numeralSystem);
  for (let iter = 0; iter < 6; iter++) {
    const rawParts = splitTokensAtMax(tokenize(body), Math.max(1, budget), opts.locale);
    const total = rawParts.length;
    const width = markerWidth(total, opts.numeralSystem);
    if (budget + width <= opts.max || iter === 5) {
      return rawParts.map((part, i) => `${part}${partMarkerText(i + 1, total, opts.numeralSystem)}`);
    }
    budget = opts.max - width;
  }
  return [body];
}

/**
 * Idempotency key (plan §10.5):
 * `sha256(post_id || revision_id || channel_id || part_index)`
 * The key is echoed into the `publish_attempt.idempotency_key` row; the unique
 * index on that column makes a duplicate enqueue fail deterministically before
 * any HTTP call is made.
 */
export function idempotencyKey(
  postId: string,
  revisionId: string,
  channelId: string,
  partIndex: number,
): string {
  return createHash('sha256')
    .update(`${postId}||${revisionId}||${channelId}||${partIndex}`)
    .digest('hex');
}
