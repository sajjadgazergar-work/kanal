import { Pool } from 'pg';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgRunner, reclaimStaleSteps, runApprovalSweep } from '@kanal/core';
import { loadConfig, workerId, type WorkerConfig } from './config.js';
import { createDb, databaseUrlFromEnv } from './db.js';
import { createQueuePoller, type QueuePoller } from './queue.js';
import { createPipelineHandler, type ProviderClient } from './pipeline.js';
import { createIngestHandler } from './ingest.js';
import { createPublishHandler } from './publish.js';
import { createMetricsHandler } from './metrics.js';
import { loadProviderConfig, loadPrices, createProviderClient } from './provider.js';

/**
 * Worker bootstrap (plan §12.7). One process runs any subset of the four roles
 * — `KANAL_WORKER_ROLES` selects (default `all`). Roles share one Postgres
 * pool; the pipeline additionally needs a healthy provider + the price table.
 *
 *   pipeline  → one poller on the `pipeline` queue, executes stages via the
 *               budget-guarded runtime (Runner.advance) (§12.2, §12.7)
 *   ingest    → one poller on the `ingest` queue, fetches sources (§12.7)
 *   publish   → one poller on the `publish` queue, singleton-locked (§10.5)
 *   metrics   → one poller on the `metrics` queue, cron snapshots (§17.2)
 *
 * Two housekeeping timers run regardless of role selection: the approval sweep
 * (60s) and the heartbeat reclaimer (30s). They are cheap and idempotent; a
 * multi-worker install may run several, and the SELECTs are safe to duplicate
 * (plan §12.4, §5.4).
 */

interface WorkerRuntime {
  db: NodePgDatabase;
  pool: Pool;
  pollers: QueuePoller[];
  stop(): Promise<void>;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(
    `[worker] boot roles=${cfg.roles.join(',')} worker=${workerId()} publish=${cfg.publishEnabled ? 'on' : 'off'}`,
  );

  const { db, pool } = createDb(databaseUrlFromEnv(), poolSizeFor(cfg));
  const runner = new PgRunner(db);

  const pollers: QueuePoller[] = [];

  // ---- pipeline -----------------------------------------------------------
  // The provider is load-bearing only for model stages; a missing provider is
  // not fatal at boot (the source of truth is the `provider` table, plan §11).
  // Stages that need the model fail with a clear error inside the handler, and
  // the first healthy provider is re-dialed by the API when it is configured.
  if (cfg.roles.includes('pipeline')) {
    const providerCfg = await loadProviderConfig(db);
    const prices = await loadPrices(db);
    const provider = providerCfg
      ? createProviderClient(providerCfg, prices)
      : null;

    if (!provider) {
      console.warn(
        '[worker] pipeline role enabled but no provider row configured — model stages will fail until one is added',
      );
    }

    const advance = (runId: string, event: string) => runner.advance(runId, event);
    // A dummy client so the pipeline wires even with no provider; guardedCall
    // still enforces the budget before any call, and the model call itself
    // fails fast with a clear message.
    const fallback: ProviderClient = {
      async chat() {
        throw new Error('no provider configured — add a provider row to continue');
      },
      priceOf() {
        return null;
      },
    };

    const handle = createPipelineHandler(db, advance, provider ?? fallback);
    pollers.push(
      createQueuePoller(db, 'pipeline', workerId(), cfg.pipelineConcurrency, cfg.pollIntervalMs, (job) =>
        handle(job.payload as { runId: string; state?: string; stage?: string; attempt?: number }),
      ),
    );
    console.log(`[worker] pipeline poller up (concurrency ${cfg.pipelineConcurrency})`);
  }

  // ---- ingest -------------------------------------------------------------
  if (cfg.roles.includes('ingest')) {
    const handle = createIngestHandler(db);
    pollers.push(
      createQueuePoller(db, 'ingest', workerId(), cfg.ingestConcurrency, cfg.pollIntervalMs, (job) =>
        handle(job.payload as { sourceId: string }),
      ),
    );
    console.log(`[worker] ingest poller up (concurrency ${cfg.ingestConcurrency})`);
  }

