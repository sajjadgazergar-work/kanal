import type { PostDraft } from '@kanal/contracts';

/**
 * Formatting correctness (plan §15.2): the rendered HTML must pass the
 * allow-list parser, and the quote budget must not be exceeded.
 *
 * Telegram HTML allow-list (plan §5.1): a, b, blockquote, code, em, i, pre, s,
 * strong, u. Attributes are only allowed where they carry semantic value; any
 * other tag, or an attribute not in the allow-list, fails the parse.
 */

export const ALLOWED_TAGS = new Set(['a', 'b', 'blockquote', 'code', 'em', 'i', 'pre', 's', 'strong', 'u']);
export const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ['href'],
};

export interface FormattingResult {
  score: number;
  ok: boolean;
  errors: string[];
  parsed: string[];
}

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z][a-zA-Z0-9-]*="[^"]*")*)\s*\/?>/g;
const OPEN_RE = /<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g;
const CLOSE_RE = /<\/([a-zA-Z][a-zA-Z0-9-]*)>/g;

export function parseHtmlTags(html: string): { tag: string; attrs: string[]; closing: boolean }[] {
  const out: { tag: string; attrs: string[]; closing: boolean }[] = [];
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html)) !== null) {
    const attrs: string[] = [];
    const raw = m[2] ?? '';
    const am = raw.matchAll(/\s+([a-zA-Z][a-zA-Z0-9-]*)="[^"]*"/g);
    for (const a of am) {
      const name = a[1];
      if (name) attrs.push(name);
    }
    out.push({ tag: (m[1] ?? '').toLowerCase(), attrs, closing: isClosingTag(html, m.index) });
  }
  return out;
}

function isClosingTag(html: string, index: number): boolean {
  return html[index] === '<' && html[index + 1] === '/';
}

/**
 * Validate an HTML string against the allow-list.
 *  - every tag is in ALLOWED_TAGS
 *  - every attribute is allowed on its tag
 *  - tags are balanced (each open has a matching close)
 */
export function validateHtml(html: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  const opens = new Map<string, number>();
  const closes = new Map<string, number>();
  let m: RegExpExecArray | null;

  OPEN_RE.lastIndex = 0;
  while ((m = OPEN_RE.exec(html)) !== null) {
    const tag = (m[1] ?? '').toLowerCase();
    opens.set(tag, (opens.get(tag) ?? 0) + 1);
  }
  CLOSE_RE.lastIndex = 0;
  while ((m = CLOSE_RE.exec(html)) !== null) {
    const tag = (m[1] ?? '').toLowerCase();
    closes.set(tag, (closes.get(tag) ?? 0) + 1);
  }

  for (const tag of new Set([...opens.keys(), ...closes.keys()])) {
    if (!ALLOWED_TAGS.has(tag)) {
      errors.push(`tag <${tag}> is not in the allow-list`);
    }
    const openCount = opens.get(tag) ?? 0;
    const closeCount = closes.get(tag) ?? 0;
    if (openCount !== closeCount) {
      errors.push(`tag <${tag}> is not balanced (${openCount} open, ${closeCount} close)`);
    }
  }

  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html)) !== null) {
    const tag = (m[1] ?? '').toLowerCase();
    if (isClosingTag(html, m.index)) continue;
    const allowed = ALLOWED_ATTRS[tag] ?? [];
    const raw = m[2] ?? '';
    const am = raw.matchAll(/\s+([a-zA-Z][a-zA-Z0-9-]*)="[^"]*"/g);
    for (const a of am) {
      const name = a[1];
      if (name && !allowed.includes(name)) errors.push(`attribute "${name}" not allowed on <${tag}>`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function evaluateFormatting(
  post: PostDraft,
  opts?: {
    html?: string;
    quoteBudgetOk?: boolean;
    quoteBudgetErrors?: string[];
  },
): FormattingResult {
  const html = opts?.html ?? '';
  const errors: string[] = [];
  const parsed: string[] = [];

  if (html) {
    const v = validateHtml(html);
    if (!v.ok) errors.push(...v.errors);
    if (v.ok) parsed.push(...ALLOWED_TAGS);
  }

  if (opts?.quoteBudgetOk === false) {
    errors.push(...(opts.quoteBudgetErrors ?? ['quote budget exceeded']));
  }

  return { score: errors.length === 0 ? 1 : 0, ok: errors.length === 0, errors, parsed };
}
