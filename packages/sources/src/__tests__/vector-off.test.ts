import { describe, it, expect, beforeEach } from 'vitest';
import { vectorMode, vectorsEnabled, retrievalSearch, dedupFallbackMatch } from '../vectorMode.js';
import { processItems } from '../pipeline.js';
import { simhashToString, simhash } from '../simhash.js';
import { TITLE_TRIGRAM_THRESHOLD } from '../trigram.js';
import { NOW } from './helpers.js';

describe('KANAL_VECTOR=off mode', () => {
  beforeEach(() => {
    delete process.env.KANAL_VECTOR;
  });

  it('is off when the env var is set', () => {
    process.env.KANAL_VECTOR = 'off';
    expect(vectorMode(process.env)).toBe('off');
    expect(vectorsEnabled(process.env)).toBe(false);
  });

  it('is on by default', () => {
    expect(vectorMode(process.env)).toBe('on');
    expect(vectorsEnabled(process.env)).toBe(true);
  });

  it('dedup falls back to simhash + trigram (no embeddings)', () => {
    process.env.KANAL_VECTOR = 'off';
    const body = 'OpenAI unveiled a new reasoning model that is fast, cheap, and beats prior benchmarks on math and coding.';
    const nearBody = 'OpenAI unveiled a new reasoning model that is fast, cheap, and beats prior benchmarks on math and coding.';
    const candidates = [
      { title: 'OpenAI unveils new reasoning model', simhash: simhashToString(simhash(body)), firstSeenAt: new Date(NOW.getTime() - 3600000) },
    ];
    const matches = dedupFallbackMatch(
      { title: 'OpenAI unveils new reasoning model', simhash: simhashToString(simhash(nearBody)) },
      candidates,
      NOW,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(['near_exact', 'semantic']).toContain(matches[0]!.layer);
  });

  it('retrieval falls back to trigram + recency', () => {
    process.env.KANAL_VECTOR = 'off';
    const items = processItems(
      [
        { rawUrl: 'https://example.test/a', title: 'Postgres 17 released with performance improvements', bodyText: 'Postgres 17 ships today.', publishedAt: NOW },
        { rawUrl: 'https://example.test/b', title: 'Gardening in autumn', bodyText: 'Leaves are falling.', publishedAt: NOW },
      ],
      { now: NOW },
    );
    const results = retrievalSearch({ title: 'Postgres 17 Released Performance Improvements' }, items, false);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.item.rawUrl).toBe('https://example.test/a');
    expect(results[0]!.basis).toBe('trigram');
  });

  it('embedding cosine is ignored when vectors are off', () => {
    process.env.KANAL_VECTOR = 'off';
    const items = processItems(
      [{ rawUrl: 'https://example.test/c', title: 'Unrelated title', bodyText: 'something else entirely here', publishedAt: NOW }],
      { now: NOW },
    );
    const results = retrievalSearch(
      { title: 'Totally unrelated query', embeddingCosine: 0.99 }, // high cosine but vectors off
      items,
      false,
    );
    // No trigram match → basis stays recency, score below the cosine-driven bar
    expect(results[0]!.basis).toBe('recency');
    expect(results[0]!.score).toBeLessThan(1);
  });

  it('processItems reports vectorsOn: false in vector-off mode', () => {
    process.env.KANAL_VECTOR = 'off';
    const [item] = processItems([{ rawUrl: 'https://example.test/d', bodyText: 'x', title: 'y' }], { now: NOW });
    expect(item.vectorsOn).toBe(false);
  });

  it('trigram threshold constant is 0.85', () => {
    expect(TITLE_TRIGRAM_THRESHOLD).toBe(0.85);
  });
});
