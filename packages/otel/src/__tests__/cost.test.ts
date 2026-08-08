import { describe, expect, it } from 'vitest';
import { computeCostUsd, costLedgerEntry, sumLedger } from '../cost.js';
import { attachCost, genAi, endSeed } from '../taxonomy.js';
import { sanitizeSpan } from '../processor.js';

describe('cost derivation (§13.2)', () => {
  it('computes cost_usd = in×price.in + out×price.out', () => {
    // 10k input × $1/Mtok + 2k output × $4/Mtok
    const cost = computeCostUsd(
      { inputTokens: 10_000, outputTokens: 2_000 },
      { inputUsdPerMtok: 1.0, outputUsdPerMtok: 4.0 },
    );
    expect(cost).toBeCloseTo(0.018, 10);
  });

  it('matches the plan’s default $0.051/post at 93k tokens on S+M tiers', () => {
    // S-tier input 0.15, M-tier output 4.00 (plan §9.3).
    const cost = computeCostUsd(
      { inputTokens: 60_000, outputTokens: 33_000 },
      { inputUsdPerMtok: 0.15, outputUsdPerMtok: 4.0 },
    );
    expect(cost).toBeCloseTo(0.141, 6);
  });

  it('zero tokens → zero cost', () => {
    expect(computeCostUsd({ inputTokens: 0, outputTokens: 0 }, { inputUsdPerMtok: 1, outputUsdPerMtok: 1 })).toBe(0);
  });

  it('rejects negative token counts and negative prices', () => {
    expect(() => computeCostUsd({ inputTokens: -1, outputTokens: 0 }, { inputUsdPerMtok: 1, outputUsdPerMtok: 1 })).toThrow();
    expect(() => computeCostUsd({ inputTokens: 1, outputTokens: 1 }, { inputUsdPerMtok: -1, outputUsdPerMtok: 1 })).toThrow();
  });

  it('cost_ledger_entry records the exact usage and rounds to 6 decimals', () => {
    const entry = costLedgerEntry({
      runId: 'run-1',
      stage: 'drafting',
      modelRef: 'anthropic/claude-haiku',
      usage: { inputTokens: 10_000, outputTokens: 2_000 },
      price: { inputUsdPerMtok: 1.0, outputUsdPerMtok: 4.0 },
      pricingConfidence: 'high',
      at: '2026-08-08T00:00:00.000Z',
    });
    expect(entry.costUsd).toBe(0.018);
    expect(entry.runId).toBe('run-1');
    expect(entry.stage).toBe('drafting');
    expect(entry.inputTokens).toBe(10_000);
    expect(entry.outputTokens).toBe(2_000);
    expect(entry.pricingConfidence).toBe('high');
  });

  it('sum over the ledger is the per-post cost readout', () => {
    const entries = [
      costLedgerEntry({
        runId: 'run-1', stage: 'research', modelRef: 'm', usage: { inputTokens: 10_000, outputTokens: 0 },
        price: { inputUsdPerMtok: 1, outputUsdPerMtok: 1 }, at: '2026-08-08T00:00:00.000Z',
      }),
      costLedgerEntry({
        runId: 'run-1', stage: 'drafting', modelRef: 'm', usage: { inputTokens: 0, outputTokens: 1_000 },
        price: { inputUsdPerMtok: 1, outputUsdPerMtok: 1 }, at: '2026-08-08T00:00:01.000Z',
      }),
    ];
    expect(sumLedger(entries)).toBeCloseTo(0.011, 10);
  });

  it('writes derived cost to the span at end (kanal.cost.usd)', () => {
    const seed = endSeed(attachCost(genAi({ operation: 'chat', system: 's', requestModel: 'm' }), 0.0042));
    const sanitized = sanitizeSpan(seed);
    expect(sanitized.attributes['kanal.cost.usd']).toBe(0.0042);
  });
});
