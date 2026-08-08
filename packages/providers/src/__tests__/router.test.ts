import { describe, expect, it } from 'vitest';
import { route, NoRouteAvailableError, isNoRouteAvailable } from '../router.js';
import { type ProviderHandle, type RouterContext, type Binding } from '../router.js';
import { CircuitBreaker } from '../circuit.js';
import { Semaphore } from '../semaphore.js';
import { type CompletionRequest, type CompletionResult } from '../client.js';
import { loadEgress } from '../egress.js';

function fakeProvider(id: string, behavior: { fail?: boolean; error?: { code?: string }; ctx?: number } = {}): ProviderHandle {
  const circuit = new CircuitBreaker();
  const semaphore = new Semaphore(4);
  const doCall = async (): Promise<CompletionResult> => {
    await semaphore.acquire();
    try {
      if (behavior.fail) {
        const e = new Error('boom') as Error & { code?: string };
        if (behavior.error?.code) e.code = behavior.error.code;
        throw e;
      }
      return { ok: true, text: 'hello', model: id };
    } finally {
      semaphore.release();
    }
  };
  return {
    id,
    cfg: {
      id,
      label: id,
      dialect: 'openai_compatible',
      baseUrl: 'https://example.com',
      authKind: 'none',
      dnsMode: 'system',
      tlsInsecure: false,
      timeoutMs: 1000,
      maxConcurrent: 4,
      healthState: 'healthy',
    },
    circuit,
    semaphore,
    egressDenied: false,
    client: {
      async complete(): Promise<CompletionResult> {
        return doCall();
      },
    },
    satisfies() {
      return true;
    },
    async call(_req) {
      return doCall();
    },
  };
}

function makeCtx(providers: Record<string, ProviderHandle>, bindings: Binding[]): RouterContext {
  return {
    providers,
    tierBindings: () => bindings,
    egress: loadEgress({}),
  };
}

const req: CompletionRequest = {
  model: 'x',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 8,
};

describe('routing and fallback (plan §11.6)', () => {
  it('uses the rank-0 binding when it succeeds', async () => {
    const a = fakeProvider('a');
    const b = fakeProvider('b');
    const ctx = makeCtx(
      { a, b },
      [
        { tier: 'M', rank: 0, providerId: 'a', modelRef: 'model-a' },
        { tier: 'M', rank: 1, providerId: 'b', modelRef: 'model-b' },
      ],
    );
    const out = await route('M', { request: req }, ctx);
    expect(out.providerId).toBe('a');
    expect(out.modelRef).toBe('model-a');
    expect(out.fallbackUsed).toBe(false);
    expect(out.result.ok).toBe(true);
  });

  it('falls back to rank-1 when rank-0 fails', async () => {
    const a = fakeProvider('a', { fail: true, error: { code: 'http_500' } });
    const b = fakeProvider('b');
    const ctx = makeCtx(
      { a, b },
      [
        { tier: 'M', rank: 0, providerId: 'a', modelRef: 'model-a' },
        { tier: 'M', rank: 1, providerId: 'b', modelRef: 'model-b' },
      ],
    );
    const out = await route('M', { request: req, retries: 0 }, ctx);
    expect(out.providerId).toBe('b');
    expect(out.fallbackUsed).toBe(true);
  });

  it('skips open circuits', async () => {
    const a = fakeProvider('a');
    // Force the circuit open.
    a.circuit.recordFailure();
    a.circuit.recordFailure();
    a.circuit.recordFailure();
    a.circuit.recordFailure();
    a.circuit.recordFailure();
    expect(a.circuit.isOpen()).toBe(true);

    const b = fakeProvider('b');
    const ctx = makeCtx(
      { a, b },
      [
        { tier: 'M', rank: 0, providerId: 'a', modelRef: 'model-a' },
        { tier: 'M', rank: 1, providerId: 'b', modelRef: 'model-b' },
      ],
    );
    const out = await route('M', { request: req, retries: 0 }, ctx);
    expect(out.providerId).toBe('b');
  });

  it('throws NoRouteAvailable when all bindings fail', async () => {
    const a = fakeProvider('a', { fail: true, error: { code: 'http_500' } });
    const ctx = makeCtx(
      { a },
      [{ tier: 'M', rank: 0, providerId: 'a', modelRef: 'model-a' }],
    );
    await expect(route('M', { request: req, retries: 0 }, ctx)).rejects.toThrow(NoRouteAvailableError);
    await expect(route('M', { request: req, retries: 0 }, ctx)).rejects.toMatchObject({ name: 'NoRouteAvailable' });
  });

  it('skips unsatisfied requirements (plan §11.5 pre-flight)', async () => {
    const a = fakeProvider('a');
    a.satisfies = () => false;
    const b = fakeProvider('b');
    const ctx = makeCtx(
      { a, b },
      [
        { tier: 'L', rank: 0, providerId: 'a', modelRef: 'model-a' },
        { tier: 'L', rank: 1, providerId: 'b', modelRef: 'model-b' },
      ],
    );
    const out = await route('L', { request: req, requirements: { structuredOutput: 'required' } }, ctx);
    expect(out.providerId).toBe('b');
  });

  it('skips egress-denied providers', async () => {
    const a = fakeProvider('a');
    a.egressDenied = true;
    const b = fakeProvider('b');
    const ctx = makeCtx(
      { a, b },
      [
        { tier: 'M', rank: 0, providerId: 'a', modelRef: 'model-a' },
        { tier: 'M', rank: 1, providerId: 'b', modelRef: 'model-b' },
      ],
    );
    const out = await route('M', { request: req, retries: 0 }, ctx);
    expect(out.providerId).toBe('b');
  });

  it('permanent failures skip to the next binding without retrying', async () => {
    const a = fakeProvider('a', { fail: true, error: { code: 'http_401' } });
    const b = fakeProvider('b');
    const ctx = makeCtx(
      { a, b },
      [
        { tier: 'M', rank: 0, providerId: 'a', modelRef: 'model-a' },
        { tier: 'M', rank: 1, providerId: 'b', modelRef: 'model-b' },
      ],
    );
    const out = await route('M', { request: req }, ctx);
    expect(out.providerId).toBe('b');
  });

  it('records circuit failures on each error', async () => {
    const a = fakeProvider('a', { fail: true, error: { code: 'http_500' } });
    const b = fakeProvider('b');
    const ctx = makeCtx(
      { a, b },
      [
        { tier: 'M', rank: 0, providerId: 'a', modelRef: 'model-a' },
        { tier: 'M', rank: 1, providerId: 'b', modelRef: 'model-b' },
      ],
    );
    await route('M', { request: req, retries: 0 }, ctx);
    expect(a.circuit.recentFailures()).toBe(1);
  });

  it('isNoRouteAvailable type guard', () => {
    expect(isNoRouteAvailable(new NoRouteAvailableError('M', {}))).toBe(true);
    expect(isNoRouteAvailable(new Error('nope'))).toBe(false);
  });
});
