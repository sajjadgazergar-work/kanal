import { type ProviderConfig } from './config.js';
import { type Transport } from './transport.js';
import { type ValidationOutcome } from './validate/index.js';
import { type FailureCode } from './failures.js';
import { type ModelEntry } from './discovery.js';
import { type ProbeId, type ProbeResult, PROBE_CACHE_TTL_MS } from './probe/index.js';
import { type ModelClient } from './client.js';
import { runProbe } from './probe/index.js';
import { discoverModels } from './discoveryRunner.js';

/**
 * Orchestrates the validation state machine (plan §11.2) end-to-end: walks the
 * deterministic transitions, performs discovery per dialect (§11.1) and runs
 * the capability probes (§11.4), collapsing the outcome into
 * healthy | degraded | failure-state.
 */

export interface DiscoveryDeps {
  transport: Transport;
  decryptKey: () => string | undefined;
}

export interface ValidationResult {
  state: 'healthy' | 'degraded' | string;
  code?: FailureCode;
  models: ModelEntry[];
  probes: ProbeResult[];
  transitions: Array<{ state: string; outcome: string }>;
  probedAt: string;
  ttlMs: number;
}

export function modelsUrlFor(cfg: ProviderConfig): string {
  switch (cfg.dialect) {
    case 'anthropic':
      return `${cfg.baseUrl.replace(/\/$/, '')}/v1/models`;
    case 'ollama':
      return `${cfg.baseUrl.replace(/\/$/, '')}/api/tags`;
    default:
      return `${cfg.baseUrl.replace(/\/$/, '')}/v1/models`;
  }
}

/** HTTP status → state-machine outcome (plan §11.2 http → …). */
export function outcomeForStatus(status: number, body: string): ValidationOutcome {
  if (status === 401) return 'unauthorized';
  if (status === 403) {
    const regionMarkers = /\b(country|region|geo|location|territory)\b/;
    return regionMarkers.test(body.slice(0, 2000).toLowerCase()) ? 'forbidden_region' : 'forbidden_other';
  }
  if (status === 404) return 'not_found';
  if (status === 429) return 'throttled';
  if (status >= 500) return 'upstream';
  if (status === 200) return 'success';
  return 'upstream';
}

export interface RunValidationOptions {
  /** Base URL variant to try when the primary 404s (with/without /v1). */
  withV1Fix?: boolean;
}

/**
 * Run the full validation for a provider config. Returns the terminal state
 * ('healthy', 'degraded', or a failure-state string) plus the §11.3 code.
 */
export async function validateProvider(
  cfg: ProviderConfig,
  deps: DiscoveryDeps,
  probeClient?: (model: string) => ModelClient,
  opts: RunValidationOptions = {},
): Promise<ValidationResult> {
  const transitions: Array<{ state: string; outcome: string }> = [];
  const record = (state: string, outcome: string) => transitions.push({ state, outcome });

  // The transport must resolve DNS, connect, TLS and issue GET before a body
  // exists. A thrown error means one of those steps failed; a response means
  // unconfigured → dns → tcp → tls → http all succeeded.
  let transportFailureCode: FailureCode | undefined;
  const discovery = await discoverModels(cfg, deps.transport, deps.decryptKey).catch((e) => {
    transportFailureCode = transportCode(e);
    record(stepForFailure(transportFailureCode), outcomeForTransportCode(transportFailureCode));
    return null;
  });

  if (!discovery) {
    return {
      state: failureStateFor(transportFailureCode),
      code: transportFailureCode,
      models: [],
      probes: [],
      transitions,
      probedAt: new Date().toISOString(),
      ttlMs: PROBE_CACHE_TTL_MS,
    };
  }

  // record the transport progression; all succeeded for any response.
  record('unconfigured', 'success');
  record('dns', 'success');
  record('tcp', 'success');
  record('tls', 'success');

  if (discovery.parseFailed) {
    // 200 but body not JSON (plan §11.3 body_not_json).
    record('http', 'success');
    record('parse', 'not_json');
    return {
      state: 'fail_body',
      code: 'body_not_json',
      models: [],
      probes: [],
      transitions,
      probedAt: new Date().toISOString(),
      ttlMs: PROBE_CACHE_TTL_MS,
    };
  }

  if (!discovery.ok) {
    const status = discovery.status;
    const code = httpFailureCode(status, discovery.errorBody ?? '');
    const outcome = outcomeForStatus(status, discovery.errorBody ?? '');
    record('http', outcome);

    // §11.3 http_404: offer the with-and-without-/v1 variant as a one-click fix.
    if (code === 'http_404' && opts.withV1Fix) {
      const fixed = toggleV1(cfg);
      if (fixed) {
        const retry = await deps.transport.request({
          method: 'GET',
          url: fixed,
          headers: {},
          timeoutMs: cfg.timeoutMs,
        }).catch(() => null);
        if (retry && retry.status === 200) {
          const parsed = safeParse(retry.body);
          const models = parsed === undefined ? [] : parseModelsFor(parsed);
          if (models.length > 0) {
            record('http', 'success');
            return finalizeProbing(cfg, models, transitions, probeClient);
          }
        }
      }
    }

    return {
      state: failureStateForHttp(status),
      code,
      models: [],
      probes: [],
      transitions,
      probedAt: new Date().toISOString(),
      ttlMs: PROBE_CACHE_TTL_MS,
    };
  }

  record('http', 'success');

  // parse: JSON + expected shape.
  const models = discovery.models;
  if (models.length === 0) {
    const shapeOk = discovery.shapeOk ?? false;
    record('parse', shapeOk ? 'empty' : 'unexpected_shape');
    return {
      state: 'fail_empty',
      code: shapeOk ? 'models_empty' : 'body_unexpected_shape',
      models: [],
      probes: [],
      transitions,
      probedAt: new Date().toISOString(),
      ttlMs: PROBE_CACHE_TTL_MS,
    };
  }
  record('parse', 'success');

  return finalizeProbing(cfg, models, transitions, probeClient);
}

