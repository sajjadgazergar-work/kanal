import { describe, expect, it } from 'vitest';
import { validateProvider, outcomeForStatus } from '../validation.js';
import { type Transport, type HttpRequestOptions } from '../transport.js';
import { type ProviderConfig } from '../config.js';
import { type ModelClient } from '../client.js';
import { type ProbeCompletionRequest, type ProbeCompletionResponse } from '../probe/engine.js';

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
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

function fakeTransport(
  responses: Array<{ status: number; body: string }>,
  failures: Array<{ code: string }> = [],
): Transport {
  let i = 0;
  let j = 0;
  return {
    async request(_opts: HttpRequestOptions) {
      if (failures[j]) {
        const f = failures[j++];
        const e = new Error(f.code) as Error & { code?: string };
        e.code = f.code;
        throw e;
      }
      const r = responses[i++];
      if (!r) throw new Error('no more responses');
      return { status: r.status, body: r.body, headers: {} };
    },
  };
}

function okClient(): (model: string) => ModelClient {
  return () => ({
    async complete(req: ProbeCompletionRequest): Promise<ProbeCompletionResponse> {
      if (req.tools) return { ok: true, toolCalls: [{ name: 'get_weather', arguments: '{"city":"Tehran"}' }] };
      if (req.responseFormat) return { ok: true, text: '{"n":7}' };
      // Context probe: model accepts up to 32k tokens (~128k chars at 4 chars/token).
      if (req.messages[0]?.content.length && req.messages[0].content.length > 128_000) {
        return { ok: false, error: { type: 'context_length_exceeded', message: 'too long' } };
      }
      return { ok: true, usage: { inputTokens: 12, outputTokens: 8 }, streamed: true };
    },
  });
}

