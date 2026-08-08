/**
 * Span taxonomy (§13.2).
 *
 * Helper functions to create spans, with the required attributes per the
 * §13.2 table. KANAL-specific attributes live under `kanal.*`; GenAI
 * semantic-convention attributes are passed through as-is.
 *
 * This module is transport-agnostic: it builds a `SpanSeed` (name, kind,
 * attributes, timestamps) that any backend — the in-process collector or the
 * OpenTelemetry SDK — can materialise. The helpers are synchronous and take
 * optional explicit timestamps so tests need no fake timers and the caller can
 * inject `Date.now()` at the natural points in the agent loop.
 */

import type { SpanKind } from '@opentelemetry/api';
import type { GateVerdict, Lane, Zone } from '@kanal/contracts';

export interface SpanSeed {
  name: string;
  kind: SpanKind;
  attributes: Record<string, string | number | boolean | Array<string | number | boolean>>;
  /** Unix epoch milliseconds. */
  startMs: number;
  /** Unix epoch milliseconds. Present only on an ended span. */
  endMs?: number;
  /** @link https://opentelemetry.io/docs/specs/otel/trace/api/#status */
  status?: { code: 'OK' | 'ERROR' | 'UNSET'; message?: string };
}

export function nowMs(): number {
  return Date.now();
}

/** Make required attributes for `kanal.run` (§13.2). */
export function runAttributes(input: {
  runId: string;
  channelId: string;
  lane: Lane;
  manifestSetHash: string;
  promptPackVersion: string;
}): Record<string, string> {
  return {
    'kanal.run.id': input.runId,
    'kanal.channel.id': input.channelId,
    'kanal.lane': input.lane,
    'kanal.manifest_set_hash': input.manifestSetHash,
    'kanal.prompt_pack.version': input.promptPackVersion,
  };
}

/** Make required attributes for `kanal.stage.{stage_id}` (§13.2). */
export function stageAttributes(input: {
  stageId: string;
  attempt: number;
  zone: Zone;
  agentRef?: string;
  verdict?: GateVerdict;
}): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    'kanal.stage.id': input.stageId,
    'kanal.stage.attempt': input.attempt,
    'kanal.zone': input.zone,
  };
  if (input.agentRef !== undefined) attrs['kanal.agent.ref'] = input.agentRef;
  if (input.verdict !== undefined) attrs['kanal.gate.verdict'] = input.verdict;
  return attrs;
}

/** Make required attributes for `gen_ai.{operation}` (§13.2). */
export function genAiAttributes(input: {
  operation: 'chat' | 'embeddings';
  system: string;
  requestModel: string;
  requestTemperature?: number;
  requestMaxTokens?: number;
  responseModel?: string;
  finishReasons?: string[];
  usage?: { inputTokens: number; outputTokens: number };
}): Record<string, string | number | boolean | string[]> {
  const attrs: Record<string, string | number | boolean | string[]> = {
    'gen_ai.operation.name': input.operation,
    'gen_ai.system': input.system,
    'gen_ai.request.model': input.requestModel,
  };
  if (input.requestTemperature !== undefined) attrs['gen_ai.request.temperature'] = input.requestTemperature;
  if (input.requestMaxTokens !== undefined) attrs['gen_ai.request.max_tokens'] = input.requestMaxTokens;
  if (input.responseModel !== undefined) attrs['gen_ai.response.model'] = input.responseModel;
  if (input.finishReasons !== undefined && input.finishReasons.length > 0) {
    attrs['gen_ai.response.finish_reasons'] = input.finishReasons;
  }
  if (input.usage !== undefined) {
    attrs['gen_ai.usage.input_tokens'] = input.usage.inputTokens;
    attrs['gen_ai.usage.output_tokens'] = input.usage.outputTokens;
  }
  return attrs;
}

/** Make required attributes for `kanal.tool.{capability_id}` (§13.2). */
export function toolAttributes(input: {
  capabilityId: string;
  risk: number;
  result?: string;
}): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    'kanal.capability.id': input.capabilityId,
    'kanal.capability.risk': input.risk,
  };
  if (input.result !== undefined) attrs['kanal.tool.result'] = input.result;
  return attrs;
}

/** Make required attributes for `kanal.publish` (§13.2). */
export function publishAttributes(input: {
  platform: string;
  idempotencyKey: string;
  outcome: string;
  httpStatusCode?: number;
}): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    'kanal.platform': input.platform,
    'kanal.idempotency_key': input.idempotencyKey,
    'kanal.publish.outcome': input.outcome,
  };
  if (input.httpStatusCode !== undefined) attrs['http.response.status_code'] = input.httpStatusCode;
  return attrs;
}

