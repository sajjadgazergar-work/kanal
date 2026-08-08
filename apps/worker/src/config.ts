/**
 * Worker configuration (plan §12.7). `KANAL_WORKER_ROLES` selects which roles
 * this process runs — `all` (small-install default) or a comma-separated subset
 * of pipeline,ingest,publish,metrics.
 */

export type WorkerRole = 'pipeline' | 'ingest' | 'publish' | 'metrics';

export interface WorkerConfig {
  roles: WorkerRole[];
  /** pipeline: concurrent runs (default 4). */
  pipelineConcurrency: number;
  /** ingest: concurrent fetches (default 8). */
  ingestConcurrency: number;
  /** publish: 1 per channel (singleton-locked). */
  publishConcurrency: number;
  /** metrics: concurrent snapshots (default 4). */
  metricsConcurrency: number;
  /** polling interval for the job queues, ms. */
  pollIntervalMs: number;
  /** approval sweep interval, ms. */
  sweepIntervalMs: number;
  /** heartbeat reclaimer interval, ms. */
  reclaimIntervalMs: number;
  /** workers with `KANAL_PUBLISH=off` (default) refuse to start the publisher. */
  publishEnabled: boolean;
}

const VALID_ROLES: WorkerRole[] = ['pipeline', 'ingest', 'publish', 'metrics'];

function parseRoles(raw: string | undefined): WorkerRole[] {
  const value = (raw ?? 'all').trim().toLowerCase();
  if (value === 'all') return ['pipeline', 'ingest', 'publish', 'metrics'];
  const roles = value.split(',').map((r) => r.trim()).filter(Boolean) as WorkerRole[];
  for (const r of roles) {
    if (!VALID_ROLES.includes(r)) {
      throw new Error(`KANAL_WORKER_ROLES contains unknown role "${r}" (valid: pipeline,ingest,publish,metrics or all)`);
    }
  }
  if (roles.length === 0) throw new Error('KANAL_WORKER_ROLES is empty — refusing to run a worker with no roles');
  return roles;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return Math.floor(n);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const publishEnabled = (env.KANAL_PUBLISH ?? 'off').trim().toLowerCase() !== 'off';
  const config: WorkerConfig = {
    roles: parseRoles(env.KANAL_WORKER_ROLES),
    pipelineConcurrency: intFromEnv(env, 'KANAL_PIPELINE_CONCURRENCY', 4),
    ingestConcurrency: intFromEnv(env, 'KANAL_INGEST_CONCURRENCY', 8),
    publishConcurrency: 1,
    metricsConcurrency: intFromEnv(env, 'KANAL_METRICS_CONCURRENCY', 4),
    pollIntervalMs: intFromEnv(env, 'KANAL_POLL_INTERVAL_MS', 2000),
    sweepIntervalMs: intFromEnv(env, 'KANAL_SWEEP_INTERVAL_MS', 60_000),
    reclaimIntervalMs: intFromEnv(env, 'KANAL_RECLAIM_INTERVAL_MS', 30_000),
    publishEnabled,
  };
  // A worker told to run `publish` without KANAL_PUBLISH=on must not start.
  if (config.roles.includes('publish') && !config.publishEnabled) {
    throw new Error('KANAL_PUBLISH=off (default) but KANAL_WORKER_ROLES includes publish — set KANAL_PUBLISH=on to run the publisher');
  }
  return config;
}

/** Stable worker id used for `locked_by` on job dequeue. */
export function workerId(): string {
  const host = process.env.HOSTNAME ?? 'worker';
  return `${host}:${process.pid}`;
}
