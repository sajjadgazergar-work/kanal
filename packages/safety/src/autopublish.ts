import { type AutopublishPolicy, type PolicyEval } from '@kanal/contracts';

/**
 * Autopublish policy evaluation (plan §4.2, §5.3, Q3).
 *
 * `policy_check → scheduled` requires a signed `autopublish_policy` matching
 * ALL predicates. Any unmatched predicate parks the run in `review_pending`
 * with the failing predicate named in the UI. Policies ship DISABLED (Q3): a
 * disabled policy never matches.
 */

export interface PostForPolicy {
  lane: 'auto' | 'copilot';
  riskClass: number;
  isPromotional: boolean;
  blockedCategories: string[];
  requiresHumanReview: boolean;
  /** ISO 8601. */
  createdAt: string;
  /** Content hash used for anti-TOCTOU binding. */
  contentSha256: string;
}

export interface PolicyEvalContext {
  post: PostForPolicy;
  /** Evaluated against the policy's time window when present. */
  nowIso?: string;
}

/**
 * Evaluate an autopublish policy against a post. Returns `match` or
 * `no_match` with named failed predicates.
 *
 * `failedPredicates` names are the UI-facing predicate identifiers, e.g.
 * `policy_enabled`, `lane`, `risk_class`, `no_human_review`,
 * `no_blocked_categories`, `promo_ratio`, `time_window`, `blocked_categories`.
 */
export function evaluateAutopublishPolicy(policy: AutopublishPolicy, ctx: PolicyEvalContext): PolicyEval {
  const failed: string[] = [];
  const { post } = ctx;

  // Q3: policies ship disabled.
  if (!policy.enabled) {
    failed.push('policy_enabled');
  }

  // Lane membership.
  if (!policy.conditions.lanes.includes(post.lane)) {
    failed.push('lane');
  }

  // Risk class ceiling.
  if (post.riskClass > policy.conditions.riskClassMax) {
    failed.push('risk_class');
  }

  // Human-review requirement.
  if (post.requiresHumanReview) {
    failed.push('no_human_review');
  }

  // Blocked categories (from the classifier / moderation).
  for (const cat of post.blockedCategories) {
    if (policy.conditions.blockedCategories.length === 0) {
      // No explicit allow-list: any blocked category fails the policy.
      failed.push(`blocked_categories`);
      break;
    }
    if (!policy.conditions.blockedCategories.includes(cat)) {
      failed.push(`blocked_categories:${cat}`);
    }
  }

  // Promo ratio. A single promotional post is acceptable up to the policy's
  // ratio cap. When the policy forbids promo entirely (ratio 0), any
  // promotional post fails the predicate. Ratios in (0,1) are enforced by the
  // channel-wide promo-density engine, not at the single-post gate.
  if (post.isPromotional && policy.conditions.maxPromoRatio === 0) {
    failed.push('promo_ratio');
  }

  // Time window (all-predicates-match; the window is a predicate too).
  if (policy.conditions.timeWindow) {
    const now = ctx.nowIso ?? new Date().toISOString();
    const nowMs = Date.parse(now);
    const { start, end, tz } = policy.conditions.timeWindow;
    if (start || end) {
      const inWindow = timeInWindow(nowMs, start, end, tz);
      if (!inWindow) failed.push('time_window');
    }
  }

  if (failed.length === 0) {
    return { kind: 'match', policyId: policy.id, policyHash: policy.contentSha256 };
  }
  return { kind: 'no_match', failedPredicates: [...new Set(failed)] };
}

function timeInWindow(atMs: number, start?: string, end?: string, tz?: string): boolean {
  if (!start && !end) return true;
  const tzFor = tz && tz !== 'channel' ? tz : 'UTC';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tzFor,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(atMs);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const moD = hour * 60 + minute;

  const s = start ? parseHhmm(start) : 0;
  const e = end ? parseHhmm(end) : 1439;
  if (s === null || e === null) return false;
  if (s <= e) return moD >= s && moD <= e;
  return moD >= s || moD <= e;
}

function parseHhmm(v: string): number | null {
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23) return null;
  return h * 60 + Number(m[2]);
}