/** Make required attributes for `kanal.approval` (§13.2). */
export function approvalAttributes(input: {
  gate: string;
  state: string;
  actor?: string;
}): Record<string, string> {
  const attrs: Record<string, string> = {
    'kanal.approval.gate': input.gate,
    'kanal.approval.state': input.state,
  };
  if (input.actor !== undefined) attrs['kanal.actor'] = input.actor;
  return attrs;
}

/** Create a `kanal.run` span seed. */
export function kanalRun(input: {
  runId: string;
  channelId: string;
  lane: Lane;
  manifestSetHash: string;
  promptPackVersion: string;
  startMs?: number;
}): SpanSeed {
  return {
    name: 'kanal.run',
    kind: 2, // SpanKind.SERVER
    attributes: runAttributes(input),
    startMs: input.startMs ?? nowMs(),
  };
}

/** Create a `kanal.stage.{stage_id}` span seed. */
export function kanalStage(input: {
  stageId: string;
  attempt: number;
  zone: Zone;
  agentRef?: string;
  verdict?: GateVerdict;
  startMs?: number;
}): SpanSeed {
  return {
    name: `kanal.stage.${input.stageId}`,
    kind: 1, // SpanKind.INTERNAL
    attributes: stageAttributes(input),
    startMs: input.startMs ?? nowMs(),
  };
}

/** Create a `gen_ai.{operation}` span seed (chat or embeddings). */
export function genAi(input: {
  operation: 'chat' | 'embeddings';
  system: string;
  requestModel: string;
  requestTemperature?: number;
  requestMaxTokens?: number;
  responseModel?: string;
  finishReasons?: string[];
  usage?: { inputTokens: number; outputTokens: number };
  startMs?: number;
}): SpanSeed {
  return {
    name: `gen_ai.${input.operation}`,
    kind: 3, // SpanKind.CLIENT
    attributes: genAiAttributes(input),
    startMs: input.startMs ?? nowMs(),
  };
}

/** Create a `kanal.tool.{capability_id}` span seed. */
export function kanalTool(input: {
  capabilityId: string;
  risk: number;
  result?: string;
  startMs?: number;
}): SpanSeed {
  return {
    name: `kanal.tool.${input.capabilityId}`,
    kind: 1, // SpanKind.INTERNAL
    attributes: toolAttributes(input),
    startMs: input.startMs ?? nowMs(),
  };
}

/** Create a `kanal.publish` span seed. */
export function kanalPublish(input: {
  platform: string;
  idempotencyKey: string;
  outcome: string;
  httpStatusCode?: number;
  startMs?: number;
}): SpanSeed {
  return {
    name: 'kanal.publish',
    kind: 3, // SpanKind.CLIENT
    attributes: publishAttributes(input),
    startMs: input.startMs ?? nowMs(),
  };
}

/** Create a `kanal.approval` span seed. */
export function kanalApproval(input: {
  gate: string;
  state: string;
  actor?: string;
  startMs?: number;
}): SpanSeed {
  return {
    name: 'kanal.approval',
    kind: 1, // SpanKind.INTERNAL
    attributes: approvalAttributes(input),
    startMs: input.startMs ?? nowMs(),
  };
}

/** Mark a seed as ended with an OK status and attach derived cost (§13.2). */
export function endSeed(seed: SpanSeed, endMs?: number): SpanSeed {
  return {
    ...seed,
    endMs: endMs ?? nowMs(),
    status: seed.status ?? { code: 'OK' },
  };
}

/** Mark a seed as ended with an ERROR status. */
export function endSeedError(seed: SpanSeed, message?: string, endMs?: number): SpanSeed {
  return {
    ...seed,
    endMs: endMs ?? nowMs(),
    status: { code: 'ERROR', message },
  };
}

/** Attach a derived cost to a seed (§13.2: written once, at span end). */
export function attachCost(
  seed: SpanSeed,
  costUsd: number,
  pricingConfidence?: 'high' | 'low' | 'none',
): SpanSeed {
  return {
    ...seed,
    attributes: {
      ...seed.attributes,
      'kanal.cost.usd': costUsd,
      'kanal.cost.currency': 'usd',
      ...(pricingConfidence !== undefined ? { 'kanal.cost.confidence': pricingConfidence } : {}),
    },
  };
}
