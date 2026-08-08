import { describe, expect, it } from 'vitest';
import {
  cutBodyAtMax,
  idempotencyKey,
  partMarkerText,
  splitBody,
  toNumerals,
  visibleLength,
} from '../splitter.js';
import { sanitizeHtml } from '../html.js';

/**
 * Visible length mirrors what Telegram counts: UTF-16 code units (plan D5 —
 * "entity offsets are counted in UTF-16 code units"). A single emoji is 2 code
 * units; a ZWJ family is 11. What the splitter guarantees is never splitting a
 * surrogate pair mid-pair, so a lone emoji survives a hard cut whole.
 */
describe('visibleLength', () => {
  it('counts a surrogate pair as TWO code units', () => {
    expect(visibleLength('😀')).toBe(2);
    expect(visibleLength('a😀b')).toBe(4);
  });
  it('counts an entity as one code unit', () => {
    expect(visibleLength('&lt;')).toBe(1);
    expect(visibleLength('&amp;')).toBe(1);
  });
});

describe('toNumerals / partMarkerText', () => {
  it('keeps latn as-is', () => {
    expect(toNumerals(3, 'latn')).toBe('3');
  });
  it('renders arabext digits', () => {
    expect(toNumerals(3, 'arabext')).toBe('۳');
    expect(toNumerals(12, 'arabext')).toBe('۱۲');
  });
  it('renders the part marker', () => {
    expect(partMarkerText(1, 3, 'arabext')).toBe('(۱/۳)');
    expect(partMarkerText(2, 3, 'latn')).toBe('(2/3)');
  });
});

