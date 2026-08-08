import { z } from 'zod';

/**
 * Autopublish policies (plan §4.2, §5.3). `publish_intent` rows are created
 * only by a human action or a matching signed autopublish policy. Publish is
 * never an agent capability.
 */

export const autopublishPolicySchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  name: z.string(),
  version: z.string(),
  /** hash of the canonical JSON — the policy is versioned and its hash is recorded on the run. */
  contentSha256: z.string(),
  enabled: z.boolean().default(false), // AUTO ships with policies *disabled* (plan Q3)
  conditions: z.object({
    lanes: z.array(z.enum(['auto', 'copilot'])).default(['auto']),
    riskClassMax: z.number().int().min(0).max(3).default(1),
    requiresHumanReview: z.array(z.string()).default([]),
    blockedCategories: z.array(z.string()).default([]),
    maxPromoRatio: z.number().min(0).max(1).default(0.2),
    timeWindow: z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        tz: z.string().optional(),
      })
      .optional(),
  }),
  /** Predicates evaluated against the post; ALL must match for autopublish. */
  createdBy: z.string(),
  createdAt: z.string(),
});
export type AutopublishPolicy = z.infer<typeof autopublishPolicySchema>;

/** Result of evaluating a policy against a post. */
export const policyEvalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('match'), policyId: z.string(), policyHash: z.string() }),
  z.object({
    kind: z.literal('no_match'),
    failedPredicates: z.array(z.string()), // named in the UI (plan §5.3)
  }),
]);
export type PolicyEval = z.infer<typeof policyEvalSchema>;

/** Moderation categories (plan §15.4). First six hard-block; last four escalate to review. */
export const MODERATION_HARD_BLOCK = [
  'violence',
  'sexual_content',
  'self_harm',
  'hate',
  'harassment',
  'illegal_goods',
] as const;

export const MODERATION_RISK_ESCALATE = [
  'medical_advice',
  'financial_advice',
  'legal_advice',
  'election_content',
] as const;

export const PROMOTIONAL_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: 'affiliate_link', pattern: /(?:ref|aff|ref_id|subid|tag|click_id)=/i },
  { id: 'discount_code', pattern: /\b(?:discount|promo|code|coupon)\s+[-A-Z0-9]{4,}/i },
  { id: 'utm_link', pattern: /\butm_(?:source|medium|campaign|term|content)=/i },
  { id: 'sponsored_callout', pattern: /\b(?:sponsored|paid post|advertisement)\b/i },
];
