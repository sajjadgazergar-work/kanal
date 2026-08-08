import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { STAGES, BudgetExceeded, StepBudgetExceeded, guardedCall, type PriceTable, type RunCtx } from '@kanal/core';
import type { ModelRequest, ModelResponse } from '@kanal/core';
import type { Lane } from '@kanal/contracts';
import { setOrgContext } from './db.js';
import { TOOL_REGISTRY } from './toolRegistry.js';

/**
 * The pipeline role (plan §12.7, §9.2). A pipeline job carries a run id and the
 * stage to execute; the worker resumes the run by:
 *
 *   1. loading the run row + setting the org context,
 *   2. threading the previous stage's output as this stage's input — the
 *      durable stage-output thread lives in `run_step.output`, so stage inputs
 *      are never held in memory (§5.4),
 *   3. running the stage via `STAGES[stageId].run(input, ctx)` through the
 *      budget guard (§7.8),
 *   4. recording the step, persisting the stage output, and charging spend,
 *   5. advancing the state machine via `runner.advance` — which applies the
 *      transition, handles human gates (parking the run), and enqueues the
 *      next pipeline job.
 *
 * All 16 canonical stages (plan §9.2) live in `@kanal/core`; this module only
 * wires them. Deterministic tools (policy.classify, platform.publish,
 * measure.metrics) live in `toolRegistry.ts`.
 */

export interface PipelineJobPayload {
  runId: string;
  state?: string;
  stage?: string;
  attempt?: number;
}

interface RunRow {
  id: string;
  org_id: string;
  channel_id: string;
  lane: Lane;
  state: string;
  cursor_stage: string;
  brief: Record<string, unknown>;
  budget_cap_usd: number;
  spent_usd: number;
  cancel_requested: boolean;
}

/** The provider adapter the worker uses for model calls (dials @kanal/providers). */
export type ProviderClient = {
  chat(req: ModelRequest): Promise<ModelResponse>;
  priceOf(modelRef: string): ReturnType<PriceTable['get']>;
};

/** Resolve the zone for a stage id (plan §7.2, §12.7). */
function zoneForStage(stageId: string): 'quarantine' | 'trusted' | 'deterministic' {
  if (stageId === 'sourcing.rank') return 'quarantine';
  if (['ops.schedule', 'ops.publish', 'measure.collect'].includes(stageId)) return 'deterministic';
  return 'trusted';
}

/** sha256 hex — used for step idempotency keys (plan §5.4) and input hashes. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Deterministic idempotency key for a step (plan §5.4). */
export function stepIdemKey(runId: string, stage: string, attempt: number): string {
  return sha256Hex(`${runId}|${stage}|${attempt}`);
}

