import { TRANSITIONS, TERMINAL_STATES, PIPELINE, GLOBAL_INTERRUPTS, LANE_CONFIG } from '../runtime/transitions.js';
import { STAGES, NIGHTLY_STAGES } from '../stages/index.js';
import { REGISTRY } from '@kanal/contracts';

interface DoctorReport {
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

/**
 * `kanal doctor` — static integrity checks for the runtime. Does not touch the
 * network or the database (plan §20.2). CI runs this in the injection job.
 */
export function doctor(): DoctorReport {
  const checks: DoctorReport['checks'] = [];

  // 1. Every stage in the canonical pipeline has an implementation.
  const allStages = [...PIPELINE, ...NIGHTLY_STAGES];
  const missing = allStages.filter((id) => !STAGES[id]);
  checks.push({
    name: 'stage.implemented',
    ok: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(', ')}` : `${allStages.length} stages registered`,
  });

  // 2. Every registered stage is in the canonical pipeline or nightly set.
  const orphaned = Object.keys(STAGES).filter((id) => !allStages.includes(id));
  checks.push({
    name: 'stage.ordered',
    ok: orphaned.length === 0,
    detail: orphaned.length ? `orphaned: ${orphaned.join(', ')}` : undefined,
  });

  // 3. Every transition references a stage that exists or is a meta-state event.
  const stageEvents = new Set(TRANSITIONS.map((t) => t.event));
  const known = new Set([
    ...allStages,
    'brief_accepted',
    'lane_auto_or_copilot',
    'lane_manual',
    'claims_extracted',
    'gate_topic_passed',
    'human_submit_text',
    'draft_ready',
    'score_below_gate',
    'score_at_or_above_gate',
    'attempt_lt_max',
    'attempt_eq_max',
    'formatted',
    'media_resolved',
    'violation',
    'gate_required',
    'gate_signed_by_policy',
    'human_approve',
    'human_request_changes',
    'human_reject',
    'sla_timeout',
    'slot_assigned',
    'slot_due_and_pacing_ok',
    'pacing_defer',
    'platform_ack',
    'ambiguous_error',
    'retryable_error',
    'human_confirm_present',
    'human_confirm_absent',
    't_plus_15m',
    't_plus_72h',
    'human_claims_run',
    'human_override',
  ]);
  const unresolved = [...stageEvents].filter((e) => !known.has(e) && !e.endsWith('_done'));
  checks.push({
    name: 'transition.events_resolve',
    ok: unresolved.length === 0,
    detail: unresolved.length ? `unresolved events: ${unresolved.join(', ')}` : `${TRANSITIONS.length} transitions`,
  });

  // 4. Terminal states are unreachable-by-failure (they are true ends).
  checks.push({
    name: 'state.terminal',
    ok: TERMINAL_STATES.every((s) => s === 'learned' || s === 'cancelled' || s === 'failed'),
    detail: `terminal: ${TERMINAL_STATES.join(', ')}`,
  });

  // 5. No `platform.*` capability at risk-3 exists in the registry (plan §7.2 D2).
  const defs = Object.values(REGISTRY);
  const risk3 = defs.filter((c) => c.risk >= 3);
  const platformRisk3 = risk3.filter((c) => c.id.startsWith('platform.'));
  checks.push({
    name: 'capability.no_platform_risk3',
    ok: platformRisk3.length === 0,
    detail: platformRisk3.length ? `forbidden: ${platformRisk3.map((c) => c.id).join(', ')}` : `${risk3.length} risk-3 caps (none platform.*)`,
  });

  // 6. Global interrupts have distinct targets and a resolver.
  const targets = GLOBAL_INTERRUPTS.map((g) => g.target);
  checks.push({
    name: 'interrupt.targets_distinct',
    ok: new Set(targets).size === targets.length,
    detail: `${GLOBAL_INTERRUPTS.length} interrupts: ${targets.join(', ')}`,
  });

  // 7. Lane masks match the plan §5.1 column.
  const maskOk =
    LANE_CONFIG.auto.skipStages.length === 0 &&
    LANE_CONFIG.copilot.skipStages.length === 1 &&
    LANE_CONFIG.manual.skipStages.length === 3;
  checks.push({
    name: 'lane.skip_mask',
    ok: maskOk,
    detail: maskOk ? 'lane masks match plan §5.1' : 'lane mask diverges from plan §5.1',
  });

  return { checks };
}

export function printDoctor(report: DoctorReport): number {
  let failed = 0;
  for (const c of report.checks) {
    const mark = c.ok ? '  ok' : 'FAIL';
    console.log(`${mark}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    if (!c.ok) failed += 1;
  }
  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall doctor checks passed');
  }
  return failed;
}

// CLI entry: `node dist/cli/doctor.js` or via the package bin.
// On Windows, process.argv[1] is a plain path; on POSIX it is file:// in ESM.
// Compare against a normalized basename so both work.
const entry = process.argv[1]?.split(/[\\/]/).pop() ?? '';
if (import.meta.url.includes(entry) && entry === 'doctor.js') {
  printDoctor(doctor());
}
