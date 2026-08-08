import { describe, expect, it } from 'vitest';
import {
  expandPseudo,
  pseudoRatio,
  pseudoTranslate,
  pseudoDirection,
  escapeHtml,
} from '../pseudo.js';

describe('en-XA pseudo-locale', () => {
  it('expands strings to at least 40% longer', () => {
    const samples = [
      'Today',
      'Queue',
      'Settings',
      'Approve run 01J8Z and move to publishing',
      'Something went wrong. Please try again.',
      'Persian numerals apply to displayed counts and dates',
    ];
    for (const s of samples) {
      const ratio = pseudoRatio(s);
      expect(ratio, `"${s}" ratio ${ratio}`).toBeGreaterThanOrEqual(1.4);
    }
  });

  it('expands and reverses direction for screenshot tests', () => {
    expect(pseudoDirection()).toBe('rtl');
    const out = pseudoTranslate('Queue');
    expect(out.length).toBeGreaterThan('Queue'.length);
  });

  it('doubles Latin letters and leaves spaces/punctuation intact', () => {
    expect(expandPseudo('a b')).toBe('aá bƀ');
  });

  it('escapes HTML so the pseudo string is embeddable', () => {
    expect(escapeHtml('<a & b>')).toBe('&lt;a &amp; b&gt;');
  });

  it('does not expand non-Latin text (untranslated strings stay obvious)', () => {
    expect(expandPseudo('فارسی')).toBe('فارسی');
  });
});
