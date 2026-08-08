import Fastify, { type FastifyInstance } from 'fastify';
import type { Runner } from '@kanal/core';
import type { EventRing } from './streams.js';
import { RingBuffer } from './streams.js';
import { requireApiKey } from './auth.js';
import { TokenBucket, rateLimit } from './rate-limit.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerStreamRoutes } from './routes/streams.js';
import {
  registerWebhookRoutes,
  type WebhookSecretStore,
  type WebhookEventHook,
  type WebhookClock,
} from './routes/webhook.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerProviderRoutes } from './routes/providers.js';

export interface ServerConfig {
  /** The configured `KANAL_API_KEY` (validated non-empty at boot). */
  apiKey: string;
  /** The `Runner` seam — `PgRunner` in production, a fake in tests. */
  runner: Runner;
  /** Per-source webhook secret store. */
  webhookSecrets: WebhookSecretStore;
  /** Liveness probe function (pings Postgres). */
  pingDb: () => Promise<boolean>;
  /** Live event bus; defaults to an in-memory RingBuffer. */
  eventBus?: EventRing;
  /** Optional provider validator; falls back to a dynamic import / 501. */
  providerValidator?: (input: unknown) => Promise<unknown>;
  /** Token bucket options for the webhook + signal routes. */
  webhookRate?: { capacity: number; refillPerSec: number };
  signalRate?: { capacity: number; refillPerSec: number };
  /** Optional hook called after a verified webhook event (tests). */
  onWebhookEvent?: WebhookEventHook;
  /** Override the webhook clock (tests). */
  webhookNow?: WebhookClock;
  /** Set to false to silence pino (used by tests). Defaults to true. */
  logger?: boolean;
}

/**
 * Build a configured Fastify instance. Exported separately from index.ts so
 * tests can `buildServer()` without touching the network.
 */
export function buildServer(config: ServerConfig): FastifyInstance {
  const app = Fastify({
    logger: config.logger === false ? false : { level: process.env.KANAL_LOG_LEVEL ?? 'info' },
    trustProxy: true,
    bodyLimit: 1_048_576, // 1 MB
  });

  const eventBus = config.eventBus ?? new RingBuffer();
  const webhookBucket = new TokenBucket(config.webhookRate ?? { capacity: 120, refillPerSec: 2 });
  const signalBucket = new TokenBucket(config.signalRate ?? { capacity: 60, refillPerSec: 1 });

  const auth = requireApiKey(config.apiKey);

  // ---- middleware ------------------------------------------------------
  app.addHook('onRequest', auth);

  // ---- routes ----------------------------------------------------------
  app.register(
    async (v1) => {
      await registerHealthRoutes(v1, { ping: config.pingDb });
      await registerRunRoutes(v1, { runner: config.runner });
      await registerStreamRoutes(v1, { bus: eventBus });
      await registerWebhookRoutes(v1, {
        secrets: config.webhookSecrets,
        onVerifiedEvent: config.onWebhookEvent,
        now: config.webhookNow,
      });
      await registerProviderRoutes(v1, {
        validate: config.providerValidator as ((input: { baseUrl: string; authKind: string; authHeader?: string }) => Promise<unknown>) | undefined,
      });

      // Rate limit the sensitive write routes.
      v1.addHook('preHandler', async (request, reply) => {
        const route = request.routeOptions.url;
        if (route !== undefined && (route.endsWith('/signal') || route.endsWith('/webhook'))) {
          const bucket = route.endsWith('/webhook') ? webhookBucket : signalBucket;
          await rateLimit(bucket, route.endsWith('/webhook') ? 'webhook' : 'signal')(request, reply);
        }
      });
    },
    { prefix: '/api/v1' },
  );

  // ---- error handling ---------------------------------------------------
  app.setErrorHandler((err, request, reply) => {
    const message = err instanceof Error ? err.message : 'unknown error';
    let status = 500;
    if (err instanceof Error) {
      const maybe = (err as { statusCode?: unknown }).statusCode;
      if (typeof maybe === 'number' && maybe >= 400) status = maybe;
    }
    request.log.error({ err }, 'unhandled error');
    void reply.code(status).send({ error: 'internal', message });
  });

  return app;
}
