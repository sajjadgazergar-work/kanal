/**
 * Three-layer dedup (plan §8.3).
 *
 *   | Layer      | Test                                                        | Window | Action |
 *   | Exact      | url_hash unique index                                      | all    | Reject at insert |
 *   | Near-exact | 64-bit simhash over normalized body, Hamming ≤ 3           | 30 d   | Attach to existing cluster_id, keep as an additional witness |
 *   | Semantic   | Title trigram similarity ≥ 0.85 or cosine ≥ 0.92 (vectors) | 72 h   | Same cluster; highest-trust_score source becomes primary |
 *
 * Clusters, not items, are what the ranker sees. A story covered by six outlets
 * is one candidate with six witnesses.
 *
 * `KANAL_VECTOR=off` (vector mode disabled) falls back to simhash + trigram only.
 */

import { randomUUID } from 'node:crypto';
import { isNearDuplicate } from './simhash.js';
import { diceSimilarity, TITLE_TRIGRAM_THRESHOLD, EMBEDDING_COSINE_THRESHOLD } from './trigram.js';

export const NEAR_EXACT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SEMANTIC_WINDOW_MS = 72 * 60 * 60 * 1000; // 72 h
export const SIMHASH_HAMMING_THRESHOLD = 3;

export function vectorModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KANAL_VECTOR !== 'off';
}

export interface DedupCandidate {
  id: string;
  /** simhash as a signed bigint string. */
  simhash: string;
  title?: string | null;
  bodyText?: string;
  /** Cosine of the embedding (when vectors are on). */
  embeddingCosine?: number;
  firstSeenAt: Date;
  trustScore?: number;
  clusterId?: string | null;
}

export interface DedupContext {
  /** Simhash to test. */
  simhash: string;
  /** Id of the candidate being tested (used to skip the item itself). */
  id?: string;
  title?: string | null;
  /** Embedding cosine candidates are precomputed by the caller when vectors are on. */
  vectorsOn: boolean;
}

export type DedupVerdict =
  | { layer: 'exact'; matchId: string }
  | { layer: 'near_exact'; matchId: string }
  | { layer: 'semantic'; matchId: string; basis: 'trigram' | 'cosine' }
  | { layer: 'none' };

/**
 * Check a candidate against an index of existing items. Returns the matching
 * layer (first match wins: exact → near-exact → semantic) and the id of the
 * best match. When `vectorsOn`, semantic matching also accepts embedding cosine
 * ≥ 0.92; when off, trigram similarity ≥ 0.85 is the only semantic test.
 */
export function findDuplicate(
  ctx: DedupContext,
  index: DedupCandidate[],
  now: Date,
): DedupVerdict {
  const hash = BigInt(ctx.simhash);

  // Exact — url_hash unique index handles it at insert; here we still check so
  // callers can reject before attempting an insert.
  for (const c of index) {
    if (c.simhash === ctx.simhash && c.id !== ctx.id) return { layer: 'exact', matchId: c.id };
  }

  // Near-exact — 30-day window.
  let bestNear: { id: string; dist: number } | null = null;
  for (const c of index) {
    if (now.getTime() - c.firstSeenAt.getTime() > NEAR_EXACT_WINDOW_MS) continue;
    const d = isNearDuplicate(hash, BigInt(c.simhash), SIMHASH_HAMMING_THRESHOLD);
    if (d) {
      const dist = hamming(hash, BigInt(c.simhash));
      if (!bestNear || dist < bestNear.dist) bestNear = { id: c.id, dist };
    }
  }
  if (bestNear) return { layer: 'near_exact', matchId: bestNear.id };

  // Semantic — 72-hour window.
  const title = ctx.title?.trim().toLowerCase();
  if (title) {
    let bestSem: { id: string; basis: 'trigram' | 'cosine' } | null = null;
    for (const c of index) {
      if (now.getTime() - c.firstSeenAt.getTime() > SEMANTIC_WINDOW_MS) continue;
      const cTitle = c.title?.trim().toLowerCase();
      if (!cTitle) continue;
      const trigram = diceSimilarity(title, cTitle);
      if (trigram >= TITLE_TRIGRAM_THRESHOLD) {
        if (!bestSem || trigram > 0.99) bestSem = { id: c.id, basis: 'trigram' };
      }
      if (ctx.vectorsOn && c.embeddingCosine !== undefined && c.embeddingCosine >= EMBEDDING_COSINE_THRESHOLD) {
        if (!bestSem || trigram >= TITLE_TRIGRAM_THRESHOLD) bestSem = { id: c.id, basis: 'cosine' };
      }
    }
    if (bestSem) return { layer: 'semantic', matchId: bestSem.id, basis: bestSem.basis };
  }

  return { layer: 'none' };
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

/**
 * Merge an item into a cluster. If the item has no cluster, create a new one.
 * Returns the resolved cluster id. The cluster's witnesses grow via
 * `updateClusterWitnesses`.
 */
export function assignCluster(
  item: DedupCandidate,
  match: DedupCandidate | null,
  _now: Date,
): string {
  if (match?.clusterId) return match.clusterId;
  return item.clusterId ?? cryptoRandomUuid();
}

function cryptoRandomUuid(): string {
  return randomUUID();
}

/**
 * For an existing cluster, pick the primary item (highest trust score).
 */
export function chooseClusterPrimary(items: DedupCandidate[]): DedupCandidate | null {
  let best: DedupCandidate | null = null;
  for (const it of items) {
    if (!best || (it.trustScore ?? 0) > (best.trustScore ?? 0)) best = it;
  }
  return best;
}

/**
 * Given an existing index and a new item, decide whether it is a new cluster
 * or a witness of an existing one, and return the cluster id.
 */
export function dedupAssignCluster(
  newItem: DedupCandidate,
  index: DedupCandidate[],
  now: Date,
  vectorsOn: boolean,
): { clusterId: string; verdict: DedupVerdict } {
  const verdict = findDuplicate({ simhash: newItem.simhash, title: newItem.title, vectorsOn }, index, now);
  if (verdict.layer === 'none') {
    return { clusterId: newItem.clusterId ?? cryptoRandomUuid(), verdict };
  }
  const match = index.find((c) => c.id === verdict.matchId);
  const clusterId = match?.clusterId ?? cryptoRandomUuid();
  return { clusterId, verdict };
}
