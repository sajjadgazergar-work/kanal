import { type ModelTier } from '@kanal/contracts';
import { type ProviderConfig } from './config.js';
import { type FailureCode } from './failures.js';
import { classify } from './classify.js';
import { type CircuitBreaker } from './circuit.js';
import { type Semaphore } from './semaphore.js';
import { type ModelClient } from './client.js';
import { type CompletionRequest, type CompletionResult } from './client.js';
import { type EgressState } from './egress.js';

/**
 * Routing and fallback (plan §11.6): walk the ranked `tier_binding` list; skip
 * open circuits, models that do not satisfy the request's hard requirements,
 * and egress-denied providers; call with a per-provider timeout; on failure
 * record the circuit failure and continue to the next binding. When every
 * binding fails, throw NoRouteAvailable.
 */

export interface RequestRequirements {
  /** structuredOutput: 'required' means the model must have it probed. */
  structuredOutput?: 'required' | 'preferred' | 'none';
  minContextTokens?: number;
}

export interface Binding {
  tier: ModelTier;
  rank: number;
  providerId: string;
  modelRef: string;
}

export interface ProviderHandle {
  id: string;
  cfg: ProviderConfig;
  circuit: CircuitBreaker;
  semaphore: Semaphore;
  egressDenied: boolean;
  client: ModelClient;
  /** Satisfy the manifest's hard requirements with the model's probed caps. */
  satisfies(modelRef: string, req: RequestRequirements): boolean;
  call(req: CompletionRequest): Promise<CompletionResult>;
}

export interface RouterContext {
  providers: Record<string, ProviderHandle>;
  tierBindings(tier: ModelTier): Binding[];
  egress: EgressState;
}

export class NoRouteAvailableError extends Error {
  readonly tier: ModelTier;
  readonly diagnostics: unknown;
  constructor(tier: ModelTier, diagnostics: unknown) {
    super(`No route available for tier ${tier}`);
    this.name = 'NoRouteAvailable';
    this.tier = tier;
    this.diagnostics = diagnostics;
  }
}

export function isNoRouteAvailable(e: unknown): e is NoRouteAvailableError {
  return e instanceof NoRouteAvailableError;
}

export interface RouteCall {
  request: CompletionRequest;
  /** Hard requirements the chosen model must satisfy (plan §11.5). */
  requirements?: RequestRequirements;
  /** Per-request retry budget for retryable failures (plan §11.6: attempt < 2). */
  retries?: number;
}

export interface RouteOutcome {
  result: CompletionResult;
  providerId: string;
  modelRef: string;
  fallbackUsed: boolean;
  attempt: number;
}

export async function route(
  tier: ModelTier,
  req: RouteCall,
  ctx: RouterContext,
): Promise<RouteOutcome> {
  const bindings = ctx.tierBindings(tier).slice().sort((a, b) => a.rank - b.rank);
  if (bindings.length === 0) {
    throw new NoRouteAvailableError(tier, { reason: 'no_tier_bindings' });
  }
  const maxRetries = req.retries ?? 2;
  const diagnostics: Array<Record<string, unknown>> = [];

  for (const binding of bindings) {
    const p = ctx.providers[binding.providerId];
    if (!p) {
      diagnostics.push({ providerId: binding.providerId, skipped: 'missing_provider' });
      continue;
    }
    if (p.circuit.isOpen()) {
      diagnostics.push({ providerId: binding.providerId, modelRef: binding.modelRef, skipped: 'circuit_open' });
      continue;
    }
    if (p.egressDenied) {
      diagnostics.push({ providerId: binding.providerId, modelRef: binding.modelRef, skipped: 'egress_denied' });
      continue;
    }
    if (req.requirements && !p.satisfies(binding.modelRef, req.requirements)) {
      diagnostics.push({ providerId: binding.providerId, modelRef: binding.modelRef, skipped: 'unsatisfied_requirements' });
      continue;
    }

    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        const result = await p.call({ ...req.request, model: binding.modelRef });
        p.circuit.recordSuccess();
        return {
          result,
          providerId: binding.providerId,
          modelRef: binding.modelRef,
          fallbackUsed: bindings[0]?.providerId !== binding.providerId,
          attempt,
        };
      } catch (e) {
        p.circuit.recordFailure();
        const code = failureCodeOf(e);
        diagnostics.push({ providerId: binding.providerId, modelRef: binding.modelRef, code, attempt });
        const cls = code ? classify(code) : 'retryable';
        if (cls === 'permanent') {
          // 400/401/404: next binding, no retry.
          break;
        }
        if (cls === 'blocked') {
          p.egressDenied = true;
          break;
        }
        // retryable: 429/5xx/timeout
        if (attempt < maxRetries) {
          attempt++;
          await backoff(attempt);
          continue;
        }
        break;
      }
    }
  }
  throw new NoRouteAvailableError(tier, diagnostics);
}

function failureCodeOf(e: unknown): FailureCode | undefined {
  if (e instanceof Error && 'code' in e) {
    const c = (e as { code?: string }).code;
    if (c && (c as string).startsWith('http_')) return c as FailureCode;
    if (c === 'egress_denied') return 'egress_denied';
    if (c === 'dns_nxdomain' || c === 'dns_timeout') return c;
    if (c === 'tcp_refused' || c === 'tcp_timeout') return c;
    if (c === 'tls_cert_invalid' || c === 'tls_protocol') return c;
  }
  return undefined;
}

export async function backoff(attempt: number): Promise<void> {
  // Exponential with jitter, capped (plan §11.9: exponential backoff with jitter, max 3).
  const base = Math.min(3, attempt);
  const delayMs = Math.pow(2, base) * 250 + Math.random() * 250;
  await new Promise((r) => setTimeout(r, delayMs));
}
