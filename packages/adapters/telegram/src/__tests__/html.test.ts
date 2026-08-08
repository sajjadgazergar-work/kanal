import { describe, expect, it } from 'vitest';
import { sanitizeHtml, validateTag, escapeHtml } from '../html.js';

/**
 * HTML allow-list parser tests (plan D5 / §10.3).
 *
 * The allow list is: b i u s span[class=tg-spoiler] a[href] code pre
 * blockquote tg-emoji (plus br). Anything else is escaped, not stripped.
 */

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x">' & "`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39; &amp; &quot;');
  });

  it('preserves existing entity references (no double-escaping)', () => {
    expect(escapeHtml('A &amp; B')).toBe('A &amp; B');
    expect(escapeHtml('&lt;b&gt;')).toBe('&lt;b&gt;');
  });
});

describe('validateTag', () => {
  it('accepts the allow-listed tags', () => {
    expect(validateTag('<b>')).toBe('<b>');
    expect(validateTag('<i>')).toBe('<i>');
    expect(validateTag('<u>')).toBe('<u>');
    expect(validateTag('<s>')).toBe('<s>');
    expect(validateTag('<code>')).toBe('<code>');
    expect(validateTag('<pre>')).toBe('<pre>');
    expect(validateTag('<blockquote>')).toBe('<blockquote>');
  });

  it('rejects br (not in the §10.3 allow list)', () => {
    expect(validateTag('<br>')).toBeNull();
    expect(validateTag('<br/>')).toBeNull();
  });

  it('accepts span only with class="tg-spoiler"', () => {
    expect(validateTag('<span class="tg-spoiler">')).toBe('<span class="tg-spoiler">');
    expect(validateTag('<span>')).toBeNull();
    expect(validateTag('<span class="x">')).toBeNull();
  });

  it('accepts a[href] only with a real http(s)/tg link', () => {
    expect(validateTag('<a href="https://example.com">')).toBe('<a href="https://example.com">');
    expect(validateTag('<a href="http://example.com">')).toBe('<a href="http://example.com">');
    expect(validateTag('<a href="tg://resolve?domain=x">')).toBe('<a href="tg://resolve?domain=x">');
    expect(validateTag('<a href="javascript:alert(1)">')).toBeNull();
    expect(validateTag('<a>')).toBeNull();
    expect(validateTag('<a href="data:text/html,x">')).toBeNull();
  });

  it('accepts tg-emoji only with an emoji-id', () => {
    expect(validateTag('<tg-emoji emoji-id="5368324170671202286">')).toBe(
      '<tg-emoji emoji-id="5368324170671202286">',
    );
    expect(validateTag('<tg-emoji>')).toBeNull();
    expect(validateTag('<tg-emoji emoji-id="abc">')).toBeNull();
  });

  it('rejects disallowed tags', () => {
    expect(validateTag('<script>')).toBeNull();
    expect(validateTag('<iframe>')).toBeNull();
    expect(validateTag('<img>')).toBeNull();
    expect(validateTag('<div>')).toBeNull();
    expect(validateTag('<h1>')).toBeNull();
  });

  it('rejects a tag with a disallowed attribute', () => {
    expect(validateTag('<b onclick="x">')).toBeNull();
    expect(validateTag('<a href="https://x" style="color:red">')).toBeNull();
    expect(validateTag('<code data-x="1">')).toBeNull();
  });

  it('rejects a tag with a bare attribute', () => {
    expect(validateTag('<a href="https://x" target>')).toBeNull();
  });

  it('rejects malformed constructs', () => {
    expect(validateTag('< b >')).toBeNull();
    expect(validateTag('<<b>')).toBeNull();
    expect(validateTag('<b')).toBeNull();
    expect(validateTag('<a href="unterminated>')).toBeNull();
  });

  it('accepts closing tags', () => {
    expect(validateTag('</b>')).toBe('</b>');
    expect(validateTag('</span>')).toBe('</span>');
    expect(validateTag('</tg-emoji>')).toBe('</tg-emoji>');
  });
});

describe('sanitizeHtml', () => {
  it('passes through allow-listed markup unchanged', () => {
    const input = '<b>bold</b> <i>italic</i> <a href="https://x.example">link</a>';
    expect(sanitizeHtml(input)).toBe(input);
  });

  it('escapes disallowed tags rather than stripping them', () => {
    const input = '<script>alert(1)</script>';
    expect(sanitizeHtml(input)).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes a bare < in prose (the code-sample survival case, plan D5)', () => {
    expect(sanitizeHtml('x < y')).toBe('x &lt; y');
    expect(sanitizeHtml('1 < 2 and 3 > 2')).toBe('1 &lt; 2 and 3 &gt; 2');
  });

  it('strips attributes not on the allow list', () => {
    expect(sanitizeHtml('<a href="https://x" onmouseover="evil">')).toBe(
      '&lt;a href=&quot;https://x&quot; onmouseover=&quot;evil&quot;&gt;',
    );
  });

  it('handles nested tags and content', () => {
    const input = '<b>a <i>nested</i> b</b>';
    expect(sanitizeHtml(input)).toBe(input);
  });

  it('escapes a malformed tag construct', () => {
    // `< b >` is not a valid tag (space after <); it must be escaped.
    expect(sanitizeHtml('< b >text')).toBe('&lt; b &gt;text');
    // `<b` without `>` is not a complete construct; escaped.
    expect(sanitizeHtml('x <b')).toBe('x &lt;b');
  });

  it('keeps tg-spoiler and tg-emoji', () => {
    const input = '<span class="tg-spoiler">secret</span> <tg-emoji emoji-id="5368324170671202286">😀</tg-emoji>';
    expect(sanitizeHtml(input)).toBe(input);
  });

  it('preserves entity refs in text', () => {
    // The sanitizer output is itself HTML; an existing &amp; must be preserved.
    expect(sanitizeHtml('A &amp; B')).toBe('A &amp; B');
  });

  it('escapes a real & that is not part of an entity', () => {
    expect(sanitizeHtml('A & B')).toBe('A &amp; B');
  });

  it('handles a quote inside a tag value', () => {
    const input = '<a href="https://x.example">it\'s</a>';
    expect(sanitizeHtml(input)).toBe('<a href="https://x.example">it&#39;s</a>');
  });
});
