import { z } from 'zod';
import { type Zone, zoneSchema } from './domain.js';
import { capabilityIdSchema } from './capabilities.js';

/**
 * Agent manifest schema (plan §7.3). YAML, validated against a JSON Schema
 * published at `packages/contracts/schemas/agent-manifest.v1.json`.
 */

export const modelTierSchema = z.enum(['S', 'M', 'L', 'V', 'local']);
export type ModelTier = z.infer<typeof modelTierSchema>;

const retryOnSchema = z.enum(['schema_invalid', 'rate_limited', 'provider_5xx', 'timeout']);

export const agentManifestSchema = z.object({
  apiVersion: z.literal('kanal.dev/v1'),
  kind: z.literal('Agent'),
  coreApi: z.string(), // e.g. "^1.2"
  metadata: z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/, 'manifest id must be lowercase snake_case'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be semver'),
    team: z.string(),
    displayName: z.object({
      en: z.string(),
      fa: z.string().optional(),
    }),
  }),
  spec: z.object({
    zone: zoneSchema,
    stageBinding: z.string(), // must be an existing core stage
    inputContract: z.string(),
    outputContract: z.string(),
    tools: z.array(capabilityIdSchema),
    promptPack: z
      .object({
        ref: z.string(),
        version: z.string(),
        template: z.string(),
      })
      .optional(),
    model: z
      .object({
        tier: modelTierSchema,
        tierOverrideAllowed: z.boolean().default(true),
        temperature: z.number().min(0).max(2).default(0.7),
        maxOutputTokens: z.number().int().positive().default(1600),
        structuredOutput: z.enum(['required', 'preferred', 'none']).default('preferred'),
      })
      .optional(),
    budget: z
      .object({
        maxUsd: z.number().nonnegative().default(0.06),
        maxInputTokens: z.number().int().positive().default(14000),
        maxWallMs: z.number().int().positive().default(45000),
      })
      .default({}),
    retry: z
      .object({
        attempts: z.number().int().min(0).max(5).default(2),
        on: z.array(retryOnSchema).default(['schema_invalid', 'rate_limited', 'provider_5xx']),
        backoff: z.enum(['exponential_jitter', 'linear', 'none']).default('exponential_jitter'),
      })
      .default({}),
    fanout: z
      .object({
        variants: z.number().int().min(1).max(8).default(1),
      })
      .default({}),
    escalation: z
      .object({
        onExhausted: z.enum(['escalate_to_human', 'downtier_and_retry', 'skip_stage']).default('escalate_to_human'),
      })
      .default({}),
  }),
});
export type AgentManifest = z.infer<typeof agentManifestSchema>;

/** Which fields a user may edit without forking (plan §7.3). */
export const USER_EDITABLE_MANIFEST_PATHS = [
  'metadata.version',
  'spec.model.temperature',
  'spec.model.maxOutputTokens',
  'spec.tools',
  'spec.promptPack.ref',
  'spec.promptPack.version',
  'spec.promptPack.template',
  'spec.model.tier',
  'spec.budget.maxUsd',
  'spec.budget.maxInputTokens',
  'spec.budget.maxWallMs',
  'spec.retry',
  'spec.fanout.variants',
  'spec.escalation.onExhausted',
  'metadata.displayName',
];

/** Role default zones and tool allowances (plan §7.1). */
export const ROLE_DEFAULTS: Record<
  string,
  { team: string; zone: Zone; stage: string; allowedTools: string[] }
> = {
  strategist: { team: 'Strategy', zone: 'trusted', stage: 'strategy.brief', allowedTools: ['metrics.read_summary', 'source.search_index'] },
  calendar_planner: { team: 'Strategy', zone: 'deterministic', stage: 'strategy.slot', allowedTools: [] },
  harvester: { team: 'Sourcing', zone: 'deterministic', stage: 'sourcing.harvest', allowedTools: [] },
  ranker: { team: 'Sourcing', zone: 'quarantine', stage: 'sourcing.rank', allowedTools: ['source.read_snapshot'] },
  claim_extractor: { team: 'Sourcing', zone: 'quarantine', stage: 'research.extract_claims', allowedTools: ['source.read_snapshot'] },
  writer: { team: 'Editorial', zone: 'trusted', stage: 'editorial.draft', allowedTools: ['voice.read_pack', 'channel.read_recent', 'draft.write'] },
  critic: { team: 'Editorial', zone: 'trusted', stage: 'editorial.critique', allowedTools: ['voice.read_pack'] },
  reviser: { team: 'Editorial', zone: 'trusted', stage: 'editorial.revise', allowedTools: ['voice.read_pack', 'draft.write'] },
  fact_checker: { team: 'Editorial', zone: 'trusted', stage: 'editorial.fact_check', allowedTools: ['source.search_index'] },
  formatter: { team: 'Editorial', zone: 'deterministic', stage: 'format.render', allowedTools: [] },
  media_briefer: { team: 'Studio', zone: 'trusted', stage: 'studio.media_brief', allowedTools: [] },
  image_generator: { team: 'Studio', zone: 'trusted', stage: 'studio.media_gen', allowedTools: ['media.generate_image'] },
  pacing_engine: { team: 'Ops', zone: 'deterministic', stage: 'ops.schedule', allowedTools: [] },
  policy_classifier: { team: 'Ops', zone: 'trusted', stage: 'ops.policy_classify', allowedTools: [] },
  publisher: { team: 'Ops', zone: 'deterministic', stage: 'ops.publish', allowedTools: [] },
  analyst: { team: 'Growth', zone: 'trusted', stage: 'learn.aggregate', allowedTools: ['metrics.read_summary'] },
  voice_tuner: { team: 'Growth', zone: 'trusted', stage: 'learn.voice', allowedTools: ['voice.read_pack'] },
};
