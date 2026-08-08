import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { FakeRunner, sampleSnapshot } from './fake-runner.js';

const API_KEY = 'test-secret-key-1234567890';

function makeServer(runner: FakeRunner, overrides: Partial<Parameters<typeof buildServer>[0]> = {}): FastifyInstance {
  const app = buildServer({
    apiKey: API_KEY,
    runner,
    webhookSecrets: {
      async getSecret() {
        return null;
      },
    },
    pingDb: async () => true,
    logger: false,
    ...overrides,
  });
  return app;
}

describe('auth (plan §20.1)', () => {
  it('rejects a request without a bearer token', async () => {
    const runner = new FakeRunner();
    const app = makeServer(runner);
    const res = await app.inject({ method: 'GET', url: '/api/v1/healthz' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
    await app.close();
  });

  it('rejects a wrong API key', async () => {
    const runner = new FakeRunner();
    const app = makeServer(runner);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/healthz',
      headers: { authorization: 'Bearer wrong-key' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts the correct API key', async () => {
    const runner = new FakeRunner();
    const app = makeServer(runner);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/healthz',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('POST /api/v1/runs', () => {
  let runner: FakeRunner;
  let app: FastifyInstance;

  beforeEach(async () => {
    runner = new FakeRunner();
    app = makeServer(runner);
  });

  it('starts a run and returns 201 with the run id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {
        orgId: 'org-1',
        channelId: 'chan-1',
        lane: 'copilot',
        brief: { angle: 'testing' },
        manifestSetHash: 'abc',
        promptPackVersion: '1.0.0',
        budgetCapUsd: 0.3,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().runId).toBe('run-1');
    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]!.lane).toBe('copilot');
    expect(runner.starts[0]!.budgetCapUsd).toBe(0.3);
    await app.close();
  });

  it('defaults brief and budget cap when omitted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {
        orgId: 'org-1',
        channelId: 'chan-1',
        lane: 'auto',
        manifestSetHash: 'abc',
        promptPackVersion: '1.0.0',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(runner.starts[0]!.brief).toEqual({});
    expect(runner.starts[0]!.budgetCapUsd).toBe(0.15);
    await app.close();
  });

  it('returns 400 for an invalid lane', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {
        orgId: 'org-1',
        channelId: 'chan-1',
        lane: 'banana',
        manifestSetHash: 'abc',
        promptPackVersion: '1.0.0',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(runner.starts).toHaveLength(0);
    await app.close();
  });

  it('returns 400 on missing fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { orgId: 'org-1' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /api/v1/runs/:id', () => {
  let runner: FakeRunner;
  let app: FastifyInstance;

  beforeEach(async () => {
    runner = new FakeRunner();
    app = makeServer(runner);
  });

  it('returns the snapshot', async () => {
    runner.setSnapshot('run-1', sampleSnapshot('run-1'));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/runs/run-1',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runId).toBe('run-1');
    expect(body.state).toBe('review_pending');
    expect(body.steps).toHaveLength(1);
    await app.close();
  });

  it('returns 404 for an unknown run', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/runs/nope',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('run_not_found');
    await app.close();
  });
});

describe('POST /api/v1/runs/:id/signal', () => {
  let runner: FakeRunner;
  let app: FastifyInstance;

  beforeEach(async () => {
    runner = new FakeRunner();
    app = makeServer(runner);
  });

  it('approves a gate', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/run-1/signal',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {
        kind: 'approval',
        gate: 'publish',
        decision: 'granted',
        decidedBy: 'human:u1',
        note: 'ship it',
      },
    });
    expect(res.statusCode).toBe(202);
    expect(runner.signals).toHaveLength(1);
    expect(runner.signals[0]!.sig).toMatchObject({ kind: 'approval', decision: 'granted', note: 'ship it' });
    await app.close();
  });

  it('cancels a run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/run-1/signal',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { kind: 'cancel' },
    });
    expect(res.statusCode).toBe(202);
    expect(runner.cancels).toHaveLength(1);
    await app.close();
  });

  it('returns 400 for an invalid signal body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/run-1/signal',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { kind: 'approval', gate: 'publish' }, // missing decision
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 409 when the runner rejects the transition', async () => {
    runner.signalThrows = true;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/run-1/signal',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { kind: 'resume' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('invalid_transition');
    await app.close();
  });
});

describe('GET /api/v1/healthz', () => {
  it('returns 200 when postgres is reachable', async () => {
    const runner = new FakeRunner();
    const app = makeServer(runner, { pingDb: async () => true });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/healthz',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('returns 503 when postgres is down', async () => {
    const runner = new FakeRunner();
    const app = makeServer(runner, { pingDb: async () => false });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/healthz',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe('rate limiting (plan §12.7, D6)', () => {
  it('rate-limits the signal route', async () => {
    const runner = new FakeRunner();
    // Capacity 2 → third request in the same window is 429.
    const app = makeServer(runner, { signalRate: { capacity: 2, refillPerSec: 0 } });
    const hit = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/runs/run-1/signal',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { kind: 'resume' },
      });
    expect((await hit()).statusCode).toBe(202);
    expect((await hit()).statusCode).toBe(202);
    expect((await hit()).statusCode).toBe(429);
    await app.close();
  });

  it('rate-limits the webhook route', async () => {
    const runner = new FakeRunner();
    const body = JSON.stringify({ title: 'x' });
    const { createHmac } = await import('node:crypto');
    const secret = 'whsec_test';
    const ts = Date.now();
    const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    const app = makeServer(
      runner,
      {
        webhookRate: { capacity: 1, refillPerSec: 0 },
        webhookSecrets: {
          async getSecret() {
            return secret;
          },
        },
      },
    );
    const hit = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/sources/src-1/webhook',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
          'kanal-signature': `t=${ts},v1=${sig}`,
        },
        payload: body,
      });
    expect((await hit()).statusCode).toBe(202);
    expect((await hit()).statusCode).toBe(429);
    await app.close();
  });

  it('does not rate-limit ordinary read routes', async () => {
    const runner = new FakeRunner();
    const app = makeServer(runner, { signalRate: { capacity: 1, refillPerSec: 0 } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/healthz',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('providers validate (plan §11)', () => {
  it('returns 501 when no validator is injected and @kanal/providers is unavailable', async () => {
    const runner = new FakeRunner();
    const app = makeServer(runner, {});
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/validate',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { baseUrl: 'https://example.com/api', authKind: 'none' },
    });
    expect(res.statusCode).toBe(501);
    await app.close();
  });

  it('returns 400 for a malformed body', async () => {
    const runner = new FakeRunner();
    const app = makeServer(runner, {});
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/validate',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { baseUrl: 'not-a-url', authKind: 'banana' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('delegates to an injected validator', async () => {
    const runner = new FakeRunner();
    const app = makeServer(runner, {
      providerValidator: async (input) => {
        const i = input as { baseUrl: string };
        return { ok: true, baseUrl: i.baseUrl };
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/validate',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { baseUrl: 'https://example.com/api', authKind: 'none' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });
});
