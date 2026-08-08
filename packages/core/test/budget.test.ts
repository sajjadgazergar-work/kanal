import { describe, it, expect, vi } from 'vitest';
import { BudgetExceeded, StepBudgetExceeded, estimateTokens, estimateCost, guardedCall, charge } from '../src/budget.js';
import type { ModelRequest, ModelResponse } from '../src/stage.js';

const price = { inputUsdPerMtok: 3, outputUsdPerMtok: 15, cachedInputUsdPerMtok: 0.3 };

const req: ModelRequest = {
  stage: 'test.stage',
  messages: [
    { role: 'system', content: 'x'.repeat(4000) }, // cached
    { role: 'user', content: 'y'.repeat(4000) }, // billed
  ],
  maxTokens: 1000,
};

describe('budget guard (§7.8)', () => {
  it('estimateTokens uses the 4-char heuristic', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('estimateCost marks system messages as cached and counts output', () => {
    const est = estimateCost(req, price);
    expect(est.cachedInTokens).toBe(1000);
    expect(est.inTokens).toBe(1000);
    expect(est.outTokens).toBe(1000);
    // (1000*3 + 1000*0.3 + 1000*15)/1e6
    expect(est.maxUsd).toBeCloseTo(0.0183, 6);
    expect(est.pricingConfidence).toBe('low');
  });

  it('guardedCall passes when under cap and charges after the call', async () => {
    const call = vi.fn(async (): Promise<ModelResponse> => ({
      text: 'ok',
      usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 1000 },
      modelRef: 'tier:M',
    }));
    const res = await guardedCall(
      { runSpentUsd: 0, runCapUsd: 1, stepMaxUsd: 1, priceTable: { get: () => price } },
      req,
      call,
    );
    expect(res.text).toBe('ok');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('throws BudgetExceeded when projected crosses the run cap', async () => {
    const call = vi.fn();
    await expect(
      guardedCall(
        { runSpentUsd: 0.99, runCapUsd: 1, stepMaxUsd: 1, priceTable: { get: () => price } },
        req,
        call,
      ),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(call).not.toHaveBeenCalled();
  });

  it('throws StepBudgetExceeded when the single call exceeds step max', async () => {
    const call = vi.fn();
    await expect(
      guardedCall(
        { runSpentUsd: 0, runCapUsd: 10, stepMaxUsd: 0.01, priceTable: { get: () => price } },
        req,
        call,
      ),
    ).rejects.toBeInstanceOf(StepBudgetExceeded);
    expect(call).not.toHaveBeenCalled();
  });

  it('passes through when the model price is unknown', async () => {
    const call = vi.fn(async (): Promise<ModelResponse> => ({
      text: 'ok',
      usage: { inputTokens: 1, outputTokens: 1 },
      modelRef: 'unknown',
    }));
    const res = await guardedCall(
      { runSpentUsd: 0, runCapUsd: 1, stepMaxUsd: 1, priceTable: { get: () => null } },
      req,
      call,
    );
    expect(res.text).toBe('ok');
  });

  it('charge computes a high-confidence cost', () => {
    const c = charge(
      { text: '', usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 900 }, modelRef: 'x' },
      price,
    );
    // (900*0.3 + 100*3 + 200*15)/1e6
    expect(c.costUsd).toBeCloseTo((270 + 300 + 3000) / 1e6, 6);
    expect(c.pricingConfidence).toBe('high');
  });
});
