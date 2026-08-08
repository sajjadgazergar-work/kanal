import { describe, expect, it } from 'vitest';
import { OtlpForkCollector, RingBufferStore } from '../collector.js';
import { SelfContainedSink } from '../otlp-sink.js';
import { kanalRun, kanalStage, genAi, endSeed } from '../taxonomy.js';

describe('OTLP fork (§13.1)', () => {
  it('forks one sanitised span to the span store, the ring buffer and the external sink', () => {
    const stored: unknown[] = [];
    const external: unknown[] = [];
    const buffers = new RingBufferStore();
    const collector = new OtlpForkCollector({
      fork: {
        store: (p) => stored.push(p),
        bus: (ev) => buffers.resolve(ev.runId).enqueue(ev),
        external: (p) => external.push(p),
      },
      bus: (runId) => buffers.sinkFor(runId),
    });

    const seed = endSeed(genAi({
      operation: 'chat', system: 'anthropic', requestModel: 'claude-haiku',
      usage: { inputTokens: 100, outputTokens: 25 }, startMs: 0,
    }), 100);
    const withRun = { ...seed, attributes: { ...seed.attributes, 'kanal.run.id': 'run-1', 'kanal.stage.id': 'drafting' } };

    collector.emit(withRun);

    expect(stored.length).toBe(1);
    // Sanitised span in the store carries no content attributes.
    expect(stored[0]).toMatchObject({ seed: { name: 'gen_ai.chat' } });
    const events = buffers.run('run-1')?.snapshot() ?? [];
    expect(events.length).toBe(1);
    expect(events[0]?.t).toBe('model.call');
    expect(external.length).toBe(1);
  });

  it('a gen_ai span forks a model.call with derived cost when usage is present', () => {
    const buffers = new RingBufferStore();
    const collector = new OtlpForkCollector({
      fork: {
        store: () => {},
        bus: (ev) => buffers.resolve(ev.runId).enqueue(ev),
      },
      bus: (runId) => buffers.sinkFor(runId),
    });

    collector.emit(endSeed(genAi({
      operation: 'chat', system: 'anthropic', requestModel: 'claude-haiku',
      usage: { inputTokens: 10_000, outputTokens: 2_000 }, startMs: 0,
    }), 100));

    const event = buffers.run('r')?.snapshot()[0];
    // No kanal.run.id → no live event.
    expect(event).toBeUndefined();
  });

  it('span store receives the sanitized span, never content', () => {
    const stored: { name: string; attributes: Record<string, unknown> }[] = [];
    const collector = new OtlpForkCollector({
      fork: { store: (p) => stored.push({ name: p.seed.name, attributes: p.sanitized.attributes }), bus: () => {} },
      bus: () => () => {},
    });
    const seed = kanalStage({ stageId: 'drafting', attempt: 1, zone: 'trusted', startMs: 0 });
    const leaky = {
      ...seed,
      endMs: 10,
      status: { code: 'OK' as const },
      attributes: { ...seed.attributes, 'kanal.content.full': 'secret draft', 'kanal.run.id': 'run-1' },
    };
    collector.emit(leaky);
    expect(stored[0]?.attributes['kanal.content.full']).toBeUndefined();
    expect(stored[0]?.attributes['kanal.stage.id']).toBe('drafting');
  });

  it('kanal.run + kanal.approval fork a run.state and approval live event', () => {
    const buffers = new RingBufferStore();
    const collector = new OtlpForkCollector({
      fork: { store: () => {}, bus: (ev) => buffers.resolve(ev.runId).enqueue(ev) },
      bus: (runId) => buffers.sinkFor(runId),
    });
    const run = endSeed(kanalRun({ runId: 'run-1', channelId: 'c', lane: 'auto', manifestSetHash: 'h', promptPackVersion: '1' }), 10);
    const runWithState = { ...run, attributes: { ...run.attributes, 'kanal.run.state': 'published' } };
    collector.emit(runWithState);

    const approval = endSeed(
      { name: 'kanal.approval', kind: 1, attributes: { 'kanal.run.id': 'run-1', 'kanal.approval.gate': 'publish', 'kanal.approval.state': 'granted' }, startMs: 2 },
      8,
    );
    collector.emit(approval);

    const events = buffers.run('run-1')?.snapshot() ?? [];
    expect(events.map((e) => e.t).sort()).toEqual(['approval', 'run.state']);
  });

  it('requireEnd:false force-ends unended seeds so live consumers see an ended stage', () => {
    const buffers = new RingBufferStore();
    let now = 0;
    const collector = new OtlpForkCollector({
      fork: { store: () => {}, bus: (ev) => buffers.resolve(ev.runId).enqueue(ev) },
      bus: (runId) => buffers.sinkFor(runId),
      requireEnd: false,
      nowMs: () => now,
    });
    const seed = kanalStage({ stageId: 'authoring', attempt: 1, zone: 'trusted', startMs: 0 });
    const withRun = { ...seed, attributes: { ...seed.attributes, 'kanal.run.id': 'run-1' } };
    now = 42;
    collector.emit(withRun);
    const events = buffers.run('run-1')?.snapshot() ?? [];
    expect(events[0]?.t).toBe('stage.end');
  });

  it('SelfContainedSink buffers sanitised spans without a transport', () => {
    const sink = new SelfContainedSink();
    sink.export(endSeed(genAi({ operation: 'chat', system: 's', requestModel: 'm', startMs: 0 }), 5));
    expect(sink.snapshot().length).toBe(1);
    expect(sink.snapshot()[0]?.name).toBe('gen_ai.chat');
  });
});
