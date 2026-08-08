import { describe, expect, it } from 'vitest';
import type { ClaimCoverage, Brief } from '@kanal/contracts';
import { evaluate } from '../evaluate.js';
import { EN_VOICE } from '../voice/en.js';
import { DEFAULT_GATE_POLICY, evaluateGate, type GatePolicy, type Judge } from '../judge.js';
import { GATE_MODE_POLICY, DEFAULT_GATE_MODE } from '../types.js';
import type { EvalInput, JudgeOutput, JudgeTrust } from '../types.js';

const brief: Brief = {
  angle: 'x',
  audience: 'y',
  riskClass: 1,
  targetLength: 170,
  mustCover: [],
  mustAvoid: [],
};

function fullCoverage(count: number): ClaimCoverage {
  return {
    uncitedRatio: 0,
    sentences: Array.from({ length: count }, (_, index) => ({
      index,
      claimIds: ['00000000-0000-0000-0000-000000000001'],
      needsCitation: true,
      hasCitation: true,
      contradiction: false,
    })),
  };
}

/** A judge that always agrees with the post being good. */
const perfectJudge: Judge = {
  id: 'perfect',
  async evaluate(): Promise<JudgeOutput> {
    return {
      scores: {
        factualGrounding: 1,
        voiceConformance: 1,
        structuralCompliance: 1,
        bannedPatternCleanliness: 1,
        specificity: 1,
        readerValue: 1,
        formattingCorrectness: 1,
      },
      issues: [],
    };
  },
};

/** A judge that always fails the post on the judge-only dimensions. */
const worstJudge: Judge = {
  id: 'worst',
  async evaluate(): Promise<JudgeOutput> {
    return {
      scores: {
        factualGrounding: 0,
        voiceConformance: 0,
        structuralCompliance: 0,
        bannedPatternCleanliness: 0,
        specificity: 0,
        readerValue: 0,
        formattingCorrectness: 0,
      },
      issues: [{ dimension: 'voiceConformance', severity: 'warning', message: 'judge dislikes voice' }],
    };
  },
};

const allTrusted: JudgeTrust = {
  trusted: {
    factualGrounding: true,
    voiceConformance: true,
    structuralCompliance: true,
    bannedPatternCleanliness: true,
    specificity: true,
    readerValue: true,
    formattingCorrectness: true,
  },
  kappa: {
    factualGrounding: 0.9,
    voiceConformance: 0.9,
    structuralCompliance: 0.9,
    bannedPatternCleanliness: 0.9,
    specificity: 0.9,
    readerValue: 0.9,
    formattingCorrectness: 0.9,
  },
};

function input(overrides?: Partial<EvalInput>): EvalInput {
  return {
    post: {
      bodyMd: 'The farm adds 45 gigawatts to the grid by 2030. Two local builders signed the construction contract. Financing closes next quarter. The panel field uses bifacial modules.',
      claimMap: {
        0: ['00000000-0000-0000-0000-000000000001'],
        1: ['00000000-0000-0000-0000-000000000001'],
        2: ['00000000-0000-0000-0000-000000000001'],
        3: ['00000000-0000-0000-0000-000000000001'],
      },
      allowedUrls: [],
    },
    brief,
    voice: EN_VOICE,
    coverage: fullCoverage(4),
    sources: [],
    ...overrides,
  };
}

describe('evaluate (plan §15.2)', () => {
  it('a clean post passes with the deterministic scorers alone', async () => {
    const r = await evaluate(input());
    expect(r.composite).toBeGreaterThanOrEqual(0.72);
    expect(r.passes).toBe(true);
  });

  it('composite ≥ 0.72 threshold with the full rubric', async () => {
    const r = await evaluate(input(), { judge: perfectJudge, trust: allTrusted });
    expect(r.composite).toBeGreaterThanOrEqual(0.72);
    expect(r.verdict.verdict).toBe('pass');
  });

  it('a hard deterministic failure blocks the post', async () => {
    const bad: EvalInput = input({
      post: {
        bodyMd: 'The farm adds 45 gigawatts by 2030.',
        claimMap: {},
        allowedUrls: [],
      },
      coverage: {
        uncitedRatio: 1,
        sentences: [
          { index: 0, claimIds: [], needsCitation: true, hasCitation: false, contradiction: false },
        ],
      },
    });
    const r = await evaluate(bad);
    expect(r.verdict.verdict).toBe('block');
    expect(r.passes).toBe(false);
  });

  it('judge output contributes but a judge score alone never blocks (aggregate gate)', async () => {
    // Perfect deterministic post, worst judge: the judge-inclusive composite is
    // pulled down but the deterministic floor keeps the aggregate gate green.
    const r = await evaluate(input(), { judge: worstJudge, trust: allTrusted });
    const detComposite = r.deterministic.composite;
    expect(detComposite).toBeGreaterThanOrEqual(0.72);
    // The judge-inclusive composite may drop below 0.72...
    expect(r.composite).toBeLessThan(0.72);
    // ...but under the aggregate gate the post still passes.
    expect(r.verdict.verdict).toBe('pass');
    expect(r.passes).toBe(true);
  });

  it('evaluateGate never blocks on judge-only evidence under aggregate mode', () => {
    const policy: GatePolicy = { gateMode: DEFAULT_GATE_POLICY.gateMode };
    // A deterministic hard failure blocks regardless of composite.
    const verdict = evaluateGate(0.8, ['judge flagged the voice'], policy);
    expect(verdict.verdict).toBe('block');
    // Judge-inclusive composite alone cannot block: aggregate gate uses the
    // deterministic floor, which passes.
    const judgeOnlyLow = evaluateGate(0.9, [], policy, 0.1);
    expect(judgeOnlyLow.verdict).toBe('pass');
    const noFail = evaluateGate(0.8, [], policy);
    expect(noFail.verdict).toBe('pass');
  });

  it('per_item mode is a policy option but still honors the composite floor and never blocks on judge evidence', () => {
    const policy: GatePolicy = { gateMode: 'per_item' };
    const pass = evaluateGate(0.9, [], policy, 0.9);
    expect(pass.verdict).toBe('pass');
    const revise = evaluateGate(0.9, [], policy, 0.6);
    expect(revise.verdict).toBe('revise');
    // Even per_item cannot block without a deterministic hard failure.
    const block = evaluateGate(0.9, ['hard'], policy, 0.1);
    expect(block.verdict).toBe('block');
  });

  it('produces a Critique-shaped result for the pipeline', async () => {
    const r = await evaluate(input(), { judge: perfectJudge, trust: allTrusted });
    const { toCritique } = await import('../evaluate.js');
    const c = toCritique(r);
    expect(c.composite).toBe(r.composite);
    expect(c.scores).toHaveProperty('factualGrounding');
    expect(c.scores).toHaveProperty('voiceConformance');
    expect(c.scores).toHaveProperty('structuralCompliance');
    expect(c.scores).toHaveProperty('bannedPatternCleanliness');
    expect(c.scores).toHaveProperty('specificity');
    expect(c.scores).toHaveProperty('readerValue');
    expect(c.scores).toHaveProperty('formattingCorrectness');
  });
});

describe('gateMode policy constant (plan A6)', () => {
  it('eval.gate_mode defaults to aggregate', () => {
    expect(GATE_MODE_POLICY).toBe('eval.gate_mode');
    expect(DEFAULT_GATE_MODE).toBe('aggregate');
  });
});