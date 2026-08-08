import {
  DEFAULT_PACING_POLICY,
  type PacingPolicy,
  type PacingVerdict,
} from '@kanal/contracts';
import { minutesOfDay, quietWindowEnd } from './time.js';

/**
 * Pacing engine (plan §15.6 #1). Enforced at `scheduled → publishing`.
 *
 * Constraints, in order of application:
 *   1. Kill-switch / halt gates are NOT here — they are the last thing before
 *      the socket write (see `kill-switch.ts`). This engine only computes slot
 *      legality.
 *   2. `new_channel_ramp`: a channel younger than `rampDays` is capped at the
 *      ramp daily cap (days 1-3, 4-7, 8-14).
 *   3. Quiet hours: posts inside the configured window are deferred to the
 *      window end.
 *   4. `max_posts_per_day`: defer until a day slot frees.
 *   5. `max_posts_per_hour`: defer until an hour slot frees.
 *   6. `min_gap_minutes` with `burst_allowance`: consecutive posts inside the
 *      min gap are allowed up to the burst allowance, then the engine stops
 *      until the gap has elapsed since the last post.
 *   7. `jitter_seconds`: the returned `at` is nudged by a deterministic
 *      pseudo-random offset within ±jitter_seconds.
 *
 * INVARIANT (tested): the engine can only ever **delay**. There is no code
 * path that advances a slot — the earliest returned time is `atMs + 0` (a
 * post already exactly at a slot boundary), and the jitter offset is
 * bi-directional but clamped so the result is never earlier than the caller's
 * nominal slot. When the engine cannot prove a slot is legal, it defers.
 */

export interface PublishedPost {
  publishedAt: string; // ISO 8601
  channelCreatedAt: string; // ISO 8601; drives the new-channel ramp
  quietHoursTz: string; // IANA name of the channel timezone ('UTC', 'Asia/Tehran', …)
}

/**
 * Deterministic pseudo-random in [0, 1). Seeded by (slotMs, channelId) so
 * jitter is stable across calls for the same slot — important because the
 * scheduler re-evaluates a deferred slot and must land on the same time.
 */
