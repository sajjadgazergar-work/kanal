import { describe, expect, it } from 'vitest';
import { ModelClient } from '../client.js';
import { type Transport } from '../transport.js';
import { type ProviderConfig } from '../config.js';

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p1',
    label: 'Provider 1',
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

function fakeTransport(body: string): { transport: Transport; urls: string[]; headers: string[][] } {
  const urls: string[] = [];
  const headers: string[][] = [];
  const transport: Transport = {
    async request(opts) {
      urls.push(opts.url);
      headers.push(Object.entries(opts.headers ?? {}).map(([k, v]) => `${k}: ${v}`));
      return { status: 200, body, headers: { 'content-type': 'application/json' } };
    },
  };
  return { transport, urls, headers };
}

describe('ModelClient dialect layer', () => {
  it('posts to /v1/chat/completions for openai_compatible with Bearer auth', async () => {
    const { transport, urls, headers } = fakeTransport(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    const client = new ModelClient(cfg({ authKind: 'bearer' }), transport, () => 'sk-1');
    const r = await client.complete({ model: 'm1', messages: [{ role: 'user', content: 'hello' }], maxTokens: 8 });
    expect(urls[0]).toBe('https://api.example.com/v1/chat/completions');
    expect(headers[0].join('\n')).toContain('Authorization: Bearer sk-1');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('hi');
    expect(r.usage?.inputTokens).toBe(3);
  });

  it('posts to /v1/messages for anthropic with x-api-key + anthropic-version', async () => {
    const { transport, urls, headers } = fakeTransport(JSON.stringify({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 3, output_tokens: 1 } }));
    const client = new ModelClient(cfg({ dialect: 'anthropic', authKind: 'x_api_key' }), transport, () => 'sk-2');
    const r = await client.complete({ model: 'claude-3', messages: [{ role: 'user', content: 'hello' }], maxTokens: 8 });
    expect(urls[0]).toBe('https://api.example.com/v1/messages');
    expect(headers[0].join('\n')).toContain('x-api-key: sk-2');
    expect(headers[0].join('\n')).toContain('anthropic-version: 2023-06-01');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('hi');
  });

  it('posts to /api/chat for ollama with no auth', async () => {
    const { transport, urls, headers } = fakeTransport(JSON.stringify({ message: { content: 'hi' }, done: true }));
    const client = new ModelClient(cfg({ dialect: 'ollama', authKind: 'none' }), transport, () => undefined);
    const r = await client.complete({ model: 'llama3', messages: [{ role: 'user', content: 'hello' }], maxTokens: 8 });
    expect(urls[0]).toBe('https://api.example.com/api/chat');
    expect(headers[0].join('\n')).not.toContain('Authorization');
    expect(r.ok).toBe(true);
  });

  it('parses tool calls from the OpenAI-compatible shape', async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"Tehran"}' } }] } }],
    });
    const { transport } = fakeTransport(body);
    const client = new ModelClient(cfg({}), transport, () => undefined);
    const r = await client.complete({ model: 'm1', messages: [{ role: 'user', content: 'weather' }], maxTokens: 64, tools: [] });
    expect(r.ok).toBe(true);
    expect(r.toolCalls?.[0]?.name).toBe('get_weather');
    expect(r.toolCalls?.[0]?.arguments).toBe('{"city":"Tehran"}');
  });

  it('returns ok:false with a transport error instead of throwing', async () => {
    const transport: Transport = {
      async request() {
        const e = new Error('network down') as Error & { code?: string };
        e.code = 'tcp_timeout';
        throw e;
      },
    };
    const client = new ModelClient(cfg({}), transport, () => undefined);
    const r = await client.complete({ model: 'm1', messages: [{ role: 'user', content: 'x' }], maxTokens: 8 });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('transport');
  });

  it('honors custom_header auth kind', async () => {
    const { transport, headers } = fakeTransport('{}');
    const client = new ModelClient(cfg({ authKind: 'custom_header', customHeaderName: 'x-ai-key' }), transport, () => 'k3');
    await client.complete({ model: 'm1', messages: [{ role: 'user', content: 'x' }], maxTokens: 8 });
    expect(headers[0].join('\n')).toContain('x-ai-key: k3');
  });

  it('sends extraHeaders verbatim', async () => {
    const { transport, headers } = fakeTransport('{}');
    const client = new ModelClient(cfg({ extraHeaders: { 'HTTP-Referer': 'https://kanal.dev', 'X-Title': 'KANAL' } }), transport, () => 'sk');
    await client.complete({ model: 'm1', messages: [{ role: 'user', content: 'x' }], maxTokens: 8 });
    const joined = headers[0].join('\n');
    expect(joined).toContain('HTTP-Referer: https://kanal.dev');
    expect(joined).toContain('X-Title: KANAL');
  });
});
