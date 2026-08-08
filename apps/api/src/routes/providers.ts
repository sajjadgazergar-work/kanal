import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * Provider validation endpoint (plan §11.2, §11.3, §14.2):
 *
 *   POST /api/v1/providers/validate
 *     body: { baseUrl, authKind, authHeader }
 *
 * Performs the discovery + probe flow (plan §11.4). The `@kanal/providers`
 * package is still in flight (it did not build until recently), so this route
 * loads it dynamically: when it is unavailable we return a clear 501 rather
 * than hard-failing the whole build. Production wiring can also inject a
 * validator directly via `buildServer`.
 */

const validateSchema = z.object({
  baseUrl: z.string().url(),
  authKind: z.enum(['bearer', 'x_api_key', 'none', 'custom_header']).default('none'),
  authHeader: z.string().optional(),
});
export type ValidateBody = z.infer<typeof validateSchema>;

export interface ProvidersRouteOptions {
  /**
   * Injection point for the discovery + probe implementation. When absent the
   * route attempts a dynamic import of `@kanal/providers`; if that also fails
   * it returns 501.
   */
  validate?: (input: ValidateBody) => Promise<unknown>;
}

export async function registerProviderRoutes(app: FastifyInstance, opts: ProvidersRouteOptions = {}): Promise<void> {
  const { validate } = opts;

  app.post<{ Body: unknown }>('/providers/validate', async (request, reply) => {
    const parsed = validateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_body', message: parsed.error.issues[0]?.message ?? 'invalid body' });
    }

    const runner = validate ?? (await lazyValidate());
    if (runner === null) {
      return reply.code(501).send({
        error: 'not_implemented',
        message: 'provider validation is not available in this build yet',
      });
    }

    try {
      const result = await runner(parsed.data);
      return reply.send(result);
    } catch (err) {
      request.log.error({ err }, 'provider validation failed');
      return reply.code(502).send({ error: 'validation_failed', message: 'provider validation could not complete' });
    }
  });
}

type LazyValidator = (input: ValidateBody) => Promise<unknown>;

let cachedLazy: LazyValidator | null | undefined;

/**
 * Try to load `@kanal/providers` and adapt its `validateProvider` +
 * `FetchTransport` to the endpoint contract. Returns null when the package is
 * not resolvable (not installed / still in flight) or lacks the expected API.
 */
async function lazyValidate(): Promise<LazyValidator | null> {
  if (cachedLazy !== undefined) return cachedLazy;
  try {
    const raw = (await import('@kanal/providers')) as Record<string, unknown>;
    if (typeof raw['validateProvider'] !== 'function' || typeof raw['FetchTransport'] !== 'function') {
      cachedLazy = null;
      return cachedLazy;
    }
    const mod = raw as unknown as ProvidersModule;
    cachedLazy = buildAdapter(mod);
  } catch {
    cachedLazy = null;
  }
  return cachedLazy;
}

interface ProvidersModule {
  validateProvider: (
    cfg: unknown,
    deps: { transport: { request(opts: unknown): Promise<unknown> }; decryptKey: () => string | undefined },
  ) => Promise<unknown>;
  FetchTransport: new (opts?: unknown) => { request(opts: unknown): Promise<unknown> };
}

function buildAdapter(mod: ProvidersModule): LazyValidator {
  return async (input) => {
    const transport = new mod.FetchTransport();
    const authKind = input.authKind === 'custom_header' ? 'custom_header' : input.authKind;
    return mod.validateProvider(
      {
        label: 'validate',
        dialect: 'openai_compatible',
        baseUrl: input.baseUrl,
        authKind,
        customHeaderName: input.authHeader !== undefined ? 'Authorization' : undefined,
        extraHeaders: {},
        timeoutMs: 30_000,
        maxConcurrent: 1,
      },
      {
        transport,
        decryptKey: () => input.authHeader,
      },
    );
  };
}