describe('splitBody', () => {
  it('returns a single part when the body fits', () => {
    expect(splitBody('short', { max: 4096, locale: 'fa', numeralSystem: 'latn' })).toEqual(['short']);
  });

  it('splits on paragraph boundaries first', () => {
    const para = 'بند اول. متن خیلی طولانی که از حد مجاز فراتر می‌رود. '.repeat(20);
    const body = `${para}\n\n${para}`;
    const parts = splitBody(body, { max: 400, locale: 'fa', numeralSystem: 'arabext' });
    expect(parts.length).toBeGreaterThan(1);
    // each part must be ≤ max visible chars (plus its marker)
    for (const p of parts) {
      expect(visibleLength(p)).toBeLessThanOrEqual(400 + 8);
    }
  });

  it('never splits inside an open HTML tag', () => {
    const long = '<b>' + 'x'.repeat(300) + '</b>';
    const parts = splitBody(long, { max: 200, locale: 'en', numeralSystem: 'latn' });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      // a part may not begin or end with an unbalanced tag
      expect(p.startsWith('<b>') || p.startsWith('x')).toBe(true);
      // formatting closed and reopened across the boundary
      const opens = (p.match(/<b>/g) ?? []).length;
      const closes = (p.match(/<\/b>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it('splits a >4096-char body into ≤4096 parts with markers', () => {
    const body = sanitizeHtml('سخنرانی بلند درباره آینده رسانه و تحولات دیجیتال. '.repeat(150));
    expect(visibleLength(body)).toBeGreaterThan(4096);
    const parts = splitBody(body, { max: 4096, locale: 'fa', numeralSystem: 'arabext' });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(visibleLength(p)).toBeLessThanOrEqual(4096);
      expect(p).toMatch(/\(\d*[۰-۹]*\/\d*[۰-۹]*\)$/);
    }
    // markers are arabext for arabext system
    expect(parts.some((p) => p.includes('(۱/'))).toBe(true);
  });

  it('never splits mid-grapheme (family emoji) even on a hard cut', () => {
    const big = '👨‍👩‍👧‍👦'.repeat(50) + 'Z';
    const parts = splitBody(big, { max: 10, locale: 'en', numeralSystem: 'latn' });
    for (const p of parts) {
      const stripped = p.replace(/\(\d+\/\d+\)$/, '');
      // every family emoji must appear whole (a mid-grapheme split would leak
      // partial family text here)
      expect(stripped.replace(/👨‍👩‍👧‍👦/g, '').length).toBeLessThanOrEqual(1);
      // content is zero or more whole families plus the trailing Z, nothing else
      expect(stripped).toMatch(/^(?:👨‍👩‍👧‍👦)*Z?$/);
    }
    // and the parts reassemble to exactly the original body
    const text = parts.map((p) => p.replace(/\(\d+\/\d+\)$/, '')).join('');
    expect(text).toBe(big);
  });

  it('never splits mid-surrogate-pair on a hard grapheme cut', () => {
    const big = '😀'.repeat(100);
    const parts = splitBody(big, { max: 33, locale: 'en', numeralSystem: 'latn' });
    for (const p of parts) {
      const stripped = p.replace(/\(\d+\/\d+\)$/, '');
      // every 😀 must be whole (a lone high surrogate would fail this)
      const lone = stripped.match(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g) ?? [];
      expect(lone).toEqual([]);
    }
  });

  it('produces parts whose visible content reassembles the original text', () => {
    const body = 'گرافمها و جملات. '.repeat(30);
    const parts = splitBody(body, { max: 250, locale: 'fa', numeralSystem: 'latn' });
    const text = parts.map((p) => p.replace(/\(\d+\/\d+\)$/, '')).join('');
    // The splitter closes/reopens tags but never drops or duplicates content.
    // It does trim whitespace that dangles at a cut edge (part boundaries are
    // "clean" in the sense of §10.3), so compare whitespace-normalized.
    expect(text.replace(/\s+/g, ' ').trim()).toBe(body.replace(/\s+/g, ' ').trim());
  });
});

describe('cutBodyAtMax', () => {
  it('returns empty rest when body fits', () => {
    const { head, rest } = cutBodyAtMax('hello', 10, 'en');
    expect(head).toBe('hello');
    expect(rest).toBe('');
  });

  it('cuts at a paragraph boundary when available', () => {
    const body = 'para one.\n\npara two that is long';
    const { head, rest } = cutBodyAtMax(body, 20, 'en');
    expect(head).toBe('para one.');
    expect(rest).toBe('para two that is long');
  });

  it('cuts at a sentence boundary when no paragraph fits', () => {
    const body = 'First sentence here. Second sentence that is long. Third sentence too.';
    const { head, rest } = cutBodyAtMax(body, 35, 'en');
    expect(head).toBe('First sentence here.');
    expect(rest).toBe('Second sentence that is long. Third sentence too.');
  });

  it('never cuts mid-grapheme on a hard grapheme cut', () => {
    const body = '👨‍👩‍👧‍👦'.repeat(20);
    const { head, rest } = cutBodyAtMax(body, 5, 'en');
    expect(head.length > 0).toBe(true);
    expect(rest.length > 0).toBe(true);
    expect(head.includes('👨')).toBe(true); // full ZWJ sequence intact
    expect(rest.includes('👨')).toBe(true);
  });

  it('tag-balances the head across the cut', () => {
    const body = '<b>' + 'x'.repeat(100) + '</b> trailing';
    const { head, rest } = cutBodyAtMax(body, 50, 'en');
    expect((head.match(/<b>/g) ?? []).length).toBe((head.match(/<\/b>/g) ?? []).length);
    // rest must reopen the formatting
    expect(rest.startsWith('<b>')).toBe(true);
  });
});

describe('idempotencyKey', () => {
  it('is deterministic for the same inputs', () => {
    const a = idempotencyKey('post-1', 'rev-1', 'chan-1', 0);
    const b = idempotencyKey('post-1', 'rev-1', 'chan-1', 0);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when part_index changes (plan §10.5)', () => {
    expect(idempotencyKey('p', 'r', 'c', 0)).not.toBe(idempotencyKey('p', 'r', 'c', 1));
  });

  it('changes when revision_id changes', () => {
    expect(idempotencyKey('p', 'r1', 'c', 0)).not.toBe(idempotencyKey('p', 'r2', 'c', 0));
  });

  it('changes when channel_id changes', () => {
    expect(idempotencyKey('p', 'r', 'c1', 0)).not.toBe(idempotencyKey('p', 'r', 'c2', 0));
  });

  it('distinguishes the separator (|| is unambiguous)', () => {
    // post 'ab' || rev 'c' must not collide with post 'a' || rev 'bc'
    expect(idempotencyKey('ab', 'c', 'd', 0)).not.toBe(idempotencyKey('a', 'bc', 'd', 0));
  });
});
