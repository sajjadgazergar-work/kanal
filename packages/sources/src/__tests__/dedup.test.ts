import { describe, it, expect } from 'vitest';
import { findDuplicate, dedupAssignCluster, NEAR_EXACT_WINDOW_MS, SEMANTIC_WINDOW_MS, SIMHASH_HAMMING_THRESHOLD } from '../dedup.js';
import { simhash, simhashToString } from '../simhash.js';
import { vectorModeEnabled } from '../dedup.js';
import { NOW } from './helpers.js';

const body =
  'A rare coin sold at auction for two million dollars, setting a new record for the denomination.';
const nearBody =
  'A rare coin sold at auction for 2 million dollars, setting a new record for the denomination.';

function candidate(id: string, text: string, title: string, opts: { daysAgo?: number; trust?: number; clusterId?: string | null } = {}) {
  const firstSeenAt = new Date(NOW.getTime() - (opts.daysAgo ?? 0) * 86400000);
  return {
    id,
    simhash: simhashToString(simhash(text)),
    title,
    bodyText: text,
    firstSeenAt,
    trustScore: opts.trust ?? 50,
    clusterId: opts.clusterId ?? null,
  };
}

/** Flip exactly `n` low bits of a simhash so the Hamming distance from the
 * original is `n` (1–3 stays inside the near-exact band, ≥ 4 falls outside). */
function nearSimhash(text: string, flipBits: number): string {
  const h = simhash(text);
  let flipped = h;
  for (let i = 0; i < flipBits; i++) {
    flipped ^= 1n << BigInt(i);
  }
  return simhashToString(flipped);
}

describe('findDuplicate — three layers', () => {
  it('detects an exact duplicate (same simhash)', () => {
    const index = [candidate('a', body, 'Title A')];
    const verdict = findDuplicate({ simhash: simhashToString(simhash(body)), title: 'Title A', vectorsOn: false }, index, NOW);
    expect(verdict.layer).toBe('exact');
    expect(verdict.matchId).toBe('a');
  });

  it('detects near-duplicates by simhash within the 30-day window', () => {
    const index = [candidate('a', body, 'Title A')];
    // Hamming distance 2 — inside the ≤ 3 band.
    const verdict = findDuplicate({ simhash: nearSimhash(body, 2), title: 'Title A variant', vectorsOn: false }, index, NOW);
    expect(verdict.layer).toBe('near_exact');
    expect(verdict.matchId).toBe('a');
  });

  it('ignores near-duplicates outside the 30-day window', () => {
    const index = [candidate('a', body, 'Title A', { daysAgo: 31 })];
    const verdict = findDuplicate({ simhash: nearSimhash(body, 2), title: 'Title B', vectorsOn: false }, index, NOW);
    expect(verdict.layer).toBe('none');
  });

  it('rejects a candidate whose simhash is a different document (Hamming > 3)', () => {
    const index = [candidate('a', body, 'Title A')];
    // Hamming distance 5 — well outside the ≤ 3 band.
    const verdict = findDuplicate({ simhash: nearSimhash(body, 5), title: 'Unrelated', vectorsOn: false }, index, NOW);
    expect(verdict.layer).toBe('none');
  });

  it('detects semantic dupes by title trigram within the 72-hour window', () => {
    const index = [candidate('a', 'unrelated body text entirely', 'Postgres 17 released with performance improvements', { daysAgo: 1 })];
    const verdict = findDuplicate(
      { simhash: simhashToString(simhash('different body')), title: 'Postgres 17 Released with Performance Improvements', vectorsOn: false },
      index,
      NOW,
    );
    expect(verdict.layer).toBe('semantic');
    expect(verdict.basis).toBe('trigram');
  });

  it('ignores semantic dupes outside the 72-hour window', () => {
    const index = [candidate('a', 'unrelated body text entirely', 'Postgres 17 released with performance improvements', { daysAgo: 4 })];
    const verdict = findDuplicate(
      { simhash: simhashToString(simhash('different body')), title: 'Postgres 17 Released with Performance Improvements', vectorsOn: false },
      index,
      NOW,
    );
    expect(verdict.layer).toBe('none');
  });

  it('honours embedding cosine only when vectors are on', () => {
    // The caller precomputes the cosine between the query embedding and each
    // candidate embedding and attaches it to the candidate record.
    const index = [{ ...candidate('a', 'unrelated body', 'A title that is unrelated to the query', { daysAgo: 1 }), embeddingCosine: 0.95 }];
    const query = { simhash: simhashToString(simhash('whatever')), title: 'Completely Different Title', vectorsOn: true };
    // vectors on: cosine ≥ 0.92 triggers semantic match
    const verdictOn = findDuplicate(query, index, NOW);
    expect(verdictOn.layer).toBe('semantic');
    expect(verdictOn.basis).toBe('cosine');
    // vectors off: same query, no match
    const verdictOff = findDuplicate({ ...query, vectorsOn: false }, index, NOW);
    expect(verdictOff.layer).toBe('none');
  });
});

describe('cluster assignment', () => {
  it('assigns an existing cluster id to a witness', () => {
    const index = [candidate('a', body, 'Title A', { clusterId: 'cluster-1' })];
    const witness = candidate('b', nearBody, 'Title A variant', { trust: 80 });
    witness.simhash = nearSimhash(body, 2); // near-exact, not exact
    const result = dedupAssignCluster(witness, index, NOW, false);
    expect(result.clusterId).toBe('cluster-1');
    expect(result.verdict.layer).toBe('near_exact');
  });

  it('creates a new cluster for an unmatched item', () => {
    const result = dedupAssignCluster(
      candidate('b', 'a completely unrelated body about gardening', 'Gardening tips', {}),
      [],
      NOW,
      false,
    );
    expect(result.verdict.layer).toBe('none');
    expect(result.clusterId).toBeTruthy();
  });
});

describe('vector mode', () => {
  it('is on by default, off when KANAL_VECTOR=off', () => {
    expect(vectorModeEnabled({ KANAL_VECTOR: 'off' })).toBe(false);
    expect(vectorModeEnabled({})).toBe(true);
    expect(vectorModeEnabled({ KANAL_VECTOR: 'on' })).toBe(true);
  });
});

describe('window constants', () => {
  it('matches the plan', () => {
    expect(NEAR_EXACT_WINDOW_MS).toBe(30 * 86400000);
    expect(SEMANTIC_WINDOW_MS).toBe(72 * 3600000);
    expect(SIMHASH_HAMMING_THRESHOLD).toBe(3);
  });
});
