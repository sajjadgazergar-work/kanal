import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Runner, StartRunInput } from '@kanal/core';

/**
 * Run lifecycle routes (plan §12.2, §12.4, §14.2):
 *
 *   POST /api/v1/runs                → PgRunner.start
 *   GET  /api/v1/runs/:id            → PgRunner.describe
 *   POST /api/v1/runs/:id/signal     → PgRunner.signal (approval / lane change / cancel / resume)
 *
 * The runner is injected (the `Runner` seam), so tests can use a fake.
 */

// ---- request/response schemas (zod) -------------------------------------

const laneSchema = z.enum(['auto', 'copilot', 'manual']);
const gateKindSchema = z.enum(['topic', 'draft', 'publish', 'policy_override', 'budget_raise', 'source_trust']);

const startRunSchema = z.object({
  orgId: z.string().min(1),
  channelId: z.string().min(1),
  lane: laneSchema,
  brief: z.record(z.unknown()).default({}),
  manifestSetHash: z.string().min(1),
  promptPackVersion: z.string().min(1),
  budgetCapUsd: z.number().nonnegative().default(0.15),
});
export type StartRunBody = z.infer<typeof startRunSchema>;

const signalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('approval'),
    gate: gateKindSchema,
    decision: z.enum(['granted', 'denied']),
    decidedBy: z.string().min(1),
    note: z.string().optional(),
  }),
  z.object({ kind: z.literal('lane_change'), lane: laneSchema }),
  z.object({ kind: z.literal('cancel') }),
  z.object({ kind: z.literal('resume') }),
]);
export type SignalBody = z.infer<typeof signalSchema>;

/** Extract a run id param, replying 400 on malformed input. */
function runIdParam(request: FastifyRequest, reply: FastifyReply): string | null {
  const id = (request.params as Record<string, string>).id;
  if (typeof id !== 'string' || id.length === 0) {
    void reply.code(400).send({ error: 'invalid_id', message: 'run id is required' });
    return null;
  }
  return id;
}

export interface RunRoutesOptions {
  runner: Runner;
}

export async function registerRunRoutes(app: FastifyInstance, opts: RunRoutesOptions): Promise<void> {
  const { runner } = opts;

  app.post<{ Body: unknown }>('/runs', async (request, reply) => {
    const body = startRunSchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_body', message: body.error.issues[0]?.message ?? 'invalid body' });
    }
    const input: StartRunInput = {
      orgId: body.data.orgId,
      channelId: body.data.channelId,
      lane: body.data.lane,
      brief: body.data.brief,
      manifestSetHash: body.data.manifestSetHash,
      promptPackVersion: body.data.promptPackVersion,
      budgetCapUsd: body.data.budgetCapUsd,
    };
    try {
      const handle = await runner.start(input);
      return reply.code(201).send({ runId: handle.runId });
    } catch (err) {
      request.log.error({ err }, 'runner.start failed');
      return reply.code(500).send({ error: 'internal', message: 'failed to start run' });
    }
  });

  app.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
    const id = runIdParam(request, reply);
    if (id === null) return reply;
    try {
      const snapshot = await runner.describe(id);
      if (!snapshot || !snapshot.runId) {
        return reply.code(404).send({ error: 'run_not_found', message: 'no such run' });
      }
      return reply.send(snapshot);
    } catch (err) {
      // PgRunner.describe throws when the run row does not exist; a fake may too.
      request.log.debug({ err }, 'runner.describe failed');
      return reply.code(404).send({ error: 'run_not_found', message: 'no such run' });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/runs/:id/signal', async (request, reply) => {
    const id = runIdParam(request, reply);
    if (id === null) return reply;
    const body = signalSchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_body', message: body.error.issues[0]?.message ?? 'invalid body' });
    }
    try {
      await runner.signal(id, body.data);
      return reply.code(202).send({ ok: true });
    } catch (err) {
      request.log.debug({ err, runId: id }, 'runner.signal failed');
      return reply.code(409).send({ error: 'invalid_transition', message: 'signal not accepted for this run' });
    }
  });
}
