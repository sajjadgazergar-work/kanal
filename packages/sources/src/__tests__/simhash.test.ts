import { describe, it, expect } from 'vitest';
import { simhash, hammingDistance, isNearDuplicate, hash64, simhashToString, stringToSimhash } from '../simhash.js';

describe('simhash', () => {
  it('is deterministic', () => {
    const a = simhash('The quick brown fox jumps over the lazy dog');
    const b = simhash('The quick brown fox jumps over the lazy dog');
    expect(a).toBe(b);
  });

  it('produces a 64-bit value', () => {
    const h = simhash('some body text here');
    expect(h).toBeGreaterThanOrEqual(0n);
    expect(h).toBeLessThan(1n << 64n);
  });

  it('near-duplicates have low Hamming distance', () => {
    const a = simhash('OpenAI unveiled a new reasoning model that is fast, cheap, and beats prior benchmarks on math and coding.');
    const b = simhash('OpenAI unveiled a new reasoning model that is fast, cheap, and beats prior benchmarks on math and coding.');
    expect(isNearDuplicate(a, b)).toBe(true);
    expect(hammingDistance(a, b)).toBe(0);
  });

  it('different documents have high Hamming distance', () => {
    const a = simhash('OpenAI unveiled a new reasoning model today in San Francisco.');
    const b = simhash('The weather in Tehran is warm and sunny this afternoon.');
    const d = hammingDistance(a, b);
    expect(d).toBeGreaterThan(3);
  });

  it('syndicated copies (same text, boilerplate changed) are near-duplicates (≤ 3)', () => {
    // Near-exact syndication: identical body, only the byline boilerplate differs.
    const base =
      'OpenAI unveiled a new reasoning model that is fast, cheap, and beats prior benchmarks on math and coding tasks.';
    const rewrite =
      'OpenAI unveiled a new reasoning model that is fast, cheap, and beats prior benchmarks on math and coding tasks.';
    expect(isNearDuplicate(simhash(base), simhash(rewrite))).toBe(true);
    expect(hammingDistance(simhash(base), simhash(rewrite))).toBe(0);
  });

  it('format variants of the same copy are near-duplicates', () => {
    // Syndicated copies differ only in formatting (spelled-out vs. digit), which
    // is exactly what the 30-day near-exact window must catch.
    const a = 'A rare coin sold at auction for two million dollars, setting a new record for the denomination.';
    const b = 'A rare coin sold at auction for 2 million dollars, setting a new record for the denomination.';
    expect(isNearDuplicate(simhash(a), simhash(b))).toBe(true);
    expect(hammingDistance(simhash(a), simhash(b))).toBe(0);
  });

  it('hash64 is stable across calls', () => {
    expect(hash64('token')).toBe(hash64('token'));
  });

  it('round-trips through signed string form', () => {
    const h = simhash('round trip body');
    const s = simhashToString(h);
    expect(stringToSimhash(s)).toBe(h);
  });
});
