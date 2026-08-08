import { describe, expect, it, vi } from 'vitest';
import { runProbe, ProbeCache, probeCacheKey } from '../probe/engine.js';
import { type ModelClient, type ProbeCompletionResponse, type ProbeCompletionRequest } from '../probe/engine.js';
import { PROBE_CACHE_TTL_MS } from '../probe/types.js';

function fakeClient(handler: (req: ProbeCompletionRequest) => ProbeCompletionResponse): ModelClient {
  return { complete: vi.fn(async (req) => handler(req)) };
}

describe('capability probes (plan §11.4)', () => {
  it('probe 1 liveness: passes with usage + streaming', async () => {
    const client = fakeClient((req) => ({
      ok: true,
      usage: { inputTokens: 12, outputTokens: 8 },
      streamed: Boolean(req.stream),
    }));
    const r = await runProbe(client, 'm1', 'liveness');
    expect(r.passed).toBe(true);
    expect(r.records).toMatchObject({ streaming: true, usageReported: true });
  });

  it('probe 2 tool calling: passes on valid get_weather tool call with JSON args', async () => {
    const client = fakeClient(() => ({
      ok: true,
      toolCalls: [{ name: 'get_weather', arguments: '{"city":"Tehran"}' }],
    }));
    const r = await runProbe(client, 'm1', 'tool_calling');
    expect(r.passed).toBe(true);
    expect(r.records.toolCalling).toBe(true);
  });

  it('probe 2 fails with probe_no_tool_calling when no tool call', async () => {
    const client = fakeClient(() => ({ ok: true, text: 'no tools here' }));
    const r = await runProbe(client, 'm1', 'tool_calling');
    expect(r.passed).toBe(false);
    expect(r.failureCode).toBe('probe_no_tool_calling');
  });

  it('probe 3 structured output: passes when n === 7', async () => {
    const client = fakeClient(() => ({ ok: true, text: '{"n":7}' }));
    const r = await runProbe(client, 'm1', 'structured_output');
    expect(r.passed).toBe(true);
    expect(r.records.structuredOutput).toBe('native');
  });

  it('probe 3 fails with probe_no_structured_output when n !== 7', async () => {
    const client = fakeClient(() => ({ ok: true, text: '{"n":3}' }));
    const r = await runProbe(client, 'm1', 'structured_output');
    expect(r.passed).toBe(false);
    expect(r.failureCode).toBe('probe_no_structured_output');
  });

  it('probe 4 context ceiling: binary search finds the ceiling', async () => {
    // Model accepts up to ~32k tokens.
    const client = fakeClient((req) => {
      const size = req.messages[0]?.content.length ?? 0;
      if (size > 32_000 * 4) {
        return { ok: false, error: { type: 'context_length_exceeded', message: 'too long' } };
      }
      return { ok: true };
    });
    const r = await runProbe(client, 'm1', 'context_ceiling');
    expect(r.passed).toBe(true);
    const ceiling = r.records.observedContextWindow as number;
    expect(ceiling).toBeGreaterThan(0);
    expect(ceiling).toBeLessThanOrEqual(32_000);
    expect(ceiling).toBeGreaterThanOrEqual(8000);
  });

  it('probe 4 fails with probe_context_short when even 8k is rejected', async () => {
    const client = fakeClient(() => ({ ok: false, error: { type: 'context_length_exceeded', message: 'too long' } }));
    const r = await runProbe(client, 'm1', 'context_ceiling');
    expect(r.passed).toBe(false);
    expect(r.failureCode).toBe('probe_context_short');
  });

  it('probe 5 vision: passes when no modality error', async () => {
    const client = fakeClient(() => ({ ok: true }));
    const r = await runProbe(client, 'm1', 'vision');
    expect(r.passed).toBe(true);
    expect(r.records.vision).toBe(true);
  });

  it('probe 6 prompt cache: detects cached input tokens on the second call', async () => {
    let call = 0;
    const client = fakeClient(() => {
      call++;
      return {
        ok: true,
        usage: { inputTokens: 2500, outputTokens: 4, cachedInputTokens: call >= 2 ? 2500 : 0 },
      };
    });
    const r = await runProbe(client, 'm1', 'prompt_cache');
    expect(r.passed).toBe(true);
    expect(r.records.promptCache).toBe(true);
  });

  it('probe cache respects the 14-day TTL', () => {
    const cache = new ProbeCache(PROBE_CACHE_TTL_MS);
    const key = probeCacheKey('p1', 'm1', 'liveness');
    const result = { probe: 'liveness' as const, passed: true, records: {} };
    cache.set(key, result, 1_000_000);
    expect(cache.get(key, 1_000_000 + 13 * 24 * 60 * 60 * 1000)).toBe(result);
    // Just past 14 days → expired.
    expect(cache.get(key, 1_000_000 + 15 * 24 * 60 * 60 * 1000)).toBeUndefined();
  });
});
