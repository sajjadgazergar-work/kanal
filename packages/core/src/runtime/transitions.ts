import type { RunState, GateKind } from '@kanal/contracts';

/**
 * The transition table (plan §5.3): guards, gates, timeouts, failure paths for
 * every edge in the state machine diagram (§5.2). This is a declarative spec —
 * the PgRunner walks these rows.
 */
export interface Transition {
  from: RunState;
  to: RunState;
  event: string;
  guard?: string; // name of a deterministic guard function
  gate?: GateKind;
  /** seconds after which the run parks or moves on */
  timeoutS?: number;
  onTimeout?: { target: RunState; errorCode: string };
  /** what happens on guard failure */
  onFailure?: { target: RunState; errorCode: string };
}

export const TRANSITIONS: Transition[] = [
  { from: 'intake', to: 'briefed', event: 'brief_accepted', guard: 'brief_schema_valid', timeoutS: 6 * 3600, onTimeout: { target: 'cancelled', errorCode: 'intake_timeout' }, onFailure: { target: 'failed', errorCode: 'brief_schema_invalid' } },
  { from: 'briefed', to: 'sourcing', event: 'lane_auto_or_copilot', guard: 'lane_ok' },
  { from: 'briefed', to: 'authoring', event: 'lane_manual', guard: 'lane_manual' },
  { from: 'sourcing', to: 'researched', event: 'claims_extracted', guard: 'material_found', timeoutS: 120, onTimeout: { target: 'cancelled', errorCode: 'sourcing_timeout' }, onFailure: { target: 'cancelled', errorCode: 'no_material' } },
  { from: 'researched', to: 'drafting', event: 'gate_topic_passed', gate: 'topic', timeoutS: 6 * 3600, onTimeout: { target: 'researched', errorCode: 'topic_gate_timeout' } },
  { from: 'authoring', to: 'drafting', event: 'human_submit_text', guard: 'text_present' },
  { from: 'drafting', to: 'critiquing', event: 'draft_ready', guard: 'draft_valid' },
  { from: 'critiquing', to: 'revising', event: 'score_below_gate', guard: 'below_gate' },
  { from: 'critiquing', to: 'formatting', event: 'score_at_or_above_gate', guard: 'at_or_above_gate' },
  { from: 'revising', to: 'critiquing', event: 'attempt_lt_max', guard: 'attempt_lt_max' },
  { from: 'revising', to: 'escalated', event: 'attempt_eq_max', guard: 'attempt_eq_max' },
  { from: 'formatting', to: 'media_pending', event: 'formatted', guard: 'format_valid' },
  { from: 'media_pending', to: 'policy_check', event: 'media_resolved', guard: 'media_resolved' },
  { from: 'policy_check', to: 'blocked_policy', event: 'violation', guard: 'policy_violation' },
  { from: 'policy_check', to: 'review_pending', event: 'gate_required', guard: 'gate_required' },
  { from: 'policy_check', to: 'scheduled', event: 'gate_signed_by_policy', guard: 'policy_signed' },
  { from: 'review_pending', to: 'approved', event: 'human_approve', guard: 'payload_hash_matches' },
  { from: 'review_pending', to: 'revising', event: 'human_request_changes', guard: 'always' },
  { from: 'review_pending', to: 'cancelled', event: 'human_reject', guard: 'always' },
  { from: 'review_pending', to: 'escalated', event: 'sla_timeout', guard: 'sla_expired' },
  { from: 'approved', to: 'scheduled', event: 'slot_assigned', guard: 'slot_legal' },
  { from: 'scheduled', to: 'publishing', event: 'slot_due_and_pacing_ok', guard: 'slot_due', timeoutS: 20 * 60, onTimeout: { target: 'cancelled', errorCode: 'slot_missed' } },
  { from: 'scheduled', to: 'scheduled', event: 'pacing_defer', guard: 'pacing_defers' },
  { from: 'publishing', to: 'published', event: 'platform_ack', guard: 'ack_received' },
  { from: 'publishing', to: 'publish_uncertain', event: 'ambiguous_error', guard: 'ambiguous' },
  { from: 'publishing', to: 'scheduled', event: 'retryable_error', guard: 'retryable' },
  { from: 'publish_uncertain', to: 'published', event: 'human_confirm_present', guard: 'always' },
  { from: 'publish_uncertain', to: 'cancelled', event: 'human_confirm_absent', guard: 'always' },
  { from: 'published', to: 'measuring', event: 't_plus_15m', guard: 'always', timeoutS: 15 * 60 },
  { from: 'measuring', to: 'learned', event: 't_plus_72h', guard: 'always', timeoutS: 72 * 3600 },
  { from: 'escalated', to: 'review_pending', event: 'human_claims_run', guard: 'always' },
  { from: 'blocked_policy', to: 'review_pending', event: 'human_override', guard: 'always' },
  { from: 'blocked_policy', to: 'cancelled', event: 'human_reject', guard: 'always' },
];

/** Global interrupts (plan §5.2) — fire from any non-terminal state. */
export interface GlobalInterrupt {
  event: string;
  target: RunState;
  resolveEvent: string;
  /** 'any' means the run resumes from wherever it was */
  resolveTarget: RunState | 'any';
}

export const GLOBAL_INTERRUPTS: GlobalInterrupt[] = [
  { event: 'budget_guard_trip', target: 'blocked_budget', resolveEvent: 'human_raise_or_downtier', resolveTarget: 'any' },
  { event: 'all_providers_unhealthy', target: 'blocked_provider', resolveEvent: 'provider_healthy', resolveTarget: 'any' },
  { event: 'kill_switch', target: 'halted', resolveEvent: 'human_resume', resolveTarget: 'any' },
];

export const TERMINAL_STATES: RunState[] = ['learned', 'cancelled', 'failed'];
export const INTERRUPT_STATES: RunState[] = ['blocked_budget', 'blocked_provider', 'halted'];

/**
 * Lane → gate set + stage mask (plan §5.1). `skipStages` matches the plan's
 * "stages skipped" column exactly. Note these names follow the plan (§9.2):
 * `strategy.topic_selection` is the topic gate (not a pipeline stage),
 * `research.claim_extraction` is the ingest-side claim extraction (not the
 * `research.extract_claims` pipeline stage), and `editorial.draft` is skipped
 * in MANUAL because the human text is the draft.
 */
export interface LaneConfig {
  gates: { topic: boolean; draft: boolean; publish: boolean };
  skipStages: string[];
}

export const LANE_CONFIG: Record<'auto' | 'copilot' | 'manual', LaneConfig> = {
  auto: { gates: { topic: true, draft: false, publish: true }, skipStages: [] },
  copilot: { gates: { topic: false, draft: true, publish: true }, skipStages: ['strategy.topic_selection'] },
  manual: { gates: { topic: false, draft: true, publish: true }, skipStages: ['strategy.topic_selection', 'research.claim_extraction', 'editorial.draft'] },
};

/** The canonical per-post pipeline (plan §9.2, stages 1–15). */
export const PIPELINE = [
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
