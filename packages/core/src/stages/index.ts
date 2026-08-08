import type { Stage, ModelRequest, StageResult } from '../stage.js';
import { LANE_CONFIG } from '../runtime/transitions.js';
import type { Lane } from '@kanal/contracts';

/**
 * The pipeline stage registry (plan §9.2). All 16 pipeline stages plus the
 * nightly ones. Stages are thin: they parse input, call `ctx.model()` (through
 * the budget guard), and return their contract output. Non-LLM stages (ops.schedule,
 * ops.publish, measure.collect) are pure deterministic code.
 *
 * The topic gate (`strategy.topic_selection`) is NOT a stage: it is the
 * human-approval gate on the `researched → drafting` edge (plan §5.1). In
 * AUTO it is policy-signed; in CO-PILOT/MANUAL the human supplies the topic.
 */

// ---- strategy.brief (intake) -------------------------------------------------
interface BriefInput {
  rawBrief: string;
}
interface BriefOutput {
  title: string;
  intent: string;
  audience: string;
  topicSeed: string[];
  restrictions: string[];
}

const briefStage: Stage<BriefInput, BriefOutput> = {
  id: 'strategy.brief',
  optional: false,
  zone: 'trusted',
  inputContract: 'brief.input',
  outputContract: 'brief.output',
  async run(input, ctx) {
    const res = await ctx.model(briefRequest(input.rawBrief));
    const output = parseJson<BriefOutput>(res.text);
    if (!output.title) return stageErr('invalid_brief', 'brief did not parse', 'Return valid JSON with a title field.');
    return { ok: true, output };
  },
};

function briefRequest(raw: string): ModelRequest {
  return {
    stage: 'strategy.brief',
    messages: [
      { role: 'system', content: 'You turn a raw brief into a structured editorial brief. Return JSON only.' },
      { role: 'user', content: raw },
    ],
    temperature: 0.2,
    maxTokens: 1024,
  };
}

// ---- sourcing.rank --------------------------------------------------------------
interface RankInput {
  urls: string[];
}
interface RankOutput {
  ranked: Array<{ url: string; score: number; reason: string }>;
}
const rankStage: Stage<RankInput, RankOutput> = {
  id: 'sourcing.rank',
  optional: false,
  zone: 'quarantine',
  inputContract: 'rank.input',
  outputContract: 'rank.output',
  async run(input, ctx) {
    const res = await ctx.model({
      stage: 'sourcing.rank',
      messages: [
        { role: 'system', content: 'Rank these candidate URLs by relevance and credibility. Return JSON.' },
        { role: 'user', content: input.urls.join('\n') },
      ],
      temperature: 0,
      maxTokens: 2048,
    });
    const parsed = parseJson<RankOutput>(res.text);
    if (!Array.isArray(parsed.ranked)) return stageErr('invalid_rank', 'rank output not a list');
    return { ok: true, output: parsed };
  },
};

// ---- research.extract_claims -----------------------------------------------------
interface ClaimInput {
  ranked: Array<{ url: string; score: number }>;
}
interface ClaimOutput {
  claims: Array<{ text: string; source: string }>;
}
const extractClaimsStage: Stage<ClaimInput, ClaimOutput> = {
  id: 'research.extract_claims',
  optional: false,
  zone: 'trusted',
  inputContract: 'claims.input',
  outputContract: 'claims.output',
  async run(input, ctx) {
    const res = await ctx.model({
      stage: 'research.extract_claims',
      messages: [
        { role: 'system', content: 'Extract the factual claims from this material. Return a JSON list.' },
        { role: 'user', content: JSON.stringify(input.ranked) },
      ],
      temperature: 0,
      maxTokens: 2048,
    });
    const parsed = parseJson<ClaimOutput>(res.text);
    if (!Array.isArray(parsed.claims)) return stageErr('invalid_claims', 'claims not a list');
    return { ok: true, output: parsed };
  },
};

// ---- research.gap_check -----------------------------------------------------------
interface GapInput {
  claims: ClaimOutput['claims'];
}
interface GapOutput {
  gaps: string[];
  contradictions: string[];
}
const gapCheckStage: Stage<GapInput, GapOutput> = {
  id: 'research.gap_check',
  optional: false,
  zone: 'trusted',
  inputContract: 'gap.input',
  outputContract: 'gap.output',
  async run(input, ctx) {
    const res = await ctx.model({
      stage: 'research.gap_check',
      messages: [
        { role: 'system', content: 'Identify coverage gaps and contradictions in these claims. Return JSON.' },
        { role: 'user', content: JSON.stringify(input.claims) },
      ],
      temperature: 0.2,
      maxTokens: 1024,
    });
    const parsed = parseJson<GapOutput>(res.text);
    return {
      ok: true,
      output: {
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
        contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
      },
    };
  },
};

