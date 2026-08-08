import { describe, it, expect } from 'vitest';
import { TRANSITIONS, TERMINAL_STATES, INTERRUPT_STATES, GLOBAL_INTERRUPTS, LANE_CONFIG, PIPELINE } from '../src/runtime/transitions.js';
import { STAGES, isStageSkipped, stagesSkippedForLane, NIGHTLY_STAGES } from '../src/stages/index.js';
import { REGISTRY } from '@kanal/contracts';

describe('transition table (§5.3)', () => {
  it('has an entry for every stage in the canonical pipeline (§9.2)', () => {
    for (const id of PIPELINE) {
      expect(STAGES[id], `missing stage ${id}`).toBeDefined();
    }
  });

  it('has no orphaned stage implementations', () => {
    const known = new Set([...PIPELINE, ...NIGHTLY_STAGES]);
    for (const id of Object.keys(STAGES)) {
      expect(known, `orphan ${id}`).toContain(id);
    }
  });

  it('global interrupts target distinct states', () => {
    const targets = GLOBAL_INTERRUPTS.map((g) => g.target);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('no risk-3 platform capability exists (plan §7.2 D2)', () => {
    const defs = Object.values(REGISTRY);
    const risk3 = defs.filter((c) => c.risk >= 3);
    expect(risk3.filter((c) => c.id.startsWith('platform.'))).toHaveLength(0);
  });

  it('lane skip masks match the plan §5.1 column', () => {
    expect(LANE_CONFIG.auto.skipStages).toEqual([]);
    expect(LANE_CONFIG.copilot.skipStages).toEqual(['strategy.topic_selection']);
    expect(LANE_CONFIG.manual.skipStages).toEqual([
      'strategy.topic_selection',
      'research.claim_extraction',
      'editorial.draft',
    ]);
  });

  it('isStageSkipped matches the lane table', () => {
    expect(isStageSkipped('strategy.topic_selection', 'copilot')).toBe(true);
    expect(isStageSkipped('editorial.draft', 'manual')).toBe(true);
    expect(isStageSkipped('editorial.draft', 'auto')).toBe(false);
    expect(stagesSkippedForLane('manual')).toEqual(LANE_CONFIG.manual.skipStages);
  });

  it('every transition has a known from state', () => {
    const allStates = new Set(TRANSITIONS.flatMap((t) => [t.from, t.to]));
    for (const t of TRANSITIONS) {
      expect(allStates).toContain(t.from);
    }
  });
});

describe('states (§5.2)', () => {
  it('terminal and interrupt states are disjoint', () => {
    for (const t of TERMINAL_STATES) {
      expect(INTERRUPT_STATES).not.toContain(t);
    }
  });
});