  // ---- publish ------------------------------------------------------------
  // The publisher refuses to start when KANAL_PUBLISH=off (config.ts). The
  // poller claims 1 job at a time — publish is singleton-locked per channel by
  // the unique idempotency key (plan §10.5).
  if (cfg.roles.includes('publish')) {
    const handle = createPublishHandler(db);
    pollers.push(
      createQueuePoller(db, 'publish', workerId(), cfg.publishConcurrency, cfg.pollIntervalMs, (job) =>
        handle(job.payload as { runId: string; attempt?: number }),
      ),
    );
    console.log('[worker] publish poller up (singleton-locked)');
  }

  // ---- metrics ------------------------------------------------------------
  if (cfg.roles.includes('metrics')) {
    const handle = createMetricsHandler(db);
    pollers.push(
      createQueuePoller(db, 'metrics', workerId(), cfg.metricsConcurrency, cfg.pollIntervalMs, (job) =>
        handle(job.payload as { publishAttemptId: string }),
      ),
    );
    console.log(`[worker] metrics poller up (concurrency ${cfg.metricsConcurrency})`);
  }

  if (pollers.length === 0) {
    // config.ts already rejects an empty role list; this is a belt-and-braces
    // guard in case a future role name stops mapping to a poller.
    throw new Error('no role pollers started — refusing to run an idle worker');
  }
  for (const poller of pollers) poller.start();

  // ---- housekeeping timers ------------------------------------------------
  // Approval sweep (plan §12.4): resume granted-but-parked runs, escalate SLA
  // overruns, expire hard deadlines. Runs on every worker; the updates are
  // idempotent and races are harmless (SELECTs + targeted UPDATEs).
  void sweepOnInterval(cfg.sweepIntervalMs, 'approval-sweep', async () => {
    const r = await runApprovalSweep(db);
    if (r.resumed + r.escalated + r.expired > 0) {
      console.log(`[worker] approval sweep: resumed=${r.resumed} escalated=${r.escalated} expired=${r.expired}`);
    }
  });

  // Heartbeat reclaimer (plan §5.4): re-enqueue in_flight steps whose
  // heartbeat is stale. Memoized outputs make re-runs free.
  void sweepOnInterval(cfg.reclaimIntervalMs, 'step-reclaim', async () => {
    const n = await reclaimStaleSteps(db);
    if (n > 0) console.log(`[worker] reclaimed ${n} stale step(s)`);
  });

  // ---- shutdown -----------------------------------------------------------
  const runtime: WorkerRuntime = { db, pool, pollers, stop: () => shutdown(runtime) };
  registerShutdownHandlers(runtime);
}

async function shutdown(runtime: WorkerRuntime): Promise<void> {
  console.log('[worker] shutting down');
  await Promise.all(runtime.pollers.map((p) => p.stop()));
  await runtime.pool.end();
}

function registerShutdownHandlers(runtime: WorkerRuntime): void {
  const onSignal = (signal: string): void => {
    console.log(`[worker] received ${signal}`);
    void runtime.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('uncaughtException', (err) => {
    console.error('[worker] uncaught exception', err);
    void runtime.stop().then(() => process.exit(1));
  });
}

/** Run `fn` immediately, then on an interval. Errors never kill the worker. */
async function sweepOnInterval(
  intervalMs: number,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  const tick = async (): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      console.error(`[worker] ${label} failed`, err);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
}

/** The pool size mirrors the role mix: pipeline+ingest are the concurrent ones. */
function poolSizeFor(cfg: WorkerConfig): number {
  let size = 2;
  if (cfg.roles.includes('pipeline')) size += cfg.pipelineConcurrency;
  if (cfg.roles.includes('ingest')) size += cfg.ingestConcurrency;
  if (cfg.roles.includes('publish')) size += 2;
  if (cfg.roles.includes('metrics')) size += cfg.metricsConcurrency;
  return size;
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