// ---- editorial.draft ----------------------------------------------------------------
interface DraftInput {
  claims: ClaimOutput['claims'];
  gaps: string[];
}
interface DraftOutput {
  bodyMd: string;
  claimMap: Record<string, string>;
  allowedUrls: string[];
}
const draftStage: Stage<DraftInput, DraftOutput> = {
  id: 'editorial.draft',
  optional: false,
  zone: 'trusted',
  inputContract: 'draft.input',
  outputContract: 'draft.output',
  async run(input, ctx) {
    const res = await ctx.model({
      stage: 'editorial.draft',
      messages: [
        { role: 'system', content: 'Write the channel post. Ground it in the provided claims; do not invent.' },
        { role: 'user', content: JSON.stringify(input) },
      ],
      temperature: 0.7,
      maxTokens: 2048,
    });
    const parsed = parseJson<DraftOutput>(res.text);
    if (!parsed.bodyMd) return stageErr('invalid_draft', 'no body_md in draft output');
    return {
      ok: true,
      output: {
        bodyMd: parsed.bodyMd,
        claimMap: parsed.claimMap ?? {},
        allowedUrls: Array.isArray(parsed.allowedUrls) ? parsed.allowedUrls : [],
      },
    };
  },
};

// ---- editorial.critique ----------------------------------------------------------------
interface CritiqueInput {
  bodyMd: string;
}
interface CritiqueOutput {
  score: number;
  issues: string[];
}
const critiqueStage: Stage<CritiqueInput, CritiqueOutput> = {
  id: 'editorial.critique',
  optional: false,
  zone: 'trusted',
  inputContract: 'critique.input',
  outputContract: 'critique.output',
  async run(input, ctx) {
    const res = await ctx.model({
      stage: 'editorial.critique',
      messages: [
        { role: 'system', content: 'Critique this post on a 0-100 score and list issues. Return JSON.' },
        { role: 'user', content: input.bodyMd },
      ],
      temperature: 0,
      maxTokens: 1024,
    });
    const parsed = parseJson<CritiqueOutput>(res.text);
    if (typeof parsed.score !== 'number') return stageErr('invalid_critique', 'no numeric score');
    return { ok: true, output: parsed };
  },
  gate(out) {
    // composite ≥ 0.72 (plan §15.2)
    return out.score >= 72 ? 'pass' : 'revise';
  },
};

// ---- editorial.revise -------------------------------------------------------------------
interface ReviseInput {
  bodyMd: string;
  issues: string[];
  attempts: number;
}
interface ReviseOutput {
  bodyMd: string;
}
const reviseStage: Stage<ReviseInput, ReviseOutput> = {
  id: 'editorial.revise',
  optional: false,
  zone: 'trusted',
  inputContract: 'revise.input',
  outputContract: 'revise.output',
  async run(input, ctx) {
    const res = await ctx.model({
      stage: 'editorial.revise',
      messages: [
        { role: 'system', content: `Rewrite addressing these issues (attempt ${input.attempts + 1}).` },
        { role: 'user', content: JSON.stringify({ text: input.bodyMd, issues: input.issues }) },
      ],
      temperature: 0.5,
      maxTokens: 2048,
    });
    return { ok: true, output: { bodyMd: res.text } };
  },
};

// ---- editorial.fact_check -----------------------------------------------------------------
interface FactCheckInput {
  bodyMd: string;
}
interface FactCheckOutput {
  coverage: Array<{ claim: string; verdict: 'supported' | 'refuted' | 'unknown'; note: string }>;
  uncitedRatio: number;
  contradiction: boolean;
}
const factCheckStage: Stage<FactCheckInput, FactCheckOutput> = {
  id: 'editorial.fact_check',
  optional: false,
  zone: 'trusted',
  inputContract: 'factcheck.input',
  outputContract: 'factcheck.output',
  async run(input, ctx) {
    const res = await ctx.model({
      stage: 'editorial.fact_check',
      messages: [
        { role: 'system', content: 'Fact-check this post. Return JSON {coverage, uncited_ratio, contradiction}.' },
        { role: 'user', content: input.bodyMd },
      ],
      temperature: 0,
      maxTokens: 2048,
    });
    const parsed = parseJson<FactCheckOutput>(res.text);
    const coverage = Array.isArray(parsed.coverage) ? parsed.coverage : [];
    const uncitedRatio = typeof parsed.uncitedRatio === 'number' ? parsed.uncitedRatio : 1;
    return { ok: true, output: { coverage, uncitedRatio, contradiction: !!parsed.contradiction } };
  },
};

