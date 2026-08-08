import { describe, expect, it } from 'vitest';
import type { AutopublishPolicy, PolicyEval } from '@kanal/contracts';
import { evaluateAutopublishPolicy, type PostForPolicy } from '../autopublish.js';

const POLICY_ID = '6f0f5f43-1f4d-4a4f-9d7f-000000000001';
const ORG_ID = '6f0f5f43-1f4d-4a4f-9d7f-0000000000aa';
const HASH = 'abc123def456';

function policy(overrides: Partial<AutopublishPolicy> = {}): AutopublishPolicy {
  return {
    id: POLICY_ID,
    orgId: ORG_ID,
    name: 'auto-daily',
    version: '1.0.0',
    contentSha256: HASH,
    enabled: true,
    conditions: {
      lanes: ['auto'],
      riskClassMax: 1,
      requiresHumanReview: [],
      blockedCategories: [],
      maxPromoRatio: 0.2,
    },
    createdBy: 'human:u1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function post(overrides: Partial<PostForPolicy> = {}): PostForPolicy {
  return {
    lane: 'auto',
    riskClass: 0,
    isPromotional: false,
    blockedCategories: [],
    requiresHumanReview: false,
    createdAt: '2026-01-02T10:00:00.000Z',
    contentSha256: 'post-hash-1',
    ...overrides,
  };
}

describe('autopublish policy evaluation', () => {
  it('matches when all predicates hold', () => {
    const eval_ = evaluateAutopublishPolicy(policy(), { post: post() });
    expect(eval_.kind).toBe('match');
    if (eval_.kind === 'match') expect(eval_.policyHash).toBe(HASH);
  });

  it('policies ship disabled by default (Q3): no match when disabled', () => {
    const eval_ = evaluateAutopublishPolicy(policy({ enabled: false }), { post: post() });
    expect(eval_.kind).toBe('no_match');
    if (eval_.kind === 'no_match') expect(eval_.failedPredicates).toContain('policy_enabled');
  });

  it('names the failing lane predicate', () => {
    const eval_ = evaluateAutopublishPolicy(policy({ conditions: { ...policy().conditions, lanes: ['copilot'] } }), {
      post: post({ lane: 'auto' }),
    });
    expect(eval_.kind).toBe('no_match');
    if (eval_.kind === 'no_match') expect(eval_.failedPredicates).toContain('lane');
  });

  it('names the failing risk_class predicate', () => {
    const eval_ = evaluateAutopublishPolicy(policy(), { post: post({ riskClass: 3 }) });
    expect(eval_.kind).toBe('no_match');
    if (eval_.kind === 'no_match') expect(eval_.failedPredicates).toContain('risk_class');
  });

  it('requires zero human-review requirement', () => {
    const eval_ = evaluateAutopublishPolicy(policy(), { post: post({ requiresHumanReview: true }) });
    expect(eval_.kind).toBe('no_match');
    if (eval_.kind === 'no_match') expect(eval_.failedPredicates).toContain('no_human_review');
  });

  it('blocks when the post carries a blocked moderation category', () => {
    const eval_ = evaluateAutopublishPolicy(policy(), { post: post({ blockedCategories: ['violence'] }) });
    expect(eval_.kind).toBe('no_match');
    if (eval_.kind === 'no_match') expect(eval_.failedPredicates).toContain('blocked_categories');
  });

  it('blocks a promotional post when the policy forbids promo entirely', () => {
    const eval_ = evaluateAutopublishPolicy(
      policy({ conditions: { ...policy().conditions, maxPromoRatio: 0 } }),
      { post: post({ isPromotional: true }) },
    );
    expect(eval_.kind).toBe('no_match');
    if (eval_.kind === 'no_match') expect(eval_.failedPredicates).toContain('promo_ratio');
  });

  it('allows a promotional post within the promo ratio', () => {
    const eval_ = evaluateAutopublishPolicy(policy(), { post: post({ isPromotional: true }) });
    expect(eval_.kind).toBe('match');
  });

  it('respects the time window predicate', () => {
    const inWindow = evaluateAutopublishPolicy(
      policy({ conditions: { ...policy().conditions, timeWindow: { start: '09:00', end: '17:00', tz: 'UTC' } } }),
      { post: post(), nowIso: '2026-01-02T10:00:00.000Z' },
    );
    expect(inWindow.kind).toBe('match');

    const outOfWindow = evaluateAutopublishPolicy(
      policy({ conditions: { ...policy().conditions, timeWindow: { start: '09:00', end: '17:00', tz: 'UTC' } } }),
      { post: post(), nowIso: '2026-01-02T20:00:00.000Z' },
    );
    expect(outOfWindow.kind).toBe('no_match');
    if (outOfWindow.kind === 'no_match') expect(outOfWindow.failedPredicates).toContain('time_window');
  });

  it('returns the correct discriminated union shape', () => {
    const m = evaluateAutopublishPolicy(policy(), { post: post() }) as Extract<PolicyEval, { kind: 'match' }>;
    expect(m.kind).toBe('match');
    const n = evaluateAutopublishPolicy(policy({ enabled: false }), { post: post() }) as Extract<PolicyEval, { kind: 'no_match' }>;
    expect(n.kind).toBe('no_match');
    expect(Array.isArray(n.failedPredicates)).toBe(true);
  });
});
