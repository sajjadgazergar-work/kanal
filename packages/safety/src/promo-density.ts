import {
  DEFAULT_PROMO_DENSITY_POLICY,
  PROMOTIONAL_PATTERNS,
  type PromoDensityPolicy,
} from '@kanal/contracts';

/**
 * Promotional-density limit (plan §15.6 #2).
 *
 * Over a rolling window of the last `windowPosts` published posts, the share
 * flagged `is_promotional` must stay at or under `promoMaxRatio` (default
 * 0.20). A post is promotional if it contains an affiliate or UTM-tagged link,
 * a discount-code pattern, a sponsored callout, or is manually marked
 * sponsored. When the cap would be exceeded, the post is deferred with a
 * message naming the current ratio and when it will fall below the cap.
 */

export interface PublishedPostSummary {
  isPromotional: boolean;
  publishedAt: string; // ISO 8601
}

export interface PromoCheckInput {
  policy: PromoDensityPolicy;
  /** Published posts, newest-first. Only the newest `windowPosts` participate. */
  history: PublishedPostSummary[];
  /** True when the candidate post itself is promotional. */
  candidatePromotional: boolean;
}

export type PromoVerdict =
  | { kind: 'allow' }
  | {
      kind: 'defer';
      reason: string;
      currentRatio: number;
      /** ISO 8601 — when the oldest promotional post in the window falls out. */
      fallsBelowAt: string;
    };

export interface PromoPatternHit {
  id: string;
  label: string;
  pattern: RegExp;
}

export interface PromoFlags {
  isPromotional: boolean;
  matchedPatterns: PromoPatternHit[];
}

/**
 * Detect promotional content using the contract's `PROMOTIONAL_PATTERNS`
 * regexes. A post is promotional if any pattern matches or it is manually
 * flagged sponsored.
 */
export function classifyPromotional(text: string, manuallySponsored = false): PromoFlags {
  const matched: PromoPatternHit[] = [];
  for (const p of PROMOTIONAL_PATTERNS) {
    if (p.pattern.test(text)) {
      matched.push({ id: p.id, label: p.id, pattern: p.pattern });
    }
  }
  return {
    isPromotional: manuallySponsored || matched.length > 0,
    matchedPatterns: matched,
  };
}

/**
 * Evaluate the promo-density cap for a candidate post. When posting the
 * candidate would push the rolling-window share above the cap, defer and
 * explain both the current ratio and when a promotional post leaves the window
 * so the ratio falls back under the cap.
 */
export function evaluatePromoDensity(input: PromoCheckInput): PromoVerdict {
  const { policy, history, candidatePromotional } = input;
  // The rolling window is the NEWEST `windowPosts` posts. Sort newest-first so
  // the caller may pass history in either order.
  const newestFirst = [...history].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const window = newestFirst.slice(0, policy.windowPosts);
  const promoInWindow = window.filter((p) => p.isPromotional).length;
  const candidateCount = window.length; // count without candidate
  const candidateRatio = (promoInWindow + (candidatePromotional ? 1 : 0)) / Math.max(1, candidateCount + 1);
  const cap = policy.promoMaxRatio;

  if (candidateRatio <= cap) {
    return { kind: 'allow' };
  }

  // Defer. The ratio only recovers when a promotional post falls out of the
  // window. Find the oldest promotional post still in the window — when it
  // leaves (once `windowPosts` newer posts have been published after it), the
  // ratio drops by at least one promo post.
  const oldestPromo = [...window]
    .reverse()
    .find((p) => p.isPromotional);

  // Estimate when the window advances: assume the candidate publishes now and
  // future posts arrive at the trailing average inter-post interval, so the
  // oldest promo leaves the window after `windowPosts` posts have followed it.
  let fallsBelowAt = new Date().toISOString();
  if (oldestPromo) {
    const tail = history.slice(0, Math.min(10, history.length));
    let avgGapMs = 0;
    if (tail.length >= 2) {
      let sum = 0;
      for (let i = 1; i < tail.length; i++) {
        sum += Date.parse(tail[i - 1]!.publishedAt) - Date.parse(tail[i]!.publishedAt);
      }
      avgGapMs = Math.max(60_000, sum / (tail.length - 1));
    } else {
      avgGapMs = 3_600_000; // unknown cadence: assume hourly
    }
    const postsUntilOut = Math.max(1, window.length); // windowPosts after the oldest promo
    fallsBelowAt = new Date(Date.now() + postsUntilOut * avgGapMs).toISOString();
  }

  return {
    kind: 'defer',
    reason: `promotional density ${(candidateRatio * 100).toFixed(0)}% exceeds cap ${(cap * 100).toFixed(0)}% (${promoInWindow}/${candidateCount} promo in last ${window.length} posts${
      candidatePromotional ? ', +candidate' : ''
    }); falls below cap once a promo post ages out ≈ ${fallsBelowAt}`,
    currentRatio: candidateRatio,
    fallsBelowAt,
  };
}

/**
 * Convenience wrapper: when the cap would be exceeded by a *published* promo
 * post, returns the earliest point the ratio falls below the cap — estimated
 * as `windowPosts` posts after the oldest promo post in the window.
 */
export function pacePromoVerdict(
  policy: PromoDensityPolicy = DEFAULT_PROMO_DENSITY_POLICY,
  history: PublishedPostSummary[],
  candidatePromotional: boolean,
): PromoVerdict {
  return evaluatePromoDensity({ policy, history, candidatePromotional });
}