function seededUnit(seed: number, salt: string): number {
  // SplitMix32 on a salt-suffixed seed.
  let x = (seed >>> 0) ^ hashSalt(salt);
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function hashSalt(salt: string): number {
  let h = 2166136261;
  for (let i = 0; i < salt.length; i++) {
    h ^= salt.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface PacingInput {
  policy: PacingPolicy;
  channelId: string;
  /** Published posts, newest-first. */
  history: PublishedPost[];
  /** The nominal slot the scheduler proposes, ISO 8601. */
  atMs: number;
  /** Ramp start — the channel's creation time, ISO 8601. Used to compute channel age. */
  channelCreatedAt?: string;
  /** IANA timezone for quiet hours when policy.quietHours.tz === 'channel'. */
  channelTimezone?: string;
}

const MS = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function daysBetween(laterMs: number, earlierMs: number): number {
  return Math.floor((laterMs - earlierMs) / DAY);
}

function parseIso(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid ISO timestamp: ${iso}`);
  return ms;
}

/** The ramp cap for a channel of a given age, when the policy defines one. */
export function rampCapForDay(policy: PacingPolicy, channelAgeDays: number): number | null {
  const ramp = policy.newChannelRamp;
  if (!ramp) return null;
  if (channelAgeDays < 4) return ramp.days1to3.maxPostsPerDay;
  if (channelAgeDays < 8) return ramp.days4to7.maxPostsPerDay;
  if (channelAgeDays < 15) return ramp.days8to14.maxPostsPerDay;
  return null;
}

/**
 * The core pacing decision. Deterministic: identical inputs yield identical
 * verdicts (jitter included, via the channelId+slot seed).
 */
export function evaluatePacing(input: PacingInput): PacingVerdict {
  const { policy, channelId, history, atMs } = input;
  const sorted = [...history].sort((a, b) => parseIso(a.publishedAt) - parseIso(b.publishedAt));

  // Quiet hours first — no posts land inside the window.
  const quietStart = policy.quietHours.start;
  const quietEnd = policy.quietHours.end;
  if (minutesOfDay(quietStart) !== null && minutesOfDay(quietEnd) !== null) {
    const endMs = quietWindowEnd(atMs, quietStart, quietEnd, policy.quietHours.tz, input.channelTimezone);
    if (endMs > atMs) {
      const next = new Date(endMs).toISOString();
      return {
        kind: 'defer',
        nextEligibleAt: next,
        reason: `quiet hours ${quietStart}–${quietEnd} (${policy.quietHours.tz}); next legal slot ${next}`,
      };
    }
  }

  // New-channel ramp: cap total posts in the day window.
  const channelAgeDays = input.channelCreatedAt ? daysBetween(atMs, parseIso(input.channelCreatedAt)) : null;
  const rampCap = channelAgeDays !== null ? rampCapForDay(policy, channelAgeDays) : null;
  if (rampCap !== null) {
    const startOfDay = new Date(Math.floor(atMs / DAY) * DAY).getTime();
    const postsToday = sorted.filter((p) => {
      const t = parseIso(p.publishedAt);
      return t >= startOfDay && t < startOfDay + DAY;
    }).length;
    if (postsToday >= rampCap) {
      const nextEligible = new Date(startOfDay + DAY).toISOString();
      return {
        kind: 'defer',
        nextEligibleAt: nextEligible,
        reason: `new-channel ramp caps daily posts at ${rampCap} (channel age ${channelAgeDays} days); next eligible ${nextEligible}`,
      };
    }
  }

  // Daily cap.
  if (policy.maxPostsPerDay > 0) {
    const startOfDay = new Date(Math.floor(atMs / DAY) * DAY).getTime();
    const postsToday = sorted.filter((p) => {
      const t = parseIso(p.publishedAt);
      return t >= startOfDay && t < startOfDay + DAY;
    }).length;
    if (postsToday >= policy.maxPostsPerDay) {
      const nextEligible = new Date(startOfDay + DAY).toISOString();
      return {
        kind: 'defer',
        nextEligibleAt: nextEligible,
        reason: `daily cap reached (${postsToday}/${policy.maxPostsPerDay}); next eligible ${nextEligible}`,
      };
    }
  }

  // Hourly cap.
  if (policy.maxPostsPerHour > 0) {
    const hourStart = Math.floor(atMs / HOUR) * HOUR;
    const postsInHour = sorted.filter((p) => {
      const t = parseIso(p.publishedAt);
      return t >= hourStart && t < hourStart + HOUR;
    }).length;
    if (postsInHour >= policy.maxPostsPerHour) {
      const nextEligible = new Date(hourStart + HOUR).toISOString();
      return {
        kind: 'defer',
        nextEligibleAt: nextEligible,
        reason: `hourly cap reached (${postsInHour}/${policy.maxPostsPerHour}); next eligible ${nextEligible}`,
      };
    }
  }

  // Min-gap with burst allowance. A burst run is a maximal chain of posts each
  // within min_gap of its predecessor. Posting is allowed inside a run only up
  // to `burstAllowance` consecutive posts beyond the run's seed; beyond that,
  // hard stop until min_gap has elapsed since the most recent post.
  if (policy.minGapMinutes > 0 && sorted.length > 0) {
    const last = sorted[sorted.length - 1]!;
    const lastMs = parseIso(last.publishedAt);
    const gapMs = policy.minGapMinutes * MS;
    if (atMs - lastMs < gapMs) {
      // Trailing run length: count posts back through gaps < min_gap.
      let trailingRun = 1;
      for (let k = sorted.length - 1; k > 0; k--) {
        if (parseIso(sorted[k]!.publishedAt) - parseIso(sorted[k - 1]!.publishedAt) < gapMs) {
          trailingRun++;
        } else {
          break;
        }
      }
      const candidateRun = trailingRun + 1; // including the post at atMs
      if (candidateRun > policy.burstAllowance + 1) {
        const nextEligible = new Date(lastMs + gapMs).toISOString();
        return {
          kind: 'defer',
          nextEligibleAt: nextEligible,
          reason: `min gap ${policy.minGapMinutes}m with burst ${policy.burstAllowance}; run of ${trailingRun} already inside the gap; next eligible ${nextEligible}`,
        };
      }
    }
  }

  // Slot legal. Apply deterministic jitter, clamped so we never advance the
  // slot earlier than the nominal time minus 0 (we can only delay).
  let at = atMs;
  if (policy.jitterSeconds > 0) {
    const seed = Math.floor(atMs / 1000);
    const r = seededUnit(seed, channelId);
    const offsetMs = Math.round((r * 2 - 1) * policy.jitterSeconds * 1000);
    // Clamp: jitter may only delay, never advance.
    at = Math.max(atMs, atMs + offsetMs);
  }

  return { kind: 'allow', at: new Date(at).toISOString() };
}

/**
 * Convenience wrapper over `evaluatePacing` that parses ISO strings.
 * `nowIso` defaults to `new Date().toISOString()`.
 */
export function pacePost(
  policy: PacingPolicy,
  history: PublishedPost[],
  channelId: string,
  atIso: string,
  opts: { channelCreatedAt?: string; channelTimezone?: string } = {},
): PacingVerdict {
  return evaluatePacing({
    policy,
    channelId,
    history,
    atMs: parseIso(atIso),
    channelCreatedAt: opts.channelCreatedAt,
    channelTimezone: opts.channelTimezone,
  });
}

/** Re-export for callers that want the defaults without importing contracts. */
export { DEFAULT_PACING_POLICY };

/** True when the verdict defers. */
export function isDefer(v: PacingVerdict): v is Extract<PacingVerdict, { kind: 'defer' }> {
  return v.kind === 'defer';
}

/** True when the verdict allows. */
export function isAllow(v: PacingVerdict): v is Extract<PacingVerdict, { kind: 'allow' }> {
  return v.kind === 'allow';
}
