import type { FastifyInstance } from 'fastify';

/**
 * Liveness probe (plan §12.7 "api" process, compose healthcheck):
 *
 *   GET /api/v1/healthz
 *
 * Pings Postgres; returns 200 when the pool responds, 503 otherwise.
 */

export interface HealthRoutesOptions {
  /** Returns true when Postgres answers a trivial query. */
  ping: () => Promise<boolean>;
}

export async function registerHealthRoutes(app: FastifyInstance, opts: HealthRoutesOptions): Promise<void> {
  const { ping } = opts;

  app.get('/healthz', async (_request, reply) => {
    try {
      const ok = await ping();
      if (!ok) {
        return reply.code(503).send({ status: 'unhealthy' });
      }
      return reply.send({ status: 'ok' });
    } catch {
      return reply.code(503).send({ status: 'unhealthy' });
    }
  });
}
