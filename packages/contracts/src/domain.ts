import { z } from 'zod';

/**
 * Core domain types (plan §4.3, §10.2, §13.3). These are the contracts every
 * stage, adapter, and the live event bus share. They are Apache-2.0 so third
 * parties writing adapters can depend on them without relicensing (plan §19.1).
 */

export const runStateSchema = z.enum([
  'intake',
  'briefed',
  'sourcing',
  'researched',
  'authoring',
  'drafting',
  'critiquing',
  'revising',
  'formatting',
  'media_pending',
  'policy_check',
  'review_pending',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'publish_uncertain',
  'measuring',
  'learned',
  'escalated',
  'blocked_policy',
  'blocked_budget',
  'blocked_provider',
  'halted',
  'cancelled',
  'failed',
]);
export type RunState = z.infer<typeof runStateSchema>;

export const laneSchema = z.enum(['auto', 'copilot', 'manual']);
export type Lane = z.infer<typeof laneSchema>;

export const zoneSchema = z.enum(['quarantine', 'trusted', 'deterministic']);
export type Zone = z.infer<typeof zoneSchema>;

export const gateKindSchema = z.enum([
  'topic',
  'draft',
  'publish',
  'policy_override',
  'budget_raise',
  'source_trust',
]);
export type GateKind = z.infer<typeof gateKindSchema>;

export const gateVerdictSchema = z.enum(['pass', 'revise', 'block', 'human']);
export type GateVerdict = z.infer<typeof gateVerdictSchema>;

export const platformKindSchema = z.enum([
  'telegram',
  'bale',
  'rubika',
  'eitaa',
  'x',
  'reddit',
]);
export type PlatformKind = z.infer<typeof platformKindSchema>;

/** The approval object — a durable row, not an in-memory promise (plan §4.3). */
export const approvalSchema = z.object({
  id: z.string().uuid(),
  runId: z.string(),
  gate: gateKindSchema,
  requestedAt: z.string(), // ISO 8601 UTC
  slaDeadline: z.string(),
  hardExpiry: z.string(),
  escalationChain: z.array(z.string()),
  escalatedToIndex: z.number().int().nonnegative(),
  state: z.enum(['pending', 'granted', 'denied', 'expired', 'superseded']),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  reasonCode: z.string().optional(),
  note: z.string().optional(),
  payloadHash: z.string(), // sha256 of the exact artefact approved — anti-TOCTOU
});
export type Approval = z.infer<typeof approvalSchema>;

/** A typed, length-capped, provenance-bearing crossing from untrusted to trusted (plan §7.5, §16.1). */
export const claimSchema = z.object({
  id: z.string().uuid(),
  sourceItemId: z.string().uuid(),
  text: z.string().min(1).max(320),
  charSpan: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
  confidence: z.number().min(0).max(1),
  isQuote: z.boolean(),
  sourceUrl: z.string().url().optional(),
  sourceName: z.string().optional(),
});
export type Claim = z.infer<typeof claimSchema>;

export const briefSchema = z.object({
  angle: z.string(),
  audience: z.string(),
  riskClass: z.number().int().min(0).max(3),
  targetLength: z.number().int().positive(),
  mustCover: z.array(z.string()),
  mustAvoid: z.array(z.string()),
});
export type Brief = z.infer<typeof briefSchema>;

export const mediaRefSchema = z.object({
  kind: z.enum(['image', 'video', 'file']),
  localPath: z.string().optional(),
  remoteUrl: z.string().url().optional(),
  caption: z.string().optional(),
  mimeType: z.string().optional(),
});
export type MediaRef = z.infer<typeof mediaRefSchema>;

export const postDraftSchema = z.object({
  bodyMd: z.string().min(1),
  claimMap: z.record(z.array(z.string())), // sentence-index -> claim_ids
  allowedUrls: z.array(z.string().url()),
  media: z.array(mediaRefSchema).default([]),
});
export type PostDraft = z.infer<typeof postDraftSchema>;

