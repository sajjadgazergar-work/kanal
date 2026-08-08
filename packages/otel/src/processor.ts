/**
 * Span processors (§13.2): the attribute allow-list (deny by default) and the
 * content redaction layer. Span content is excluded by default, which is most
 * of the retention size saving (§13.6).
 *
 * The processors act on a `SpanSeed` (a plain, transport-agnostic object) so
 * they run inside the collector before any fork — the span store, the live bus
 * ring buffers, and any external OTLP sink all observe the same sanitised span.
 */

import { filterAllowlist, KANAL_COST_CONFIDENCE, KANAL_COST_CURRENCY, KANAL_COST_USD } from './attributes.js';
import { contentAttributes, parseTraceContentMode, type TraceContentMode } from './content.js';
import type { SpanSeed } from './taxonomy.js';

/** An OTel-span-like object. Sanitisation only touches attributes. */
export interface SanitizableSpan {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
}

export interface SanitizeOptions {
  traceContentMode?: TraceContentMode | string;
  /** Drops content attributes entirely (`off` hard-mode). Default: false. */
  contentOff?: boolean;
}

export interface SanitizedSpan {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
  /** True when any attribute was dropped because it was not on the allow-list. */
  readonly droppedCount: number;
  /** True when `KANAL_TRACE_CONTENT=full` stored verbatim message content. */
  readonly storedContent: boolean;
}

/**
 * Deny by default: returns a span whose attributes are exactly the intersection
 * with the §13.2 allow-list. Content is never allowed through — it is dropped
 * even when a caller attached it, so an accidental `kanal.content.full` can
 * never leak to an OTLP sink the user points at a third party.
 */
export function sanitizeSpan(span: SanitizableSpan, options: SanitizeOptions = {}): SanitizedSpan {
  const mode = parseTraceContentMode(options.traceContentMode);
  const hardOff = options.contentOff === true || mode === 'off';

  const rawAttrs: Record<string, unknown> = { ...span.attributes };
  const dropContent = hardOff
    ? () => true
    : (key: string): boolean => key === 'kanal.content.full' || key === 'kanal.content.sha256' || key === 'kanal.content.tokens';

  let droppedCount = 0;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawAttrs)) {
    if (dropContent(key)) {
      droppedCount += 1;
      continue;
    }
    const allowed = filterAllowlist({ [key]: value });
    if (allowed === undefined || Object.keys(allowed).length === 0 || value === undefined) {
      droppedCount += 1;
      continue;
    }
    kept[key] = value;
  }

  return {
    name: span.name,
    attributes: kept,
    droppedCount,
    storedContent: mode === 'full' && !hardOff && Object.values(kept).some((v) => typeof v === 'string' && v.length > 0),
  };
}

/** Content redaction: given a message text + token count, produce the attributes for the configured mode. */
export function contentForMode(
  mode: TraceContentMode | string,
  text: string,
  tokenCount: number,
): Record<string, string | number> {
  return contentAttributes(parseTraceContentMode(mode), text, tokenCount);
}

export interface CostDerivationContext {
  runId: string;
  stage: string;
  modelRef: string;
}

export interface CostSpanResult {
  sanitized: SanitizedSpan;
  costUsd: number;
  pricingConfidence: 'high' | 'low' | 'none';
}

/**
 * Apply the full §13.2 pipeline to a gen_ai span seed:
 *  1. redact content attributes per `traceContentMode`,
 *  2. enforce the allow-list,
 *  3. derive cost from usage and prices, written to `kanal.cost.*` at end,
 *  4. return the cost so the caller can append one `CostLedgerEntry` (the
 *     per-post cost readout is a SUM over the ledger).
 */
export function finalizeGenAiSpan(input: {
  seed: SpanSeed;
  context: CostDerivationContext;
  price: { inputUsdPerMtok: number; outputUsdPerMtok: number };
  traceContentMode?: TraceContentMode | string;
}): CostSpanResult {
  const { seed, price } = input;
  const mode = parseTraceContentMode(input.traceContentMode);

  const rawAttrs: Record<string, unknown> = { ...seed.attributes };
  const contentRedacted = (seed as { contentRedacted?: { sha256: string; tokens: number } }).contentRedacted;
  if (contentRedacted !== undefined && contentRedacted.sha256 !== '') {
    rawAttrs['kanal.content.sha256'] = contentRedacted.sha256;
    rawAttrs['kanal.content.tokens'] = contentRedacted.tokens;
  }
  const contentFull = (seed as { contentFull?: string }).contentFull;
  if (contentFull !== undefined) {
    rawAttrs['kanal.content.full'] = contentFull;
  }

  const usageIn = asFiniteNonNeg(rawAttrs['gen_ai.usage.input_tokens']);
  const usageOut = asFiniteNonNeg(rawAttrs['gen_ai.usage.output_tokens']);
  const hasUsage = usageIn !== undefined && usageOut !== undefined;
  const costUsd = hasUsage
    ? (usageIn * price.inputUsdPerMtok + usageOut * price.outputUsdPerMtok) / 1_000_000
    : 0;
  const pricingConfidence: 'high' | 'low' | 'none' = hasUsage ? 'high' : 'none';

  if (hasUsage) {
    rawAttrs[KANAL_COST_USD] = Math.round(costUsd * 1_000_000) / 1_000_000;
    rawAttrs[KANAL_COST_CURRENCY] = 'usd';
    rawAttrs[KANAL_COST_CONFIDENCE] = pricingConfidence;
  }

  const sanitized = sanitizeSpan({ name: seed.name, attributes: rawAttrs }, { traceContentMode: mode });
  return { sanitized, costUsd, pricingConfidence };
}

function asFiniteNonNeg(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return v;
}