export function createPipelineHandler(
  db: NodePgDatabase,
  advance: (runId: string, event: string) => Promise<void>,
  provider: ProviderClient,
  opts: { stepMaxUsd?: number } = {},
): (job: PipelineJobPayload) => Promise<void> {
  const stepMaxUsd = opts.stepMaxUsd ?? 2.0;

  return async function handle(job: PipelineJobPayload): Promise<void> {
    const run = await loadRun(db, job.runId);
    if (!run) return; // run deleted — nothing to do
    if (run.cancel_requested || run.state === 'cancelled') return;

    await setOrgContext(db, run.org_id);

    // Which stage to run next. The job may carry an explicit stage (from the
    // heartbeat reclaimer); otherwise it resolves from the run state.
    const stageId = job.stage ?? nextStageForState(run.state);
    if (!stageId) return;

    const stage = STAGES[stageId];
    if (!stage) {
      console.error(`[pipeline] unknown stage ${stageId} for run ${job.runId}`);
      return;
    }

    // Build the stage input from the durable thread of prior outputs.
    const priorOutput = await lastStageOutput(db, run.id);
    const input = stageInputFor(stageId, run, priorOutput);

    // Budget state, loaded per run (plan §7.8).
    const budgetState = {
      runSpentUsd: Number(run.spent_usd),
      runCapUsd: Number(run.budget_cap_usd),
      stepMaxUsd,
      priceTable: { get: (m: string) => provider.priceOf(m) },
    };

    const ctx: RunCtx = {
      run: {
        id: run.id,
        orgId: run.org_id,
        channelId: run.channel_id,
        lane: run.lane,
        state: run.state as RunCtx['run']['state'],
        brief: run.brief,
        budgetCapUsd: Number(run.budget_cap_usd),
        spentUsd: Number(run.spent_usd),
        cancelRequested: run.cancel_requested,
      },
      model: async (req) => guardedCall(budgetState, req, (r) => provider.chat(r)),
      tool: async (capabilityId, args) => {
        // Capability registry (plan §7.2) — the worker's deterministic tools
        // live in `toolRegistry.ts`. No `platform.*` free-for-all: only the
        // three registered capabilities resolve.
        const t = TOOL_REGISTRY[capabilityId];
        if (!t) throw new Error(`unknown capability ${capabilityId}`);
        return t(args, ctx);
      },
      memoized: <T>(key: string, fn: () => Promise<T>) => memoize(db, run.org_id, run.id, stageId, key, fn),
      log: (evt) => {
        void recordEvent(db, run.org_id, run.id, evt);
      },
    };

    // Record the step as in_flight with a heartbeat before running (plan §5.4).
    const stepId = await beginStep(db, run, stageId, job.attempt ?? 1, zoneForStage(stageId));
    const startedAt = Date.now();
    try {
      const result = await stage.run(input, ctx);
      const ms = Date.now() - startedAt;

      if (!result.ok) {
        await failStep(db, stepId, result.error.code, result.error.message, ms);
        await setRunError(db, run.id, result.error.code, result.error.message);
        return;
      }

      // If this stage consumed a publish intent (ops.publish), record the
      // platform result before completing the step.
      if (stageId === 'ops.publish') {
        await recordPublishAttempt(db, run, input, result.output);
      }

      await completeStep(db, stepId, result.output, ms);

      // Persist actual spend from the budget state after the call.
      await chargeRun(db, run.id, budgetState.runSpentUsd);

      // Advance the state machine — applies the transition for this stage's
      // completion event, gates (parking for human approval when on), and
      // enqueues the next pipeline job.
      const event = eventForStage(stageId, result.output, run.lane);
      await advance(run.id, event);
    } catch (err) {
      if (err instanceof BudgetExceeded || err instanceof StepBudgetExceeded) {
        // The budget guard trips a global interrupt (§5.2): park the run in
        // blocked_budget. It resumes via GLOBAL_INTERRUPTS.human_raise_or_downtier.
        const code = err instanceof BudgetExceeded ? 'budget_guard_trip' : 'step_budget_exceeded';
        console.warn(`[pipeline] ${code} at ${stageId} for run ${job.runId}: ${err.message}`);
        await failStep(db, stepId, code, err.message, Date.now() - startedAt);
        await setRunError(db, run.id, code, err.message);
        return;
      }
      console.error(`[pipeline] stage ${stageId} failed for run ${job.runId}`, err);
      await failStep(db, stepId, 'stage_crash', String(err), Date.now() - startedAt);
    }
  };
}

// ---- helpers -----------------------------------------------------------------

/**
 * Resolve the next stage from the run state. `runner.advance` moves the state
 * machine forward; this maps the current state to the stage that must run to
 * satisfy it. When a job carries an explicit stage (reclaimer), that wins.
 */
function nextStageForState(state: string): string | null {
  const MAP: Record<string, string> = {
    intake: 'strategy.brief',
    briefed: 'sourcing.rank',
    sourcing: 'research.extract_claims',
    researched: 'research.gap_check',
    authoring: 'editorial.draft',
    drafting: 'editorial.draft',
    critiquing: 'editorial.critique',
    revising: 'editorial.revise',
    formatting: 'format.render',
    media_pending: 'studio.media_brief',
    policy_check: 'ops.policy_classify',
    review_pending: 'quality.judge',
    approved: 'ops.schedule',
    scheduled: 'ops.publish',
    publishing: 'measure.collect',
    measuring: 'measure.collect',
  };
  return MAP[state] ?? null;
}