async function finalizeProbing(
  cfg: ProviderConfig,
  models: ModelEntry[],
  transitions: Array<{ state: string; outcome: string }>,
  probeClient?: (model: string) => ModelClient,
): Promise<ValidationResult> {
  const probes: ProbeResult[] = [];
  const probeModels = probeClient ? models.slice(0, 1) : [];
  for (const model of probeModels) {
    const client = probeClient!(model.id);
    const probeIds: ProbeId[] = ['liveness', 'tool_calling', 'structured_output', 'context_ceiling'];
    for (const pid of probeIds) {
      probes.push(await runProbe(client, model.id, pid));
    }
  }

  const failed = probes.filter((p) => !p.passed);
  if (probes.length > 0) {
    if (failed.length === probes.length) {
      transitions.push({ state: 'probing', outcome: 'probe_all_fail' });
      return {
        state: 'fail_probe',
        code: failed[0]?.failureCode ?? 'probe_no_tool_calling',
        models,
        probes,
        transitions,
        probedAt: new Date().toISOString(),
        ttlMs: PROBE_CACHE_TTL_MS,
      };
    }
    if (failed.length > 0) {
      transitions.push({ state: 'probing', outcome: 'probe_partial' });
      return {
        state: 'degraded',
        models,
        probes,
        transitions,
        probedAt: new Date().toISOString(),
        ttlMs: PROBE_CACHE_TTL_MS,
      };
    }
  }
  transitions.push({ state: 'probing', outcome: 'probe_pass' });
  transitions.push({ state: 'healthy', outcome: 'success' });
  return {
    state: 'healthy',
    models,
    probes,
    transitions,
    probedAt: new Date().toISOString(),
    ttlMs: PROBE_CACHE_TTL_MS,
  };
}

function safeParse(body: string): unknown | undefined {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function parseModelsFor(parsed: unknown): ModelEntry[] {
  if (parsed === null || typeof parsed !== 'object') return [];
  const b = parsed as Record<string, unknown>;
  const list = Array.isArray(b.data) ? b.data : Array.isArray(b.models) ? b.models : [];
  const out: ModelEntry[] = [];
  for (const row of list) {
    if (row !== null && typeof row === 'object' && typeof (row as Record<string, unknown>).id === 'string') {
      out.push({ id: (row as Record<string, unknown>).id as string });
    }
  }
  return out;
}

function toggleV1(cfg: ProviderConfig): string | undefined {
  const base = cfg.baseUrl.replace(/\/$/, '');
  if (base.endsWith('/v1')) return `${base.slice(0, -3)}/v1/models`;
  return `${base}/v1/v1/models`;
}

function stepForFailure(code: FailureCode | undefined): string {
  switch (code) {
    case 'egress_denied':
    case 'dns_nxdomain':
    case 'dns_timeout':
      return 'dns';
    case 'tcp_refused':
    case 'tcp_timeout':
      return 'tcp';
    case 'tls_cert_invalid':
    case 'tls_protocol':
      return 'tls';
    default:
      return 'tcp';
  }
}

function failureStateFor(code: FailureCode | undefined): string {
  switch (code) {
    case 'egress_denied':
    case 'dns_nxdomain':
    case 'dns_timeout':
      return 'fail_dns';
    case 'tcp_refused':
    case 'tcp_timeout':
      return 'fail_tcp';
    case 'tls_cert_invalid':
    case 'tls_protocol':
      return 'fail_tls';
    default:
      return 'fail_tcp';
  }
}

function failureStateForHttp(status: number): string {
  if (status === 401 || status === 403) return 'fail_auth';
  if (status === 404) return 'fail_path';
  if (status === 429) return 'fail_throttled';
  return 'fail_upstream';
}

function httpFailureCode(status: number, body: string): FailureCode {
  switch (status) {
    case 401:
      return 'http_401';
    case 403:
      return /\b(country|region|geo|location|territory)\b/.test(body.slice(0, 2000).toLowerCase())
        ? 'http_403_region'
        : 'http_403_other';
    case 404:
      return 'http_404';
    case 429:
      return 'http_429';
    default:
      return 'http_5xx';
  }
}

function transportCode(e: unknown): FailureCode | undefined {
  if (e instanceof Error && 'code' in e) {
    const c = (e as { code?: string }).code;
    if (
      c === 'dns_nxdomain' || c === 'dns_timeout' || c === 'tcp_refused' || c === 'tcp_timeout' ||
      c === 'tls_cert_invalid' || c === 'tls_protocol' || c === 'egress_denied'
    ) {
      return c as FailureCode;
    }
  }
  return 'tcp_timeout';
}

function outcomeForTransportCode(code: FailureCode | undefined): ValidationOutcome {
  switch (code) {
    case 'dns_nxdomain': return 'fail';
    case 'dns_timeout': return 'timeout';
    case 'tcp_refused': return 'refused';
    case 'tcp_timeout': return 'timeout';
    case 'tls_cert_invalid': return 'cert_invalid';
    case 'tls_protocol': return 'protocol';
    default: return 'fail';
  }
}
