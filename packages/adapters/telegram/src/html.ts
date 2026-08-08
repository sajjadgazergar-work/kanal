/**
 * Telegram HTML allow-list markup (plan D5, §10.3).
 *
 * The markup decision is HTML. MarkdownV2 is rejected because its escape set
 * collides with Persian/Arabic punctuation, and raw entity arrays are rejected
 * because entity offsets are UTF-16 code units (off-by-N emoji bugs).
 *
 * HTML is validated by a STRICT allow-list parser before send:
 *
 *   b i u s span[class=tg-spoiler] a[href] code pre blockquote tg-emoji
 *
 * Anything else is ESCAPED, not stripped — a `<` in a code sample survives as
 * `&lt;`, which is what makes the parser safe to run over model-written text.
 * An attacker cannot smuggle a script tag or an unvalidated attribute because
 * neither parses to an allowed construct.
 *
 * Input is assumed to be well-formed markup already (the renderer produces it);
 * the parser's job is to prove it, not to repair it. Malformed constructs are
 * escaped verbatim so the rendered text is never a 400 waiting to happen.
 */

/** Allowed paired tags and the attributes each may carry. */
const ALLOWED_TAGS: Record<string, { attrs: Record<string, { required?: boolean }> }> = {
  b: { attrs: {} },
  i: { attrs: {} },
  u: { attrs: {} },
  s: { attrs: {} },
  span: { attrs: { class: { required: true } } },
  a: { attrs: { href: { required: true } } },
  code: { attrs: {} },
  pre: { attrs: {} },
  blockquote: { attrs: {} },
  'tg-emoji': { attrs: { 'emoji-id': { required: true } } },
};

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** A valid entity reference: `&amp;`, `&#123;`, `&#x1F600;`, `&lt;`, … */
const ENTITY_RE = /&(?:#[0-9]{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/**
 * Escape HTML metacharacters so raw text can never be misread as markup.
 * Existing entity references are preserved (never double-escaped): the renderer
 * may legitimately produce `&amp;` for a literal `&`, and re-escaping it would
 * corrupt the output.
 */
export function escapeHtml(s: string): string {
  let out = '';
  let i = 0;
  let m: RegExpExecArray | null;
  ENTITY_RE.lastIndex = 0;
  while ((m = ENTITY_RE.exec(s))) {
    out += s.slice(i, m.index).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
    out += m[0];
    i = m.index + m[0].length;
  }
  out += s.slice(i).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
  return out;
}

/** A rich token used by the splitter. */
export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'tag'; name: string; closing: boolean; raw: string };

const TAG_RE = /^<\/?([a-zA-Z][a-zA-Z0-9_-]*)/;

/**
 * Tokenize a sanitized body into text runs and tag constructs.
 * Only called on sanitized output, so tags are canonical and well-formed.
 */
export function tokenize(sanitized: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sanitized.length) {
    const lt = sanitized.indexOf('<', i);
    if (lt === -1) {
      if (i < sanitized.length) tokens.push({ kind: 'text', text: sanitized.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ kind: 'text', text: sanitized.slice(i, lt) });
    // find the closing '>' that ends the construct, honoring quoted attrs
    let gt = lt + 1;
    let quote: '"' | "'" | null = null;
    for (; gt < sanitized.length; gt++) {
      const c = sanitized[gt];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
    }
    if (gt >= sanitized.length) {
      tokens.push({ kind: 'text', text: sanitized.slice(lt) });
      break;
    }
    const raw = sanitized.slice(lt, gt + 1);
    const m = raw.match(TAG_RE);
    const name = m ? m[1]!.toLowerCase() : '';
    const closing = raw.startsWith('</');
    tokens.push({ kind: 'tag', name, closing, raw });
    i = gt + 1;
  }
  return tokens;
}

/** Reads a quoted attribute value. Returns null on malformed input. */
function readAttrValue(raw: string): string | null {
  if (raw.length < 2) return null;
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) return null;
  const inner = raw.slice(1, -1);
  if (/[<>\n\r]/.test(inner)) return null;
  return inner;
}

/**
 * Validate a single `<...>` construct against the allow list.
 * Returns the canonical re-rendered tag, or `null` when the construct must be
 * escaped because it is not an allowed tag, uses a disallowed attribute, or is
 * malformed.
 */
export function validateTag(tagText: string): string | null {
  const m = tagText.match(/^<\/?([a-zA-Z][a-zA-Z0-9_-]*)([^>]*?)\/?>$/);
  if (!m) return null;
  const name = (m[1] ?? '').toLowerCase();
  const rawAttrs = m[2] ?? '';
  const isClosing = tagText.startsWith('</');

  if (isClosing) {
    if (!(name in ALLOWED_TAGS)) return null;
    if (rawAttrs.trim() !== '') return null;
    return `</${name}>`;
  }

  const def = ALLOWED_TAGS[name];
  if (!def) return null;

  // Parse attributes: attr="value" pairs; bare attrs are rejected.
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*("[^"]*"|'[^']*')/g;
  let m2: RegExpExecArray | null;
  let consumed = 0;
  let bad = false;
  while ((m2 = re.exec(rawAttrs))) {
    const key = (m2[1] ?? '').toLowerCase();
    const val = readAttrValue(m2[2] ?? '');
    if (val === null) {
      bad = true;
      break;
    }
    attrs[key] = val;
    consumed = re.lastIndex;
  }
  // Reject any trailing garbage (bare attrs, stray chars) after the last match.
  const trailing = rawAttrs.slice(consumed).trim();
  if (bad || trailing !== '') return null;

  // Enforce the attribute allow list.
  for (const attrKey of Object.keys(attrs)) {
    if (!def.attrs[attrKey]) return null;
  }
  for (const [attrKey, spec] of Object.entries(def.attrs)) {
    if (spec.required && attrs[attrKey] === undefined) return null;
  }

  // Attribute value validation.
  if (name === 'a') {
    const href = attrs['href'] ?? '';
    if (!/^https?:\/\//.test(href) && !href.startsWith('tg://')) return null;
    if (/[\s'"<>]/.test(href)) return null;
  }
  if (name === 'span') {
    if (attrs['class'] !== 'tg-spoiler') return null;
  }
  if (name === 'tg-emoji') {
    if (!/^[0-9]+$/.test(attrs['emoji-id'] ?? '')) return null;
  }

  const attrsOut = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join('');
  return `<${name}${attrsOut}>`;
}

/**
 * Sanitize a Telegram-HTML body through the strict allow list.
 *
 * Walk the input, classify each `<...>` construct via `validateTag`, and emit:
 *   - the canonical tag when valid,
 *   - `&lt;`-escaped text when invalid or malformed,
 * and escape all remaining text content. The result is safe to pass to
 * `sendMessage(parse_mode='HTML')`.
 */
export function sanitizeHtml(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      out += escapeHtml(input.slice(i));
      break;
    }
    out += escapeHtml(input.slice(i, lt));
    // find the construct end, honoring quoted attributes
    let gt = lt + 1;
    let quote: '"' | "'" | null = null;
    for (; gt < input.length; gt++) {
      const c = input[gt];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
    }
    const candidate = input.slice(lt, Math.min(gt + 1, input.length));
    const validated = gt < input.length ? validateTag(candidate) : null;
    if (validated) {
      out += validated;
    } else {
      out += escapeHtml(candidate);
    }
    i = gt + 1;
  }
  return out;
}