/**
 * The event that advances the state machine on successful completion of a
 * stage. These match the transition table events in `@kanal/core`
 * (runtime/transitions.ts).
 */
function eventForStage(stageId: string, output: unknown, lane: Lane): string {
  switch (stageId) {
    case 'strategy.brief': return 'brief_accepted';
    case 'sourcing.rank': return lane === 'manual' ? 'lane_manual' : 'lane_auto_or_copilot';
    case 'research.extract_claims': return 'claims_extracted';
    case 'research.gap_check': return 'gate_topic_passed';
    case 'editorial.draft': return 'draft_ready';
    case 'editorial.critique': {
      const score = (output as { score?: number } | null)?.score ?? 0;
      return score >= 72 ? 'score_at_or_above_gate' : 'score_below_gate';
    }
    case 'editorial.revise': return 'attempt_lt_max';
    case 'editorial.fact_check': {
      // uncited_ratio ≤ 0.35 passes; any contradiction → human (plan §9.2 #8).
      const f = output as { uncitedRatio?: number; contradiction?: boolean } | null;
      if (f?.contradiction) return 'gate_required';
      return (f?.uncitedRatio ?? 1) <= 0.35 ? 'formatted' : 'gate_required';
    }
    case 'format.render': return 'formatted';
    case 'studio.media_brief': return 'media_resolved';
    case 'ops.policy_classify': {
      const p = output as { prohibited?: string[]; riskClass?: number } | null;
      const prohibited = Array.isArray(p?.prohibited) && p.prohibited.length > 0;
      const highRisk = (p?.riskClass ?? 0) >= 2;
      return prohibited || highRisk ? 'violation' : 'gate_required';
    }
    case 'quality.judge': return 'gate_required';
    case 'ops.schedule': return 'slot_assigned';
    case 'ops.publish': {
      const o = output as { uncertain?: boolean; platformPostId?: string } | null;
      if (o?.uncertain) return 'ambiguous_error';
      return o?.platformPostId ? 'platform_ack' : 'retryable_error';
    }
    case 'measure.collect': return 't_plus_15m';
    default: return 'brief_accepted';
  }
}

/**
 * Build the input object a stage expects by merging the run's static context
 * (brief, channel) with the prior stage's output. Stage contracts are in
 * `@kanal/core` (stages/index.ts); the mapping below follows plan §9.2.
 */