// ---- format.render --------------------------------------------------------------------------
interface RenderInput {
  bodyMd: string;
}
interface RenderOutput {
  bodyRendered: string;
  splitPlan: number[];
  entities: string[];
}
const renderStage: Stage<RenderInput, RenderOutput> = {
  id: 'format.render',
  optional: false,
  zone: 'trusted',
  inputContract: 'render.input',
  outputContract: 'render.output',
  async run(input, ctx) {
    const res = await ctx.model({
      stage: 'format.render',
      messages: [
        { role: 'system', content: 'Render this post for Telegram HTML. Return JSON.' },
        { role: 'user', content: input.bodyMd },
      ],
      temperature: 0,
      maxTokens: 2048,
    });
    const parsed = parseJson<RenderOutput>(res.text);
    if (!parsed.bodyRendered) return stageErr('render_failed', 'no rendered body');
    return {
      ok: true,
      output: {
        bodyRendered: parsed.bodyRendered,
        splitPlan: Array.isArray(parsed.splitPlan) ? parsed.splitPlan : [],
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      },
    };
  },
};

// ---- studio.media_brief ----------------------------------------------------------------------
interface MediaBriefInput {
  bodyMd: string;
}
interface MediaBriefOutput {
  prompt: string;
  ratio: string;
  none: boolean;
}
const mediaBriefStage: Stage<MediaBriefInput, MediaBriefOutput> = {
  id: 'studio.media_brief',
  optional: true,
  zone: 'trusted',
  inputContract: 'mediabrief.input',
  outputContract: 'mediabrief.output',
  async run(input, ctx) {
    const res = await ctx.model({
      stage: 'studio.media_brief',
      messages: [
        { role: 'system', content: 'Write a media-generation prompt for this post, or return none. Return JSON.' },
        { role: 'user', content: input.bodyMd },
      ],
      temperature: 0.3,
      maxTokens: 1024,
    });
    const parsed = parseJson<MediaBriefOutput>(res.text);
    return {
      ok: true,
      output: {
        prompt: parsed.prompt ?? '',
        ratio: parsed.ratio ?? '16:9',
        none: parsed.none ?? !parsed.prompt,
      },
    };
  },
};

// ---- ops.policy_classify -----------------------------------------------------------------------
interface PolicyInput {
  bodyMd: string;
}
interface PolicyOutput {
  riskClass: number;
  isPromotional: boolean;
  prohibited: string[];
}
const policyStage: Stage<PolicyInput, PolicyOutput> = {
  id: 'ops.policy_classify',
  optional: false,
  zone: 'trusted',
  inputContract: 'policy.input',
  outputContract: 'policy.output',
  async run(input, ctx) {
    // deterministic: pattern match against the policy module (packages/safety)
    const out = await ctx.tool('policy.classify', { text: input.bodyMd });
    return { ok: true, output: out as unknown as PolicyOutput };
  },
};

// ---- quality.judge --------------------------------------------------------------------------------
interface JudgeInput {
  bodyMd: string;
  media: MediaBriefOutput | null;
}
interface JudgeOutput {
  verdict: 'pass' | 'revise' | 'block';
  score: number;
}
const judgeStage: Stage<JudgeInput, JudgeOutput> = {
  id: 'quality.judge',
  optional: true, // sampled 25% (plan §9.2 #12)
  zone: 'trusted',
  inputContract: 'judge.input',
  outputContract: 'judge.output',
  async run(input, ctx) {
    const res = await ctx.model({
      stage: 'quality.judge',
      messages: [
        { role: 'system', content: 'Final gate: return JSON {verdict: pass|revise|block, score}.' },
        { role: 'user', content: JSON.stringify(input) },
      ],
      temperature: 0,
      maxTokens: 1024,
    });
    const parsed = parseJson<JudgeOutput>(res.text);
    if (!parsed.verdict) return stageErr('invalid_judge', 'no verdict returned');
    return { ok: true, output: parsed };
  },
  gate(out) {
    // judges the trend series, never an individual post (§15.2)
    return out.verdict;
  },
};

