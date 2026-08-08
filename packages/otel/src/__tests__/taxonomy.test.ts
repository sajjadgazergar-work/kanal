import { describe, expect, it } from 'vitest';
import {
  kanalRun,
  kanalStage,
  genAi,
  kanalTool,
  kanalPublish,
  kanalApproval,
  endSeed,
  endSeedError,
} from '../taxonomy.js';

describe('span taxonomy (§13.2)', () => {
  it('kanal.run carries the required attributes', () => {
    const s = kanalRun({
      runId: 'run-1',
      channelId: 'ch-1',
      lane: 'auto',
      manifestSetHash: 'abc123',
      promptPackVersion: '1.2.0',
      startMs: 1000,
    });
    expect(s.name).toBe('kanal.run');
    expect(s.kind).toBe(2); // server
    expect(s.attributes).toMatchObject({
      'kanal.run.id': 'run-1',
      'kanal.channel.id': 'ch-1',
      'kanal.lane': 'auto',
      'kanal.manifest_set_hash': 'abc123',
      'kanal.prompt_pack.version': '1.2.0',
    });
  });

  it('kanal.stage.{stage_id} carries required attributes', () => {
    const s = kanalStage({ stageId: 'drafting', attempt: 2, zone: 'trusted', agentRef: 'writer', startMs: 5 });
    expect(s.name).toBe('kanal.stage.drafting');
    expect(s.attributes['kanal.stage.id']).toBe('drafting');
    expect(s.attributes['kanal.stage.attempt']).toBe(2);
    expect(s.attributes['kanal.zone']).toBe('trusted');
    expect(s.attributes['kanal.agent.ref']).toBe('writer');
  });

  it('gen_ai.{operation} supports chat and embeddings with GenAI attrs', () => {
    const chat = genAi({
      operation: 'chat',
      system: 'anthropic',
      requestModel: 'claude-haiku',
      usage: { inputTokens: 100, outputTokens: 25 },
      startMs: 0,
    });
    expect(chat.name).toBe('gen_ai.chat');
    expect(chat.kind).toBe(3); // client
    expect(chat.attributes['gen_ai.operation.name']).toBe('chat');
    expect(chat.attributes['gen_ai.usage.input_tokens']).toBe(100);

    const emb = genAi({ operation: 'embeddings', system: 'openai', requestModel: 'text-embedding-3', startMs: 1 });
    expect(emb.name).toBe('gen_ai.embeddings');
    expect(emb.attributes['gen_ai.operation.name']).toBe('embeddings');
  });

  it('kanal.tool.{capability_id} and kanal.publish and kanal.approval carry required attributes', () => {
    const tool = kanalTool({ capabilityId: 'source.read_snapshot', risk: 0, result: 'ok', startMs: 1 });
    expect(tool.name).toBe('kanal.tool.source.read_snapshot');
    expect(tool.attributes['kanal.capability.id']).toBe('source.read_snapshot');
    expect(tool.attributes['kanal.capability.risk']).toBe(0);

    const pub = kanalPublish({ platform: 'telegram', idempotencyKey: 'k1', outcome: 'ok', httpStatusCode: 200, startMs: 1 });
    expect(pub.name).toBe('kanal.publish');
    expect(pub.attributes['kanal.platform']).toBe('telegram');
    expect(pub.attributes['http.response.status_code']).toBe(200);

    const appr = kanalApproval({ gate: 'publish', state: 'pending', actor: 'human-1', startMs: 1 });
    expect(appr.name).toBe('kanal.approval');
    expect(appr.attributes['kanal.approval.gate']).toBe('publish');
    expect(appr.attributes['kanal.approval.state']).toBe('pending');
    expect(appr.attributes['kanal.actor']).toBe('human-1');
  });

  it('endSeed marks ok, endSeedError marks error', () => {
    const ok = endSeed(kanalStage({ stageId: 'drafting', attempt: 1, zone: 'trusted', startMs: 100 }), 250);
    expect(ok.endMs).toBe(250);
    expect(ok.status?.code).toBe('OK');

    const err = endSeedError(kanalStage({ stageId: 'drafting', attempt: 1, zone: 'trusted', startMs: 100 }), 'boom', 300);
    expect(err.status?.code).toBe('ERROR');
    expect(err.status?.message).toBe('boom');
  });
});
