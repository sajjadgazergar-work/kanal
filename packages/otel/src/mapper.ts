/**
 * LiveEvent mapper (§13.3).
 *
 * Spans are converted to the narrow, versioned `LiveEvent` contract type
 * before hitting the wire. The UI never parses raw OTLP — this module is the
 * only translator between span objects and what the canvas renders.
 */

import type { GateVerdict, LiveEvent, RunState, Zone } from '@kanal/contracts';

/** The minimal span shape the mapper needs to do its job. */
export interface SpanForMapper {
  name: string;
  kind: number;
  attributes: Record<string, unknown>;
  /** Unix epoch milliseconds. */
  startMs: number;
  endMs?: number;
  status?: { code: string; message?: string };
}

export interface MapOptions {
  /** ISO 8601 UTC timestamp to stamp `at` with (defaults to `new Date().toISOString()`). */
  at?: string;
}

function iso(at: string | undefined, ms: number | undefined): string {
  return at ?? (ms !== undefined ? new Date(ms).toISOString() : new Date().toISOString());
}

function num(attrs: Record<string, unknown>, key: string): number | undefined {
  const v = attrs[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(attrs: Record<string, unknown>, key: string): string | undefined {
  const v = attrs[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Convert a sanitised span to a `LiveEvent`, or `null` when the span does not
 * map to a live-bus event (the UI renders nothing for it). `kanal.run` spans
 * map to `run.state` events whose state is read from `kanal.run.state` if the
 * attribute is present, otherwise inferred from the span status.
 */
export function mapSpanToLiveEvent(span: SpanForMapper, options: MapOptions = {}): LiveEvent | null {
  const a = span.attributes;

  switch (span.name) {
    case 'kanal.run': {
      const runId = str(a, 'kanal.run.id');
      if (runId === undefined) return null;
      const stateAttr = str(a, 'kanal.run.state');
      const state: RunState = isRunState(stateAttr)
        ? stateAttr
        : span.status?.code === 'ERROR'
          ? 'failed'
          : span.endMs === undefined
            ? 'intake'
            : 'learned';
      return { v: 1, t: 'run.state', runId, state, at: iso(options.at, span.endMs) };
    }

    case 'kanal.approval': {
      const runId = str(a, 'kanal.run.id');
      if (runId === undefined) return null;
      const gate = str(a, 'kanal.approval.gate');
      const state = str(a, 'kanal.approval.state');
      if (gate === undefined || state === undefined) return null;
      return { v: 1, t: 'approval', runId, gate, state, at: iso(options.at, span.endMs) };
    }

    case 'kanal.publish': {
      const runId = str(a, 'kanal.run.id');
      if (runId === undefined) return null;
      const stage = str(a, 'kanal.stage.id') ?? 'publish';
      const outcome = str(a, 'kanal.publish.outcome') ?? '';
      const ok = outcome === 'ok' || (span.status?.code ?? '') === 'OK';
      return { v: 1, t: 'tool.call', runId, stage, capability: `publish.${str(a, 'kanal.platform') ?? 'unknown'}`, ok, at: iso(options.at, span.endMs) };
    }

    default:
      break;
  }

  if (span.name.startsWith('kanal.stage.')) {
    const stageId = span.name.slice('kanal.stage.'.length);
    const runId = str(a, 'kanal.run.id');
    if (runId === undefined) return null;

    if (span.endMs === undefined) {
      const zone = isZone(str(a, 'kanal.zone')) ? (a['kanal.zone'] as Zone) : 'deterministic';
      const agentRef = str(a, 'kanal.agent.ref');
      return {
        v: 1,
        t: 'stage.start',
        runId,
        stage: stageId,
        ...(agentRef !== undefined ? { agentRef } : {}),
        zone,
        at: iso(options.at, span.startMs),
      };
    }

    const ms = Math.max(0, span.endMs - span.startMs);
    const ok = span.status?.code === 'ERROR' ? false : true;
    const verdict = isGateVerdict(str(a, 'kanal.gate.verdict')) ? (a['kanal.gate.verdict'] as GateVerdict) : undefined;
    const costUsd = num(a, 'kanal.cost.usd');
    return {
      v: 1,
      t: 'stage.end',
      runId,
      stage: stageId,
      ok,
      ms,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(verdict !== undefined ? { verdict } : {}),
      at: iso(options.at, span.endMs),
    };
  }

  if (span.name.startsWith('gen_ai.')) {
    const runId = str(a, 'kanal.run.id');
    if (runId === undefined) return null;
    const stage = str(a, 'kanal.stage.id') ?? 'unknown';
    const model = str(a, 'gen_ai.response.model') ?? str(a, 'gen_ai.request.model') ?? '';
    const inTok = num(a, 'gen_ai.usage.input_tokens');
    const outTok = num(a, 'gen_ai.usage.output_tokens');
    const ms = span.endMs !== undefined ? Math.max(0, span.endMs - span.startMs) : 0;
    const costUsd = num(a, 'kanal.cost.usd') ?? 0;
    return {
      v: 1,
      t: 'model.call',
      runId,
      stage,
      model,
      inTok: Math.round(inTok ?? 0),
      outTok: Math.round(outTok ?? 0),
      ms,
      costUsd,
      at: iso(options.at, span.endMs),
    };
  }

  if (span.name.startsWith('kanal.tool.')) {
    const runId = str(a, 'kanal.run.id');
    if (runId === undefined) return null;
    const stage = str(a, 'kanal.stage.id') ?? 'unknown';
    const capability = span.name.slice('kanal.tool.'.length);
    const ok = span.status?.code === 'ERROR' ? false : true;
    return { v: 1, t: 'tool.call', runId, stage, capability, ok, at: iso(options.at, span.endMs) };
  }

  return null;
}

function isRunState(v: string | undefined): v is RunState {
  if (v === undefined) return false;
  return (
    v === 'intake' || v === 'briefed' || v === 'sourcing' || v === 'researched' || v === 'authoring' ||
    v === 'drafting' || v === 'critiquing' || v === 'revising' || v === 'formatting' || v === 'media_pending' ||
    v === 'policy_check' || v === 'review_pending' || v === 'approved' || v === 'scheduled' || v === 'publishing' ||
    v === 'published' || v === 'publish_uncertain' || v === 'measuring' || v === 'learned' || v === 'escalated' ||
    v === 'blocked_policy' || v === 'blocked_budget' || v === 'blocked_provider' || v === 'halted' ||
    v === 'cancelled' || v === 'failed'
  );
}

function isZone(v: string | undefined): v is Zone {
  return v === 'quarantine' || v === 'trusted' || v === 'deterministic';
}

function isGateVerdict(v: string | undefined): v is GateVerdict {
  return v === 'pass' || v === 'revise' || v === 'block' || v === 'human';
}
