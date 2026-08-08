/**
 * Freshness (plan §8.4).
 *
 * `freshness = exp(-Δt / τ)` where `Δt = now - coalesce(published_at,
 * first_seen_at)` and τ is per-channel (news niche default 8 h, evergreen
 * default 30 d). Items older than 4τ are excluded from AUTO candidates but
 * remain retrievable in CO-PILOT. When `published_at` is absent or in the
 * future, fall back to `first_seen_at` and set `freshness_confidence: 'low'`.
 */

import type { FreshnessConfidence } from './types.js';

export const TAU_NEWS_HOURS = 8;
export const TAU_EVERGREEN_HOURS = 24 * 30; // 30 days

export interface FreshnessInput {
  publishedAt?: Date | null;
  firstSeenAt?: Date | null;
  now?: Date;
}

export interface FreshnessResult {
  score: number;
  /** 'high' when publishedAt was present, in the past, and sane. */
  confidence: FreshnessConfidence;
  /** Which timestamp was actually used. */
  basis: 'published_at' | 'first_seen_at';
  excludedFromAuto: boolean;
}

export function freshnessOf(input: FreshnessInput, tauHours = TAU_NEWS_HOURS): FreshnessResult {
  const now = input.now ?? new Date();
  const tauMs = tauHours * 3_600_000;

  let basis: 'published_at' | 'first_seen_at' = 'first_seen_at';
  let dt: number;
  let confidence: FreshnessConfidence = 'low';

  const published = input.publishedAt;
  if (published && published.getTime() > 0 && published.getTime() <= now.getTime()) {
    basis = 'published_at';
    dt = Math.max(0, now.getTime() - published.getTime());
    confidence = 'high';
  } else {
    const first = input.firstSeenAt ?? now;
    basis = 'first_seen_at';
    dt = Math.max(0, now.getTime() - first.getTime());
    confidence = 'low';
  }

  const score = Math.exp(-dt / tauMs);
  return {
    score,
    confidence,
    basis,
    excludedFromAuto: dt > 4 * tauMs,
  };
}