export const critiqueSchema = z.object({
  scores: z.object({
    factualGrounding: z.number().min(0).max(1),
    voiceConformance: z.number().min(0).max(1),
    structuralCompliance: z.number().min(0).max(1),
    bannedPatternCleanliness: z.number().min(0).max(1),
    specificity: z.number().min(0).max(1),
    readerValue: z.number().min(0).max(1),
    formattingCorrectness: z.number().min(0).max(1),
  }),
  issues: z.array(
    z.object({
      dimension: z.string(),
      severity: z.enum(['info', 'warning', 'hard']),
      message: z.string(),
    }),
  ),
  composite: z.number().min(0).max(1),
});
export type Critique = z.infer<typeof critiqueSchema>;

/** MediaBrief — V1 produces a brief, not images (plan §1.1, D19). */
export const mediaBriefSchema = z.object({
  mode: z.enum(['none', 'image_single', 'image_group']),
  subject: z.string().optional(),
  description: z.string().optional(),
  styleNotes: z.string().optional(),
  count: z.number().int().min(1).max(10).optional(),
});
export type MediaBrief = z.infer<typeof mediaBriefSchema>;

export const claimCoverageSchema = z.object({
  uncitedRatio: z.number().min(0).max(1),
  sentences: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      claimIds: z.array(z.string()),
      needsCitation: z.boolean(),
      hasCitation: z.boolean(),
      contradiction: z.boolean().default(false),
    }),
  ),
});
export type ClaimCoverage = z.infer<typeof claimCoverageSchema>;

/** Publish outcome — a discriminated union, no throw in the happy path (plan §10.2). */
export const publishOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    platformMessageId: z.string(),
    respondedAt: z.string(),
    deletableUntil: z.string().nullable(),
    editable: z.boolean(),
  }),
  z.object({ kind: z.literal('rate_limited'), retryAfterSeconds: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('rejected'), code: z.string(), description: z.string(), permanent: z.literal(true) }),
  z.object({ kind: z.literal('unauthorized'), description: z.string() }),
  z.object({ kind: z.literal('not_found'), description: z.string() }),
  z.object({
    kind: z.literal('uncertain'),
    reason: z.enum(['timeout', 'connection_reset', 'proxy_error']),
  }),
]);
export type PublishOutcome = z.infer<typeof publishOutcomeSchema>;

export const editOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), editedAt: z.string() }),
  z.object({ kind: z.literal('not_modified') }),
  z.object({ kind: z.literal('window_expired') }),
  z.object({ kind: z.literal('rate_limited'), retryAfterSeconds: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('rejected'), code: z.string(), description: z.string() }),
]);
export type EditOutcome = z.infer<typeof editOutcomeSchema>;

/** The narrow, versioned event type for the live bus (plan §13.3). The UI never parses raw OTLP. */
export const liveEventSchema = z.discriminatedUnion('t', [
  z.object({ v: z.literal(1), t: z.literal('run.state'), runId: z.string(), state: runStateSchema, at: z.string() }),
  z.object({ v: z.literal(1), t: z.literal('stage.start'), runId: z.string(), stage: z.string(), agentRef: z.string().optional(), zone: zoneSchema, at: z.string() }),
  z.object({
    v: z.literal(1), t: z.literal('stage.end'), runId: z.string(), stage: z.string(),
    ok: z.boolean(), ms: z.number(), costUsd: z.number().optional(), verdict: gateVerdictSchema.optional(), at: z.string(),
  }),
  z.object({
    v: z.literal(1), t: z.literal('model.call'), runId: z.string(), stage: z.string(),
    model: z.string(), inTok: z.number().int(), outTok: z.number().int(), ms: z.number(), costUsd: z.number(), at: z.string(),
  }),
  z.object({ v: z.literal(1), t: z.literal('tool.call'), runId: z.string(), stage: z.string(), capability: z.string(), ok: z.boolean(), at: z.string() }),
  z.object({ v: z.literal(1), t: z.literal('token'), runId: z.string(), stage: z.string(), delta: z.string() }),
  z.object({ v: z.literal(1), t: z.literal('approval'), runId: z.string(), gate: z.string(), state: z.string(), at: z.string() }),
  z.object({ v: z.literal(1), t: z.literal('cost'), runId: z.string(), spentUsd: z.number(), capUsd: z.number() }),
  z.object({ v: z.literal(1), t: z.literal('heartbeat'), at: z.string() }),
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;

/** Marker for the id field on live events. */
export const liveEventEnvelopeSchema = z.object({
  id: z.string(), // monotonic
  event: liveEventSchema,
});
export type LiveEventEnvelope = z.infer<typeof liveEventEnvelopeSchema>;
