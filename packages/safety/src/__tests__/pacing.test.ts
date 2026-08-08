import { describe, expect, it } from 'vitest';
import { DEFAULT_PACING_POLICY, type PacingPolicy } from '@kanal/contracts';
import { evaluatePacing, pacePost, type PublishedPost, rampCapForDay } from '../pacing.js';

const CH = 'channel-1';
const TZ = 'UTC';

function post(iso: string): PublishedPost {
  return { publishedAt: iso, channelCreatedAt: '2026-01-01T00:00:00.000Z', quietHoursTz: TZ };
}

function atIso(dayOffset: number, hh: number, mm = 0): string {
  const d = new Date(Date.UTC(2026, 0, 1 + dayOffset, hh, mm, 0));
  return d.toISOString();
}

describe('pacing engine', () => {
  it('allows an empty-history post immediately', () => {
    const v = pacePost(DEFAULT_PACING_POLICY, [], CH, atIso(0, 10, 0), { channelTimezone: TZ });
    expect(v.kind).toBe('allow');
  });

  it('defers during quiet hours and names the next legal slot', () => {
    const v = pacePost(DEFAULT_PACING_POLICY, [], CH, atIso(0, 2, 0), { channelTimezone: TZ });
    expect(v.kind).toBe('defer');
    if (v.kind === 'defer') {
      expect(v.nextEligibleAt).toBe('2026-01-01T07:30:00.000Z'); // 07:30 UTC end
      expect(v.reason).toContain('quiet hours');
    }
  });

  it('allows a post just after quiet hours end', () => {
    const v = pacePost(DEFAULT_PACING_POLICY, [], CH, atIso(0, 7, 30), { channelTimezone: TZ });
    expect(v.kind).toBe('allow');
  });

  it('enforces max_posts_per_hour', () => {
    const history = [post(atIso(0, 9, 0)), post(atIso(0, 9, 10)), post(atIso(0, 9, 20))];
    // Three posts already this hour; policy allows 3/hour.
    const v = pacePost(DEFAULT_PACING_POLICY, history, CH, atIso(0, 9, 30), { channelTimezone: TZ });
    expect(v.kind).toBe('defer');
    if (v.kind === 'defer') expect(v.nextEligibleAt).toBe('2026-01-01T10:00:00.000Z');
  });

  it('allows the 3rd post exactly at the hourly cap', () => {
    const history = [post(atIso(0, 9, 0)), post(atIso(0, 9, 10))];
    const v = pacePost(DEFAULT_PACING_POLICY, history, CH, atIso(0, 9, 20), { channelTimezone: TZ });
    expect(v.kind).toBe('allow');
  });

  it('enforces max_posts_per_day', () => {
    const policy: PacingPolicy = { ...DEFAULT_PACING_POLICY, maxPostsPerDay: 3 };
    const history = [post(atIso(0, 0, 1)), post(atIso(0, 6, 0)), post(atIso(0, 12, 0))];
    const v = pacePost(policy, history, CH, atIso(0, 18, 0), { channelTimezone: TZ });
    expect(v.kind).toBe('defer');
    if (v.kind === 'defer') expect(v.nextEligibleAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('allows a post when the daily cap is not reached', () => {
    const policy: PacingPolicy = { ...DEFAULT_PACING_POLICY, maxPostsPerDay: 12 };
    const history = [post(atIso(0, 0, 1)), post(atIso(0, 6, 0))];
    const v = pacePost(policy, history, CH, atIso(0, 12, 0), { channelTimezone: TZ });
    expect(v.kind).toBe('allow');
  });

  it('enforces min_gap_minutes', () => {
    const policy: PacingPolicy = { ...DEFAULT_PACING_POLICY, burstAllowance: 0, minGapMinutes: 60 };
    const history = [post(atIso(0, 9, 0))];
    const v = pacePost(policy, history, CH, atIso(0, 9, 30), { channelTimezone: TZ });
    expect(v.kind).toBe('defer');
    if (v.kind === 'defer') expect(v.nextEligibleAt).toBe('2026-01-01T10:00:00.000Z');
  });

  it('allows a burst up to the burst allowance then stops', () => {
    const policy: PacingPolicy = { ...DEFAULT_PACING_POLICY, burstAllowance: 2, minGapMinutes: 60 };
    const history = [post(atIso(0, 8, 0)), post(atIso(0, 8, 5))];
    // Two in gap; burstAllowance 2 means 2 consecutive allowed inside min gap.
    const v = pacePost(policy, history, CH, atIso(0, 8, 10), { channelTimezone: TZ });
    expect(v.kind).toBe('allow');
  });

  it('stops after the burst allowance is consumed', () => {
    const policy: PacingPolicy = { ...DEFAULT_PACING_POLICY, burstAllowance: 2, minGapMinutes: 60 };
    const history = [post(atIso(0, 8, 0)), post(atIso(0, 8, 5)), post(atIso(0, 8, 10))];
    // 3 posts inside the gap already → run length 3 > allowance+1 → defer.
    const v = pacePost(policy, history, CH, atIso(0, 8, 15), { channelTimezone: TZ });
    expect(v.kind).toBe('defer');
    if (v.kind === 'defer') expect(v.nextEligibleAt).toBe('2026-01-01T09:00:00.000Z');
  });

  it('defers a new channel under the ramp cap', () => {
    const policy: PacingPolicy = {
      ...DEFAULT_PACING_POLICY,
      maxPostsPerDay: 12,
      newChannelRamp: {
        days1to3: { maxPostsPerDay: 3 },
        days4to7: { maxPostsPerDay: 6 },
        days8to14: { maxPostsPerDay: 9 },
      },
    };
    // Channel created 2026-01-01; post on 2026-01-02 (day 2) after 3 posts.
    const history = [
      { ...post(atIso(1, 8, 0)), channelCreatedAt: '2026-01-01T00:00:00.000Z' },
      { ...post(atIso(1, 9, 0)), channelCreatedAt: '2026-01-01T00:00:00.000Z' },
      { ...post(atIso(1, 10, 0)), channelCreatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const v = pacePost(policy, history, CH, atIso(1, 11, 0), {
      channelTimezone: TZ,
      channelCreatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(v.kind).toBe('defer');
    if (v.kind === 'defer') expect(v.nextEligibleAt).toBe('2026-01-03T00:00:00.000Z');
  });

  it('applies the ramp only for the right age band', () => {
    const policy: PacingPolicy = {
      ...DEFAULT_PACING_POLICY,
      maxPostsPerDay: 12,
      newChannelRamp: {
        days1to3: { maxPostsPerDay: 3 },
        days4to7: { maxPostsPerDay: 6 },
        days8to14: { maxPostsPerDay: 9 },
      },
    };
    expect(rampCapForDay(policy, 0)).toBe(3);
    expect(rampCapForDay(policy, 3)).toBe(3);
    expect(rampCapForDay(policy, 4)).toBe(6);
    expect(rampCapForDay(policy, 7)).toBe(6);
    expect(rampCapForDay(policy, 8)).toBe(9);
    expect(rampCapForDay(policy, 14)).toBe(9);
    expect(rampCapForDay(policy, 15)).toBeNull();
  });

  it('allows posts at full rate after the ramp window', () => {
    const policy: PacingPolicy = {
      ...DEFAULT_PACING_POLICY,
      maxPostsPerDay: 12,
      newChannelRamp: {
        days1to3: { maxPostsPerDay: 3 },
        days4to7: { maxPostsPerDay: 6 },
        days8to14: { maxPostsPerDay: 9 },
      },
    };
    const history = [
      { ...post('2026-01-20T08:00:00.000Z'), channelCreatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const v = pacePost(policy, history, CH, '2026-01-20T09:00:00.000Z', {
      channelTimezone: TZ,
      channelCreatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(v.kind).toBe('allow');
  });

  it('delay-only invariant: verdict never advances earlier than the slot', () => {
    // Exhaustive-ish sweep over slots and histories — the engine may only
    // return allow at >= the proposed slot, or defer to a later time.
    for (let h = 0; h < 24; h++) {
      const history = [post(atIso(0, h, 5))];
      const v = pacePost(DEFAULT_PACING_POLICY, history, CH, atIso(0, h, 10), { channelTimezone: TZ });
      if (v.kind === 'allow') {
        const at = Date.parse(v.at);
        expect(at).toBeGreaterThanOrEqual(Date.parse(atIso(0, h, 10)));
        expect(at).toBeLessThanOrEqual(Date.parse(atIso(0, h, 10)) + 90_000); // jitter bound
      } else {
        expect(Date.parse(v.nextEligibleAt)).toBeGreaterThan(Date.parse(atIso(0, h, 10)));
      }
    }
  });

  it('deterministic: same inputs produce identical verdicts', () => {
    const history = [post(atIso(0, 9, 0))];
    const a = evaluatePacing({
      policy: DEFAULT_PACING_POLICY,
      channelId: CH,
      history,
      atMs: Date.parse(atIso(0, 9, 20)),
      channelTimezone: TZ,
    });
    const b = evaluatePacing({
      policy: DEFAULT_PACING_POLICY,
      channelId: CH,
      history,
      atMs: Date.parse(atIso(0, 9, 20)),
      channelTimezone: TZ,
    });
    expect(a).toEqual(b);
  });

  it('quiet hours are evaluated in channel-local time', () => {
    // Quiet 00:30–07:30 in Asia/Tehran = 21:00–04:00 UTC.
    const policy: PacingPolicy = {
      ...DEFAULT_PACING_POLICY,
      quietHours: { start: '00:30', end: '07:30', tz: 'Asia/Tehran' },
    };
    // 22:00 UTC = 01:30 Tehran → inside quiet.
    const v = pacePost(policy, [], CH, '2026-01-01T22:00:00.000Z', { channelTimezone: TZ });
    expect(v.kind).toBe('defer');
    // 05:00 UTC = 08:30 Tehran → outside quiet, allow.
    const v2 = pacePost(policy, [], CH, '2026-01-01T05:00:00.000Z', { channelTimezone: TZ });
    expect(v2.kind).toBe('allow');
  });
});
