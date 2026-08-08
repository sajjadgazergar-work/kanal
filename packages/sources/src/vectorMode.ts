/**
 * `KANAL_VECTOR=off` mode (plan §8.2): embeddings stay NULL, dedup falls back
 * to simhash + trigram only, retrieval falls back to trigram + recency.
 * Exported as a testable mode.
 */

import type { ProcessedItem } from './pipeline.js';
import { cosineSimilarity, diceSimilarity, TITLE_TRIGRAM_THRESHOLD } from './trigram.js';

export type VectorMode = 'on' | 'off';

export function vectorMode(env: NodeJS.ProcessEnv = process.env): VectorMode {
  return env.KANAL_VECTOR === 'off' ? 'off' : 'on';
}

export function vectorsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return vectorMode(env) === 'on';
}

export interface RetrievalQuery {
  title?: string | null;
  text?: string;
  /** Precomputed embedding cosine when vectors are on. */
  embeddingCosine?: number;
  /** Recency weight in [0,1]. */
  recencyWeight?: number;
}

export interface RetrievedItem {
  item: ProcessedItem;
  score: number;
  basis: 'trigram' | 'cosine' | 'recency';
}

const RECENCY_HALF_LIFE_MS = 72 * 60 * 60 * 1000; // 72 h

/**
 * Search a candidate set for items similar to a query. In vector-off mode the
 * embedding cosine is ignored; in vector-on mode it is honoured when ≥ 0.92.
 * Recency (freshness score) is always blended in.
 */
export function retrievalSearch(
  query: RetrievalQuery,
  candidates: ProcessedItem[],
  vectorsOn: boolean,
  topK = 10,
): RetrievedItem[] {
  const scored: RetrievedItem[] = [];
  const qTitle = query.title?.trim().toLowerCase();
  const qText = query.text?.trim().toLowerCase();

  for (const c of candidates) {
    let similarity = 0;
    let basis: RetrievedItem['basis'] = 'recency';

    const cTitle = c.title?.trim().toLowerCase();
    if (qTitle && cTitle) {
      const dice = diceSimilarity(qTitle, cTitle);
      if (dice >= TITLE_TRIGRAM_THRESHOLD) {
        similarity = dice;
        basis = 'trigram';
      } else if (qText && c.bodyText) {
        const bodyCos = cosineSimilarity(qText, c.bodyText);
        if (bodyCos > similarity) {
          similarity = bodyCos;
          basis = 'trigram';
        }
      }
    } else if (qText && c.bodyText) {
      similarity = cosineSimilarity(qText, c.bodyText);
      if (similarity > 0) basis = 'trigram';
    }

    if (vectorsOn && query.embeddingCosine !== undefined) {
      const cos = Math.max(similarity, query.embeddingCosine);
      if (query.embeddingCosine >= 0.92 && query.embeddingCosine > similarity) {
        basis = 'cosine';
      }
      similarity = cos;
    }

    // Blend recency.
    const now = new Date().getTime();
    const age = Math.max(0, now - c.fetchedAt.getTime());
    const recency = Math.exp(-age / RECENCY_HALF_LIFE_MS);
    const recencyWeight = query.recencyWeight ?? 0.3;
    const score = (1 - recencyWeight) * similarity + recencyWeight * recency;

    scored.push({ item: c, score, basis });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Vector-off fallback for dedup: a pure trigram + simhash matcher (used when
 * embeddings are NULL). This is the exported testable fallback.
 */
export function dedupFallbackMatch(
  query: { title?: string | null; simhash: string },
  candidates: Array<{ title?: string | null; simhash: string; firstSeenAt: Date }>,
  now: Date,
  hammingThreshold = 3,
): Array<{ candidate: (typeof candidates)[number]; layer: 'near_exact' | 'semantic'; score: number }> {
  const out: Array<{ candidate: (typeof candidates)[number]; layer: 'near_exact' | 'semantic'; score: number }> = [];
  const qHash = BigInt(query.simhash);
  const qTitle = query.title?.trim().toLowerCase();
  for (const c of candidates) {
    const hash = BigInt(c.simhash);
    const dist = hamming(qHash, hash);
    if (dist <= hammingThreshold) {
      out.push({ candidate: c, layer: 'near_exact', score: 1 - dist / 64 });
      continue;
    }
    if (qTitle && c.title) {
      const dice = diceSimilarity(qTitle, c.title.trim().toLowerCase());
      if (dice >= TITLE_TRIGRAM_THRESHOLD) {
        out.push({ candidate: c, layer: 'semantic', score: dice });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function hamming(a: bigint, b: bigint): number {
  let x = (a ^ b) & 0xffffffffffffffffn;
  let n = 0;
  while (x !== 0n) {
    x &= x - 1n;
    n++;
  }
  return n;
}
