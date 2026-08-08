import { describe, expect, it } from 'vitest';
import { openaiModelsUrl, anthropicModelsUrl, ollamaModelsUrl, discoveryHeaders, parseModelList, MAX_ANTHROPIC_PAGES } from '../discovery.js';
import { discoverModels } from '../discoveryRunner.js';
import { type Transport, type HttpResponse } from '../transport.js';
import { type ProviderConfig } from '../config.js';

function cfg(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: 'p1',
    label: 'Test',
    dialect: 'openai_compatible',
    baseUrl: 'https://api.example.com',
    authKind: 'bearer',
    dnsMode: 'system',
    tlsInsecure: false,
    timeoutMs: 1000,
    maxConcurrent: 4,
    healthState: 'unconfigured',
    ...overrides,
  };
}

function fakeTransport(responses: HttpResponse[]): Transport {
  let i = 0;
  return {
    async request() {
      const r = responses[i];
      i++;
      if (!r) throw new Error('no more responses');
      return r;
    },
  };
}

describe('model discovery (§11.1)', () => {
  it('builds the right URLs per dialect', () => {
    expect(openaiModelsUrl('https://openrouter.ai/api')).toBe('https://openrouter.ai/api/v1/models');
    expect(anthropicModelsUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/models');
    expect(ollamaModelsUrl('http://localhost:11434')).toBe('http://localhost:11434/api/tags');
  });

  it('sets per-dialect auth headers', () => {
    const openai = discoveryHeaders('openai_compatible', 'sk-1', undefined, undefined);
    expect(openai.Authorization).toBe('Bearer sk-1');
    const anth = discoveryHeaders('anthropic', 'sk-2', undefined, undefined);
    expect(anth['x-api-key']).toBe('sk-2');
    expect(anth['anthropic-version']).toBe('2023-06-01');
    const custom = discoveryHeaders('openai_compatible', 'k3', 'x-secret', undefined);
    expect(custom['x-secret']).toBe('k3');
    const none = discoveryHeaders('ollama', 'should-not-be-sent', undefined, undefined);
    expect(none.Authorization).toBeUndefined();
    expect(none['x-api-key']).toBeUndefined();
  });

  it('parses OpenAI-style { data: [...] }', () => {
    const models = parseModelList({ data: [{ id: 'gpt-4o' }, { id: 'claude-3' }] }, 'openai_compatible');
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'claude-3']);
  });

  it('parses Anthropic-style { data: [...] } and { models: [...] }', () => {
    expect(parseModelList({ data: [{ id: 'claude-3-5-sonnet' }] }, 'anthropic').map((m) => m.id)).toEqual(['claude-3-5-sonnet']);
    expect(parseModelList({ models: [{ id: 'claude-3-opus' }] }, 'anthropic').map((m) => m.id)).toEqual(['claude-3-opus']);
  });

  it('parses Ollama-style { models: [{ name }] }', () => {
    const models = parseModelList({ models: [{ name: 'llama3:latest' }, { name: 'mistral' }] }, 'ollama');
    expect(models.map((m) => m.id)).toEqual(['llama3:latest', 'mistral']);
  });

  it('returns [] for unexpected shapes', () => {
    expect(parseModelList({ hello: 'world' }, 'openai_compatible')).toEqual([]);
    expect(parseModelList('<html>captive portal</html>', 'openai_compatible')).toEqual([]);
  });

  it('discoverModels succeeds on a 200 with a model list', async () => {
    const t = fakeTransport([
      { status: 200, body: JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), headers: {} },
    ]);
    const r = await discoverModels(cfg({}), t, () => 'sk-1');
    expect(r.ok).toBe(true);
    expect(r.models.map((m) => m.id)).toEqual(['a', 'b']);
    expect(r.url).toBe('https://api.example.com/v1/models');
  });

  it('discoverModels reports a non-200 as not ok', async () => {
    const t = fakeTransport([
      { status: 401, body: '{"error":"unauthorized"}', headers: { 'content-type': 'application/json' } },
    ]);
    const r = await discoverModels(cfg({}), t, () => 'bad-key');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it('anthropic pagination respects the 20-page hard cap', async () => {
    const pages: HttpResponse[] = Array.from({ length: 40 }, (_, i) => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: `m${i}` }], has_more: true }),
      headers: {},
    }));
    const t = fakeTransport(pages);
    const r = await discoverModels(cfg({ dialect: 'anthropic', authKind: 'x_api_key' }), t, () => 'sk');
    expect(r.pages).toBe(MAX_ANTHROPIC_PAGES);
    expect(r.models).toHaveLength(MAX_ANTHROPIC_PAGES);
  });
});
