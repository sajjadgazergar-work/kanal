import { describe, expect, it } from 'vitest';
import { mapSpanToLiveEvent, type SpanForMapper } from '../mapper.js';
import {
  kanalRun,
  kanalStage,
  genAi,
  kanalTool,
  kanalApproval,
  endSeed,
  endSeedError,
  attachCost,
} from '../taxonomy.js';

const AT = '2026-08-08T12:00:00.000Z';

function span(seed: ReturnType<typeof endSeed>, extra: Record<string, unknown> = {}): SpanForMapper {
  return { name: seed.name, kind: seed.kind, attributes: { ...seed.attributes, ...extra }, startMs: seed.startMs, endMs: seed.endMs, status: seed.status };
}

describe('LiveEvent mapper (§13.3)', () => {
  it('maps kanal.run to run.state with an explicit state', () => {
    const s = endSeed(kanalRun({ runId: 'run-1', channelId: 'c', lane: 'auto', manifestSetHash: 'h', promptPackVersion: '1' }), 1000);
    const ev = mapSpanToLiveEvent(span(s, { 'kanal.run.state': 'published' }), { at: AT });
    expect(ev).toEqual({ v: 1, t: 'run.state', runId: 'run-1', state: 'published', at: AT });
  });

  it('run.state inferred as failed when the run span errors', () => {
    const s = endSeedError(kanalRun({ runId: 'run-1', channelId: 'c', lane: 'auto', manifestSetHash: 'h', promptPackVersion: '1' }), 'x', 1000);
    const ev = mapSpanToLiveEvent(span(s), { at: AT });
    expect(ev).toEqual({ v: 1, t: 'run.state', runId: 'run-1', state: 'failed', at: AT });
  });

  it('maps an open stage span to stage.start with zone and agentRef', () => {
    const s = kanalStage({ stageId: 'drafting', attempt: 1, zone: 'quarantine', agentRef: 'writer', startMs: 500 });
    const ev = mapSpanToLiveEvent(span({ ...s, endMs: undefined, status: undefined } as never, { 'kanal.run.id': 'run-1' }), { at: AT });
    expect(ev).toEqual({ v: 1, t: 'stage.start', runId: 'run-1', stage: 'drafting', agentRef: 'writer', zone: 'quarantine', at: AT });
  });

  it('maps an ended stage span to stage.end with ok, ms, verdict, cost', () => {
    const s = attachCost(endSeed(kanalStage({ stageId: 'drafting', attempt: 1, zone: 'trusted', verdict: 'pass', startMs: 100 }), 400), 0.0042);
    const ev = mapSpanToLiveEvent(span({ ...s, attributes: { ...s.attributes, 'kanal.run.id': 'run-1' } }), { at: AT });
    expect(ev).toEqual({
      v: 1, t: 'stage.end', runId: 'run-1', stage: 'drafting', ok: true, ms: 300,
      costUsd: 0.0042, verdict: 'pass', at: AT,
    });
  });

  it('a failed stage.end maps ok:false', () => {
    const s = endSeedError(kanalStage({ stageId: 'authoring', attempt: 1, zone: 'trusted', startMs: 0 }), 'err', 10);
    const ev = mapSpanToLiveEvent(span({ ...s, attributes: { ...s.attributes, 'kanal.run.id': 'run-1' } }), { at: AT });
    expect(ev).toEqual({ v: 1, t: 'stage.end', runId: 'run-1', stage: 'authoring', ok: false, ms: 10, at: AT });
  });

  it('maps a gen_ai span to model.call with tokens, ms and cost', () => {
    const s = endSeed(attachCost(
      genAi({ operation: 'chat', system: 'anthropic', requestModel: 'claude-haiku', usage: { inputTokens: 100, outputTokens: 25 }, startMs: 0 }),
      0.0002,
    ), 200);
    const ev = mapSpanToLiveEvent(span({ ...s, attributes: { ...s.attributes, 'kanal.run.id': 'run-1', 'kanal.stage.id': 'drafting' } }), { at: AT });
    expect(ev).toEqual({
      v: 1, t: 'model.call', runId: 'run-1', stage: 'drafting', model: 'claude-haiku',
      inTok: 100, outTok: 25, ms: 200, costUsd: 0.0002, at: AT,
    });
  });

  it('maps a kanal.tool span to tool.call', () => {
    const s = endSeed(kanalTool({ capabilityId: 'source.read_snapshot', risk: 0, startMs: 1 }), 20);
    const ev = mapSpanToLiveEvent(span({ ...s, attributes: { ...s.attributes, 'kanal.run.id': 'run-1', 'kanal.stage.id': 'sourcing' } }), { at: AT });
    expect(ev).toEqual({ v: 1, t: 'tool.call', runId: 'run-1', stage: 'sourcing', capability: 'source.read_snapshot', ok: true, at: AT });
  });

  it('maps kanal.approval to an approval event', () => {
    const s = endSeed(kanalApproval({ gate: 'publish', state: 'pending', actor: 'human', startMs: 1 }), 5);
    const ev = mapSpanToLiveEvent(span({ ...s, attributes: { ...s.attributes, 'kanal.run.id': 'run-1' } }), { at: AT });
    expect(ev).toEqual({ v: 1, t: 'approval', runId: 'run-1', gate: 'publish', state: 'pending', at: AT });
  });

  it('returns null for unknown spans', () => {
    expect(mapSpanToLiveEvent({ name: 'something.else', kind: 1, attributes: {}, startMs: 0 }, { at: AT })).toBeNull();
  });
});
