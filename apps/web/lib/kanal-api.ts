/**
 * Server-side KANAL API client. Route handlers and server components call the
 * Fastify API with the configured `KANAL_API_KEY`; the browser never sees it.
 *
 * Base URL resolution (plan §16.3 — the API binds 127.0.0.1 by default):
 *   1. `KANAL_API_URL` (e.g. http://127.0.0.1:3001) when set,
 *   2. `KANAL_HOST`/`KANAL_PORT` — the same env the API uses,
 *   3. `http://127.0.0.1:3001` — the compose default.
 */

import { cache } from 'react';

export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
}

export function apiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const host = env.KANAL_HOST ?? '127.0.0.1';
  const port = env.KANAL_PORT ?? '3001';
  const baseUrl = (env.KANAL_API_URL ?? `http://${host}:${port}`).replace(/\/$/, '');
  const apiKey = env.KANAL_API_KEY;
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new Error('KANAL_API_KEY is required to talk to the KANAL API — set it in the web env');
  }
  return { baseUrl, apiKey };
}

export class KanalApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KanalApiError';
  }
}

async function request<T>(cfg: ApiConfig, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${cfg.baseUrl}/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    let body: { error?: string; message?: string } | null = null;
    try {
      body = (await res.json()) as { error?: string; message?: string };
    } catch {
      // non-JSON error body
    }
    throw new KanalApiError(res.status, body?.error ?? 'api_error', body?.message ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** POST /runs — start a new pipeline run (plan §12.2). */
export interface StartRunBody {
  orgId: string;
  channelId: string;
  lane: 'auto' | 'copilot' | 'manual';
  brief: Record<string, unknown>;
  manifestSetHash: string;
  promptPackVersion: string;
  budgetCapUsd: number;
}

export function startRun(cfg: ApiConfig, body: StartRunBody): Promise<{ runId: string }> {
  return request(cfg, '/runs', { method: 'POST', body: JSON.stringify(body) });
}

/** GET /runs/:id — run snapshot (plan §12.2). */
export type RunSnapshot = {
  runId: string;
  orgId: string;
  state: string;
  cursorStage: string;
  lane: 'auto' | 'copilot' | 'manual';
  spentUsd: number;
  budgetCapUsd: number;
  cancelRequested: boolean;
  steps: Array<{ stage: string; attempt: number; state: string }>;
};

export function getRun(cfg: ApiConfig, runId: string): Promise<RunSnapshot> {
  return request(cfg, `/runs/${encodeURIComponent(runId)}`);
}

export type RunSignal =
  | { kind: 'approval'; gate: string; decision: 'granted' | 'denied'; decidedBy: string; note?: string }
  | { kind: 'lane_change'; lane: 'auto' | 'copilot' | 'manual' }
  | { kind: 'cancel' }
  | { kind: 'resume' };

export function signalRun(cfg: ApiConfig, runId: string, sig: RunSignal): Promise<{ ok: boolean }> {
  return request(cfg, `/runs/${encodeURIComponent(runId)}/signal`, {
    method: 'POST',
    body: JSON.stringify(sig),
  });
}

/** POST /providers/validate — provider discovery + probe (plan §11.2). */
export interface ValidateProviderBody {
  baseUrl: string;
  authKind: 'bearer' | 'x_api_key' | 'none' | 'custom_header';
  authHeader?: string;
}

export function validateProvider(cfg: ApiConfig, body: ValidateProviderBody): Promise<unknown> {
  return request(cfg, '/providers/validate', { method: 'POST', body: JSON.stringify(body) });
}

/** GET /healthz — liveness probe. */
export function healthz(cfg: ApiConfig): Promise<{ status: string }> {
  return request(cfg, '/healthz');
}

/** React cache so one request per render pass is shared across RSC calls. */
export const getApiConfig = cache(() => apiConfig());