function stageInputFor(stageId: string, run: RunRow, prior: Record<string, unknown>): unknown {
  const brief = run.brief;
  switch (stageId) {
    case 'strategy.brief':
      return { rawBrief: typeof brief.rawBrief === 'string' ? brief.rawBrief : JSON.stringify(brief) };
    case 'sourcing.rank':
      return { urls: Array.isArray(prior.ranked) ? prior.ranked.map((r) => (r as { url: string }).url) : Array.isArray(brief.urls) ? brief.urls : [] };
    case 'research.extract_claims':
      return { ranked: Array.isArray(prior.ranked) ? prior.ranked : [] };
    case 'research.gap_check':
      return { claims: Array.isArray(prior.claims) ? prior.claims : [] };
    case 'editorial.draft':
      return {
        claims: Array.isArray(prior.claims) ? prior.claims : [],
        gaps: Array.isArray(prior.gaps) ? prior.gaps : [],
      };
    case 'editorial.critique':
      return { bodyMd: typeof prior.bodyMd === 'string' ? prior.bodyMd : '' };
    case 'editorial.revise': {
      const attempt = run.cursor_stage === 'critiquing' ? 1 : Number(prior.attempt ?? 0);
      return {
        bodyMd: typeof prior.bodyMd === 'string' ? prior.bodyMd : '',
        issues: Array.isArray(prior.issues) ? prior.issues : [],
        attempts: attempt,
      };
    }
    case 'editorial.fact_check':
      return { bodyMd: typeof prior.bodyMd === 'string' ? prior.bodyMd : '' };
    case 'format.render':
      return { bodyMd: typeof prior.bodyMd === 'string' ? prior.bodyMd : '' };
    case 'studio.media_brief':
      return { bodyMd: typeof prior.bodyMd === 'string' ? prior.bodyMd : '' };
    case 'ops.policy_classify':
      return { bodyMd: typeof prior.bodyMd === 'string' ? prior.bodyMd : '' };
    case 'quality.judge':
      return { bodyMd: typeof prior.bodyMd === 'string' ? prior.bodyMd : '', media: prior.media ?? null };
    case 'ops.schedule':
      return { slot: 'next' };
    case 'ops.publish':
      // ops.publish reads the open publish_intent for the run; the stage input
      // carries the resolved revision body so the tool call is pure and
      // idempotent. The intent row is consumed AFTER a successful publish.
      return { postId: run.id, revisionId: '', channelId: run.channel_id, partIndex: 0, bodyRendered: typeof prior.bodyRendered === 'string' ? prior.bodyRendered : '' };
    case 'measure.collect':
      return { platformPostId: typeof prior.platformPostId === 'string' ? prior.platformPostId : '' };
    default:
      return {};
  }
}

async function loadRun(db: NodePgDatabase, runId: string): Promise<RunRow | null> {
  const rows = await db.execute(sql`
    SELECT id, org_id, channel_id, lane, state, cursor_stage, brief, budget_cap_usd, spent_usd, cancel_requested
    FROM run WHERE id = ${runId};
  `);
  return (rows.rows[0] as unknown as RunRow | undefined) ?? null;
}

/** The durable stage-output thread: the output of the latest done step. */
async function lastStageOutput(db: NodePgDatabase, runId: string): Promise<Record<string, unknown>> {
  const rows = await db.execute(sql`
    SELECT output FROM run_step
    WHERE run_id = ${runId} AND state = 'done' AND output IS NOT NULL
    ORDER BY started_at DESC LIMIT 1;
  `);
  const row = rows.rows[0] as unknown as { output: Record<string, unknown> } | undefined;
  return row?.output ?? {};
}

async function beginStep(
  db: NodePgDatabase,
  run: RunRow,
  stage: string,
  attempt: number,
  zone: 'quarantine' | 'trusted' | 'deterministic',
): Promise<string> {
  const idem = stepIdemKey(run.id, stage, attempt);
  const rows = await db.execute(sql`
    INSERT INTO run_step (org_id, run_id, stage, attempt, agent_ref, zone, idempotency_key, input_hash, state, started_at, heartbeat_at)
    VALUES (${run.org_id}, ${run.id}, ${stage}, ${attempt}, 'agent:worker', ${zone},
            ${idem}::bytea, ${idem}::bytea, 'in_flight', now(), now())
    ON CONFLICT (run_id, stage, attempt) DO UPDATE SET state='in_flight', heartbeat_at=now()
    RETURNING id;
  `);
  return (rows.rows[0] as unknown as { id: string }).id;
}

async function completeStep(
  db: NodePgDatabase,
  stepId: string,
  output: unknown,
  ms: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE run_step SET state='done', output=${JSON.stringify(output)}::jsonb,
      latency_ms=${ms}, finished_at=now()
    WHERE id = ${stepId};
  `);
}

async function failStep(
  db: NodePgDatabase,
  stepId: string,
  code: string,
  message: string,
  ms: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE run_step SET state='failed', error=${JSON.stringify({ code, message })}::jsonb,
      latency_ms=${ms}, finished_at=now()
    WHERE id = ${stepId};
  `);
}

async function setRunError(db: NodePgDatabase, runId: string, code: string, detail: string): Promise<void> {
  await db.execute(sql`UPDATE run SET error_code=${code}, error_detail=${detail} WHERE id=${runId}`);
}

