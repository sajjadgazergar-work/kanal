import { describe, expect, it } from 'vitest';
import { longestCommonSubstring } from '../lcs.js';

describe('longestCommonSubstring', () => {
  it('finds the common substring', () => {
    const r = longestCommonSubstring('the quick brown fox', 'a quick brown cat');
    const sub = 'the quick brown fox'.slice(r.aStart, r.aStart + r.len);
    expect(sub).toBe(' quick brown ');
    expect(r.len).toBe(13);
    // both strings contain the same substring at the reported offsets
    expect('a quick brown cat'.slice(r.bStart, r.bStart + r.len)).toBe(sub);
  });

  it('handles empty strings', () => {
    expect(longestCommonSubstring('', 'abc').len).toBe(0);
    expect(longestCommonSubstring('abc', '').len).toBe(0);
    expect(longestCommonSubstring('', '').len).toBe(0);
  });

  it('handles no common substring', () => {
    expect(longestCommonSubstring('xyz', 'abc').len).toBe(0);
  });

  it('handles identical strings', () => {
    const r = longestCommonSubstring('hello world', 'hello world');
    expect(r.len).toBe(11);
  });

  it('handles Unicode (Persian)', () => {
    const a = 'پهنای باند حافظه ۱٫۲ ترابایت بر ثانیه';
    const b = 'پهنای باند حافظه ۱٫۲ ترابایت';
    const r = longestCommonSubstring(a, b);
    expect(r.len).toBeGreaterThan(10);
    expect(a.slice(r.aStart, r.aStart + r.len)).toBe(b.slice(r.bStart, r.bStart + r.len));
  });
});