describe('validateProvider end-to-end (§11.2)', () => {
  it('reaches healthy when discovery and all probes pass', async () => {
    const t = fakeTransport([
      { status: 200, body: JSON.stringify({ data: [{ id: 'm1' }] }) },
    ]);
    const r = await validateProvider(cfg(), { transport: t, decryptKey: () => 'sk' }, okClient());
    expect(r.state).toBe('healthy');
    expect(r.models.map((m) => m.id)).toEqual(['m1']);
    expect(r.probes.length).toBeGreaterThanOrEqual(1);
  });

  it('reaches degraded when some probes fail', async () => {
    const t = fakeTransport([
      { status: 200, body: JSON.stringify({ data: [{ id: 'm1' }] }) },
    ]);
    const client = (): ModelClient => ({
      async complete(req: ProbeCompletionRequest): Promise<ProbeCompletionResponse> {
        // liveness passes, tool calling fails, structured fails, context fails → partial
        if (req.tools) return { ok: true, text: 'no tools' };
        if (req.responseFormat) return { ok: true, text: '{"n":99}' };
        if (req.messages[0] && req.messages[0].content.length > 8000) {
          return { ok: false, error: { type: 'context_length_exceeded', message: 'too long' } };
        }
        return { ok: true, usage: { inputTokens: 12, outputTokens: 8 } };
      },
    });
    const r = await validateProvider(cfg(), { transport: t, decryptKey: () => 'sk' }, client);
    expect(r.state).toBe('degraded');
  });

  it('maps 401 discovery → fail_auth / http_401', async () => {
    const t = fakeTransport([{ status: 401, body: '{"error":"unauthorized"}' }]);
    const r = await validateProvider(cfg(), { transport: t, decryptKey: () => 'bad' });
    expect(r.state).toBe('fail_auth');
    expect(r.code).toBe('http_401');
  });

  it('maps 403 region marker → http_403_region', async () => {
    const t = fakeTransport([{ status: 403, body: '{"error":"request blocked in your country"}' }]);
    const r = await validateProvider(cfg(), { transport: t, decryptKey: () => 'sk' });
    expect(r.state).toBe('fail_auth');
    expect(r.code).toBe('http_403_region');
  });

  it('maps 403 without region marker → http_403_other', async () => {
    const t = fakeTransport([{ status: 403, body: '{"error":"forbidden"}' }]);
    const r = await validateProvider(cfg(), { transport: t, decryptKey: () => 'sk' });
    expect(r.state).toBe('fail_auth');
    expect(r.code).toBe('http_403_other');
  });

  it('maps 404 → http_404', async () => {
    const t = fakeTransport([{ status: 404, body: '{}' }]);
    const r = await validateProvider(cfg(), { transport: t, decryptKey: () => 'sk' });
    expect(r.state).toBe('fail_path');
    expect(r.code).toBe('http_404');
  });

  it('maps 429 → http_429 and 5xx → http_5xx', async () => {
    const t1 = fakeTransport([{ status: 429, body: '{}' }]);
    expect((await validateProvider(cfg(), { transport: t1, decryptKey: () => 'sk' })).code).toBe('http_429');
    const t2 = fakeTransport([{ status: 503, body: '{}' }]);
    expect((await validateProvider(cfg(), { transport: t2, decryptKey: () => 'sk' })).code).toBe('http_5xx');
  });

  it('maps non-JSON body → body_not_json', async () => {
    const t = fakeTransport([{ status: 200, body: '<html>captive portal</html>' }]);
    const r = await validateProvider(cfg(), { transport: t, decryptKey: () => 'sk' });
    expect(r.state).toBe('fail_body');
    expect(r.code).toBe('body_not_json');
  });

  it('maps empty model list → models_empty', async () => {
    const t = fakeTransport([{ status: 200, body: JSON.stringify({ data: [] }) }]);
    const r = await validateProvider(cfg(), { transport: t, decryptKey: () => 'sk' });
    expect(r.state).toBe('fail_empty');
    expect(r.code).toBe('models_empty');
  });

  it('maps unexpected JSON shape → body_unexpected_shape', async () => {
    const t = fakeTransport([{ status: 200, body: JSON.stringify({ nope: true }) }]);
    const r = await validateProvider(cfg(), { transport: t, decryptKey: () => 'sk' });
    expect(r.state).toBe('fail_empty');
    expect(r.code).toBe('body_unexpected_shape');
  });

  it('maps transport failures to their codes', async () => {
    const cases: Array<[string, string]> = [
      ['dns_nxdomain', 'fail_dns'],
      ['dns_timeout', 'fail_dns'],
      ['tcp_refused', 'fail_tcp'],
      ['tcp_timeout', 'fail_tcp'],
      ['tls_cert_invalid', 'fail_tls'],
      ['tls_protocol', 'fail_tls'],
      ['egress_denied', 'fail_dns'],
    ];
    for (const [code, state] of cases) {
      const t = fakeTransport([], [{ code }]);
      const r = await validateProvider(cfg(), { transport: t, decryptKey: () => 'sk' });
      expect(r.state, code).toBe(state);
      expect(r.code, code).toBe(code);
    }
  });

  it('transitions include the deterministic sequence', async () => {
    const t = fakeTransport([
      { status: 200, body: JSON.stringify({ data: [{ id: 'm1' }] }) },
    ]);
    const r = await validateProvider(cfg(), { transport: t, decryptKey: () => 'sk' }, okClient());
    const states = r.transitions.map((tr) => tr.state);
    expect(states[0]).toBe('unconfigured');
    expect(states).toEqual(expect.arrayContaining(['dns', 'tcp', 'tls', 'http', 'parse', 'probing', 'healthy']));
  });

  it('outcomeForStatus classifies per §11.2', () => {
    expect(outcomeForStatus(200, '')).toBe('success');
    expect(outcomeForStatus(401, '')).toBe('unauthorized');
    expect(outcomeForStatus(404, '')).toBe('not_found');
    expect(outcomeForStatus(429, '')).toBe('throttled');
    expect(outcomeForStatus(503, '')).toBe('upstream');
  });
});
