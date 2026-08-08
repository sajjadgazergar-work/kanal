/**
 * Attribute allow-list — deny by default (§13.2).
 *
 * A span processor drops any attribute not on this explicit list. Prompt and
 * completion content is NEVER allowed through this list; it is handled
 * separately by the content redaction layer (`redact.ts`).
 *
 * KANAL-specific attributes live under `kanal.*`; GenAI semantic-convention
 * attributes (§13.2 table) are used as-is.
 */

export const GEN_AI_OPERATION_CHAT = 'chat';
export const GEN_AI_OPERATION_EMBEDDINGS = 'embeddings';
export type GenAiOperation = typeof GEN_AI_OPERATION_CHAT | typeof GEN_AI_OPERATION_EMBEDDINGS;

/** Attributes required by the §13.2 span taxonomy, plus the span's own kind. */
export const SPAN_ALLOWLIST: ReadonlySet<string> = new Set([
  // kanal.run
  'kanal.run.id',
  'kanal.channel.id',
  'kanal.lane',
  'kanal.manifest_set_hash',
  'kanal.prompt_pack.version',
  // kanal.stage.{stage_id}
  'kanal.stage.id',
  'kanal.stage.attempt',
  'kanal.zone',
  'kanal.agent.ref',
  'kanal.gate.verdict',
  // gen_ai.{operation}
  'gen_ai.operation.name',
  'gen_ai.system',
  'gen_ai.request.model',
  'gen_ai.request.temperature',
  'gen_ai.request.max_tokens',
  'gen_ai.response.model',
  'gen_ai.response.finish_reasons',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  // kanal.tool.{capability_id}
  'kanal.capability.id',
  'kanal.capability.risk',
  'kanal.tool.result',
  // kanal.publish
  'kanal.platform',
  'kanal.idempotency_key',
  'kanal.publish.outcome',
  'http.response.status_code',
  // kanal.approval
  'kanal.approval.gate',
  'kanal.approval.state',
  'kanal.actor',
  // derived cost (written at span end by the cost processor)
  'kanal.cost.usd',
  'kanal.cost.currency',
  'kanal.cost.confidence',
]);

/**
 * Drops any attribute key not on the allow-list. Namespaced attributes like
 * `kanal.cost.usd` are allowed verbatim, so this also removes the common
 * glob-shaped families a caller might set by mistake.
 */
export function filterAllowlist(attrs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (attrs == null) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (SPAN_ALLOWLIST.has(key)) out[key] = value;
  }
  return out;
}

/** Attribute keys on the allow-list that carry GenAI usage counters. */
export const USAGE_INPUT_ATTR = 'gen_ai.usage.input_tokens';
export const USAGE_OUTPUT_ATTR = 'gen_ai.usage.output_tokens';

/** Every span kind we emit (§13.2), used by the mapper and the taxonomies. */
export const SPAN_KIND_ATTRIBUTE = 'kanal.span.kind';

export const KANAL_COST_USD = 'kanal.cost.usd';
export const KANAL_COST_CURRENCY = 'kanal.cost.currency';
export const KANAL_COST_CONFIDENCE = 'kanal.cost.confidence';
