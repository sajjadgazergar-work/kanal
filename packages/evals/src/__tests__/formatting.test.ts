import { describe, expect, it } from 'vitest';
import { validateHtml, ALLOWED_TAGS, evaluateFormatting } from '../formatting.js';
import type { PostDraft } from '@kanal/contracts';

const post: PostDraft = { bodyMd: 'x', claimMap: {}, allowedUrls: [] };

describe('formatting correctness (plan §15.2)', () => {
  it('accepts only allow-list tags', () => {
    expect(ALLOWED_TAGS.has('b')).toBe(true);
    expect(ALLOWED_TAGS.has('a')).toBe(true);
    expect(ALLOWED_TAGS.has('p')).toBe(false);
    expect(ALLOWED_TAGS.has('div')).toBe(false);
  });

  it('passes valid Telegram HTML', () => {
    const html = '<b>bold</b> <a href="https://example.com">link</a> <code>code</code>';
    const r = validateHtml(html);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects a disallowed tag', () => {
    const html = '<p>paragraph</p><b>bold</b>';
    const r = validateHtml(html);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('<p>'))).toBe(true);
  });

  it('rejects an unallowed attribute', () => {
    const html = '<a class="x" href="https://example.com">link</a>';
    const r = validateHtml(html);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('class'))).toBe(true);
  });

  it('rejects unbalanced tags', () => {
    const html = '<b>unclosed';
    const r = validateHtml(html);
    expect(r.ok).toBe(false);
  });

  it('fails when the quote budget is exceeded', () => {
    const r = evaluateFormatting(post, { html: '<b>x</b>', quoteBudgetOk: false, quoteBudgetErrors: ['quote budget exceeded'] });
    expect(r.ok).toBe(false);
    expect(r.score).toBe(0);
  });
});