async function chargeRun(db: NodePgDatabase, runId: string, spentUsd: number): Promise<void> {
  await db.execute(sql`UPDATE run SET spent_usd=${spentUsd} WHERE id=${runId}`);
}

/**
 * Record a publish_attempt row from a consumed publish_intent. Reads the open
 * intent for the run, marks it consumed, and inserts the attempt. Never
 * auto-retried on `uncertain` (plan §10.6).
 */
async function recordPublishAttempt(
  db: NodePgDatabase,
  run: RunRow,
  input: unknown,
  output: unknown,
): Promise<void> {
  const intent = await db.execute(sql`
    SELECT id, post_id, revision_id, channel_id FROM publish_intent
    WHERE run_id = ${run.id} AND consumed = false
    ORDER BY created_at LIMIT 1;
  `);
  const row = intent.rows[0] as unknown as { id: string; post_id: string; revision_id: string; channel_id: string } | undefined;
  if (!row) return;
  const out = output as { platformPostId?: string; uncertain?: boolean; detail?: string } | null;
  const o = out ?? {};
  const partIndex = typeof (input as { partIndex?: number }).partIndex === 'number' ? (input as { partIndex: number }).partIndex : 0;
  const idem = sha256Hex(`${row.post_id}|${row.revision_id}|${row.channel_id}|${partIndex}`);
  await db.execute(sql`
    INSERT INTO publish_attempt (org_id, post_id, revision_id, channel_id, platform, idempotency_key, state,
                                 platform_message_id, responded_at, platform_error_desc, attempt_no)
    VALUES (${run.org_id}, ${row.post_id}, ${row.revision_id}, ${row.channel_id}, 'telegram',
            ${idem}::bytea,
            ${o.uncertain ? 'uncertain' : o.platformPostId ? 'succeeded' : 'failed'},
            ${o.platformPostId ?? null}, now(), ${o.detail ?? null}, 1)
    ON CONFLICT (idempotency_key) DO NOTHING;
  `);
  // Mark the intent consumed so a retry of the same run does not re-read it.
  await db.execute(sql`UPDATE publish_intent SET consumed=true, consumed_at=now() WHERE id=${row.id}`);
}

async function recordEvent(
  db: NodePgDatabase,
  orgId: string,
  runId: string,
  evt: { t: string; [k: string]: unknown },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_event (org_id, actor, verb, object_ref, after)
    VALUES (${orgId}, 'agent:worker', ${evt.t}, ${runId}, ${JSON.stringify(evt)}::jsonb);
  `);
}

/**
 * Memo store (plan §5.4): memoized outputs keyed by the step idempotency key.
 * A completed model call is never re-spent — the stored `run_step.output` is
 * returned on a duplicate run.
 */
async function memoize<T>(
  db: NodePgDatabase,
  orgId: string,
  runId: string,
  stage: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const idem = stepIdemKey(runId, stage, 1);
  const rows = await db.execute(sql`
    SELECT output FROM run_step
    WHERE run_id = ${runId} AND stage = ${stage} AND state = 'done'
    ORDER BY finished_at DESC LIMIT 1;
  `);
  const hit = rows.rows[0] as unknown as { output: T } | undefined;
  if (hit !== undefined) return hit.output;
  const value = await fn();
  // Persist under the deterministic key so a crash-and-retry reuses it.
  await db.execute(sql`
    INSERT INTO run_step (org_id, run_id, stage, attempt, agent_ref, zone, idempotency_key, input_hash, state, output, started_at, finished_at)
    VALUES (${orgId}, ${runId}, ${stage}, 0, 'agent:worker', 'trusted',
            ${idem}::bytea, ${idem}::bytea, 'done', ${JSON.stringify(value)}::jsonb, now(), now())
    ON CONFLICT (run_id, stage, attempt) DO NOTHING;
  `);
  return value;
}
