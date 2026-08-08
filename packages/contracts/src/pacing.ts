import { z } from 'zod';

/**
 * Pacing policy (plan §15.6). The pacing engine can only ever delay; it has no
 * code path that advances a slot.
 */

export const pacingPolicySchema = z.object({
  maxPostsPerHour: z.number().int().positive().default(3),
  maxPostsPerDay: z.number().int().positive().default(12),
  minGapMinutes: z.number().int().positive().default(18),
  quietHours: z.object({
    start: z.string(), // "00:30"
    end: z.string(), // "07:30"
    tz: z.string().default('channel'),
  }),
  burstAllowance: z.number().int().nonnegative().default(2),
  jitterSeconds: z.number().int().nonnegative().default(90),
  newChannelRamp: z
    .object({
      days1to3: z.object({ maxPostsPerDay: z.number().int().positive() }),
      days4to7: z.object({ maxPostsPerDay: z.number().int().positive() }),
      days8to14: z.object({ maxPostsPerDay: z.number().int().positive() }),
    })
    .optional(),
});
export type PacingPolicy = z.infer<typeof pacingPolicySchema>;

export const DEFAULT_PACING_POLICY: PacingPolicy = {
  maxPostsPerHour: 3,
  maxPostsPerDay: 12,
  minGapMinutes: 18,
  quietHours: { start: '00:30', end: '07:30', tz: 'channel' },
  burstAllowance: 2,
  jitterSeconds: 90,
};

export const promoDensityPolicySchema = z.object({
  promoMaxRatio: z.number().min(0).max(1).default(0.2),
  windowPosts: z.number().int().positive().default(20),
});
export type PromoDensityPolicy = z.infer<typeof promoDensityPolicySchema>;

export const DEFAULT_PROMO_DENSITY_POLICY: PromoDensityPolicy = {
  promoMaxRatio: 0.2,
  windowPosts: 20,
};

export const pacingVerdictSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allow'), at: z.string() }),
  z.object({ kind: z.literal('defer'), nextEligibleAt: z.string(), reason: z.string() }),
]);
export type PacingVerdict = z.infer<typeof pacingVerdictSchema>;