// ---- ops.schedule (deterministic) --------------------------------------------------------------------
interface ScheduleInput {
  slot: string;
}
interface ScheduleOutput {
  scheduledFor: Date;
}
const scheduleStage: Stage<ScheduleInput, ScheduleOutput> = {
  id: 'ops.schedule',
  optional: false,
  zone: 'deterministic',
  inputContract: 'schedule.input',
  outputContract: 'schedule.output',
  async run() {
    return { ok: true, output: { scheduledFor: new Date() } };
  },
};

// ---- ops.publish (deterministic, idempotent) ----------------------------------------------------------
interface PublishInput {
  postId: string;
  revisionId: string;
  channelId: string;
  partIndex: number;
  bodyRendered: string;
}
interface PublishOutput {
  platformPostId: string;
}
const publishStage: Stage<PublishInput, PublishOutput> = {
  id: 'ops.publish',
  optional: false,
  zone: 'deterministic',
  inputContract: 'publish.input',
  outputContract: 'publish.output',
  async run(input, ctx) {
    // idempotency key: sha256(post_id|revision_id|channel_id|part_index) (§10.5)
    const out = await ctx.tool('platform.publish', input);
    return { ok: true, output: out as unknown as PublishOutput };
  },
};

// ---- measure.collect (deterministic) -------------------------------------------------------------------------------
interface CollectInput {
  platformPostId: string;
}
interface CollectOutput {
  views: number;
  reactions: number;
  comments: number;
}
const collectStage: Stage<CollectInput, CollectOutput> = {
  id: 'measure.collect',
  optional: false,
  zone: 'deterministic',
  inputContract: 'collect.input',
  outputContract: 'collect.output',
  async run(input, ctx) {
    const out = await ctx.tool('measure.metrics', { platformPostId: input.platformPostId });
    return { ok: true, output: out as unknown as CollectOutput };
  },
};

// ---- learn.aggregate (nightly, per channel) ----------------------------------------------------------------------------------
interface AggregateInput {
  metrics: CollectOutput[];
}
interface AggregateOutput {
  summary: string;
  voicePatch: string;
}
const aggregateStage: Stage<AggregateInput, AggregateOutput> = {
  id: 'learn.aggregate',
  optional: true,
  zone: 'trusted',
  inputContract: 'aggregate.input',
  outputContract: 'aggregate.output',
  async run(input, ctx) {
    const res = await ctx.model({
      stage: 'learn.aggregate',
      messages: [
        { role: 'system', content: 'Summarize what worked in this batch. Return JSON.' },
        { role: 'user', content: JSON.stringify(input.metrics) },
      ],
      temperature: 0.3,
      maxTokens: 1024,
    });
    const parsed = parseJson<AggregateOutput>(res.text);
    return { ok: true, output: { summary: parsed.summary ?? '', voicePatch: parsed.voicePatch ?? '' } };
  },
};

// ---- registry -------------------------------------------------------------------------------------------
const ALL_STAGES = [
  briefStage, rankStage, extractClaimsStage, gapCheckStage, draftStage, critiqueStage,
  reviseStage, factCheckStage, renderStage, mediaBriefStage, policyStage, judgeStage,
  scheduleStage, publishStage, collectStage, aggregateStage,
];

export const STAGES: Record<string, Stage<unknown, unknown>> = {};
for (const s of ALL_STAGES) STAGES[s.id] = s as unknown as Stage<unknown, unknown>;

/**
 * The canonical per-post pipeline (plan §9.2, stages 1–15), in order.
 * `learn.aggregate` is nightly, not per-post, so it is excluded here.
 */
export const PIPELINE: string[] = [
  'strategy.brief',
  'sourcing.rank',
  'research.extract_claims',
  'research.gap_check',
  'editorial.draft',
  'editorial.critique',
  'editorial.revise',
  'editorial.fact_check',
  'format.render',
  'studio.media_brief',
  'ops.policy_classify',
  'quality.judge',
  'ops.schedule',
  'ops.publish',
  'measure.collect',
];

export const NIGHTLY_STAGES: string[] = ['learn.aggregate'];

/**
 * Which stages a lane skips (plan §5.1, "stages skipped" column).
 * These are resolved at runtime by the worker, not at registry time.
 */
export function stagesSkippedForLane(lane: Lane): string[] {
  return LANE_CONFIG[lane].skipStages;
}

export function isStageSkipped(stageId: string, lane: Lane): boolean {
  return LANE_CONFIG[lane].skipStages.includes(stageId);
}

// ---- helpers --------------------------------------------------------------------------------------------
function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

function stageErr(code: string, message: string, repairHint?: string): StageResult<never> {
  return { ok: false, error: { code, message, repairHint } };
}
