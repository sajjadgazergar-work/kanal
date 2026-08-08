/**
 * Cost derivation (§13.2).
 *
 * `cost_usd = usage.input_tokens × price.in + usage.output_tokens × price.out`,
 * computed once at span end, written to the span (`kanal.cost.usd`) and to a
 * `CostLedgerEntry`. The per-post cost readout is a SUM over the ledger for the
 * run — a real number from real usage reports, not an estimate, except where
 * `pricingConfidence` says otherwise.
 *
 * Prices are `$ per million tokens` (the §9.3 tier bands / `model_price`
 * units: `input_usd_per_mtok`, `output_usd_per_mtok`).
 */

export type CostConfidence = 'high' | 'low' | 'none';

export interface ModelPrice {
  /** $ per 1,000,000 input tokens. */
  inputUsdPerMtok: number;
  /** $ per 1,000,000 output tokens. */
  outputUsdPerMtok: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CostLedgerEntry {
  runId: string;
  stage: string;
  modelRef: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  pricingConfidence: CostConfidence;
  /** ISO 8601 UTC. */
  at: string;
}

export function computeCostUsd(usage: Usage, price: ModelPrice): number {
  if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) {
    throw new RangeError('usage token counts must be finite numbers');
  }
  if (usage.inputTokens < 0 || usage.outputTokens < 0) {
    throw new RangeError('usage token counts must be non-negative');
  }
  if (!Number.isFinite(price.inputUsdPerMtok) || !Number.isFinite(price.outputUsdPerMtok)) {
    throw new RangeError('price components must be finite numbers');
  }
  if (price.inputUsdPerMtok < 0 || price.outputUsdPerMtok < 0) {
    throw new RangeError('price components must be non-negative');
  }
  return (usage.inputTokens * price.inputUsdPerMtok + usage.outputTokens * price.outputUsdPerMtok) / 1_000_000;
}

/** Rounds to 6 decimals — the `numeric(10,6)` / `numeric(12,6)` column scale. */
export function roundUsd(costUsd: number): number {
  return Math.round(costUsd * 1_000_000) / 1_000_000;
}

export function costLedgerEntry(input: {
  runId: string;
  stage: string;
  modelRef: string;
  usage: Usage;
  price: ModelPrice;
  pricingConfidence?: CostConfidence;
  at?: string;
}): CostLedgerEntry {
  const costUsd = roundUsd(computeCostUsd(input.usage, input.price));
  return {
    runId: input.runId,
    stage: input.stage,
    modelRef: input.modelRef,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    costUsd,
    pricingConfidence: input.pricingConfidence ?? 'high',
    at: input.at ?? new Date().toISOString(),
  };
}

/** SUM over a ledger (plan §13.2). */
export function sumLedger(entries: readonly CostLedgerEntry[]): number {
  return roundUsd(entries.reduce((acc, e) => acc + e.costUsd, 0));
}
