import type { ModelRequest, ModelResponse } from './stage.js';

/**
 * The budget guard (plan §7.8). Wraps every model call at the provider client,
 * not at the agent. Pre-flight estimation uses the model's own tokenizer where
 * available and a 4-chars-per-token heuristic where not, with the heuristic
 * path marked `pricing_confidence: 'low'`.
 */
export class BudgetExceeded extends Error {
  readonly stage: string;
  readonly projected: number;
  readonly cap: number;
  constructor(opts: { stage: string; projected: number; cap: number }) {
    super(`budget exceeded: projected ${opts.projected} > cap ${opts.cap} at ${opts.stage}`);
    this.stage = opts.stage;
    this.projected = opts.projected;
    this.cap = opts.cap;
  }
}

export class StepBudgetExceeded extends Error {
  readonly projected: number;
  readonly maxUsd: number;
  constructor(projected: number, maxUsd: number) {
    super(`step budget exceeded: projected ${projected} > max ${maxUsd}`);
    this.projected = projected;
    this.maxUsd = maxUsd;
  }
}

export interface PriceTable {
  get(modelRef: string): { inputUsdPerMtok: number; outputUsdPerMtok: number; cachedInputUsdPerMtok?: number } | null;
}

/** 4 chars per token heuristic (plan §7.8), marked low confidence. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateCost(
  req: ModelRequest,
  price: { inputUsdPerMtok: number; outputUsdPerMtok: number; cachedInputUsdPerMtok?: number },
  estimateTokensFn: (text: string) => number = estimateTokens,
): { maxUsd: number; inTokens: number; outTokens: number; cachedInTokens: number; pricingConfidence: 'high' | 'low' } {
  let inTokens = 0;
  let cachedInTokens = 0;
  for (const m of req.messages) {
    if (m.role === 'system') {
      cachedInTokens += estimateTokensFn(m.content);
    } else {
      inTokens += estimateTokensFn(m.content);
    }
  }
  const outTokens = req.maxTokens ?? 1024;
  const maxUsd =
    (inTokens * price.inputUsdPerMtok + cachedInTokens * (price.cachedInputUsdPerMtok ?? price.inputUsdPerMtok) + outTokens * price.outputUsdPerMtok) / 1e6;
  return { maxUsd, inTokens, outTokens, cachedInTokens, pricingConfidence: 'low' };
}

export interface BudgetState {
  runSpentUsd: number;
  runCapUsd: number;
  stepMaxUsd: number;
  priceTable: PriceTable;
}

/**
 * Wraps a provider call. `BudgetExceeded` moves the run to `blocked_budget`
 * (a global interrupt, §5.2) and never partially publishes.
 */
export async function guardedCall(
  state: BudgetState,
  req: ModelRequest,
  providerCall: (req: ModelRequest) => Promise<ModelResponse>,
): Promise<ModelResponse> {
  const price = state.priceTable.get(req.modelRef ?? 'tier:M');
  if (!price) {
    // price_unknown → pricing_confidence: none (plan §11.3)
    return providerCall(req);
  }
  const est = estimateCost(req, price);
  const projected = state.runSpentUsd + est.maxUsd;
  if (projected > state.runCapUsd) {
    throw new BudgetExceeded({ stage: req.stage, projected, cap: state.runCapUsd });
  }
  if (est.maxUsd > state.stepMaxUsd) {
    throw new StepBudgetExceeded(est.maxUsd, state.stepMaxUsd);
  }
  const res = await providerCall(req);
  // Charge after the call: UPDATE run SET spent_usd = spent_usd + $1
  state.runSpentUsd += (res.usage.inputTokens * price.inputUsdPerMtok + res.usage.outputTokens * price.outputUsdPerMtok) / 1e6;
  return res;
}

/** Cost ledger entry shape (plan §7.8). */
export function charge(
  res: ModelResponse,
  price: { inputUsdPerMtok: number; outputUsdPerMtok: number; cachedInputUsdPerMtok?: number },
): { costUsd: number; pricingConfidence: 'high' | 'low' } {
  const inTokens = res.usage.inputTokens;
  const outTokens = res.usage.outputTokens;
  const cachedTokens = res.usage.cachedTokens ?? 0;
  const costUsd =
    (cachedTokens * (price.cachedInputUsdPerMtok ?? price.inputUsdPerMtok) +
      (inTokens - cachedTokens) * price.inputUsdPerMtok +
      outTokens * price.outputUsdPerMtok) /
    1e6;
  return { costUsd, pricingConfidence: 'high' };
}
