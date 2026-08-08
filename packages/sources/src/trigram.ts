/**
 * Character-trigram similarity (plan §8.3 semantic dedup layer, used in
 * vector-off mode for retrieval too). Titles are compared with trigram
 * similarity ≥ 0.85, or cosine ≥ 0.92 when vectors are on.
 */

export function trigrams(input: string): Map<string, number> {
  const s = input.toLowerCase();
  const map = new Map<string, number>();
  if (s.length === 0) return map;
  if (s.length === 1) {
    map.set(` ${s} `, 1);
    return map;
  }
  const padded = `  ${s}  `;
  for (let i = 0; i + 3 <= padded.length; i++) {
    const gram = padded.slice(i, i + 3);
    map.set(gram, (map.get(gram) ?? 0) + 1);
  }
  return map;
}

function norm(vector: Map<string, number>): number {
  let sum = 0;
  for (const v of vector.values()) sum += v * v;
  return Math.sqrt(sum);
}

/**
 * Cosine similarity in [0,1] between two trigram vectors.
 */
export function cosineSimilarity(a: string, b: string): number {
  const va = trigrams(a);
  const vb = trigrams(b);
  const na = norm(va);
  const nb = norm(vb);
  if (na === 0 || nb === 0) return 0;
  let dot = 0;
  for (const [k, v] of va) {
    const w = vb.get(k);
    if (w !== undefined) dot += v * w;
  }
  return dot / (na * nb);
}

/**
 * Sørensen–Dice coefficient over character trigrams, in [0,1]. This is the
 * classic "trigram similarity" used for fuzzy title matching.
 */
export function diceSimilarity(a: string, b: string): number {
  const va = trigrams(a);
  const vb = trigrams(b);
  let common = 0;
  for (const [k, v] of va) {
    const w = vb.get(k);
    if (w !== undefined) common += Math.min(v, w);
  }
  const total = va.size + vb.size;
  if (total === 0) return 0;
  return (2 * common) / total;
}

export const TITLE_TRIGRAM_THRESHOLD = 0.85;
export const EMBEDDING_COSINE_THRESHOLD = 0.92;
