import { type FailureCode } from './failures.js';

/** How a failure code behaves inside routing (plan §11.6). */
export type FailureClass =
  /** 400/401/404 class: permanent, never retried, move to next binding. */
  | 'permanent'
  /** Transient (429/5xx/timeout/dns): retried with backoff, then next binding. */
  | 'retryable'
  /** Egress/SSRF block: permanently skipped for this request. */
  | 'blocked';

/** Failure codes that are permanent per §11.6 (`isPermanent`). */
const PERMANENT: ReadonlySet<string> = new Set([
  'http_401',
  'http_403_region',
  'http_403_other',
  'http_404',
  'body_not_json',
  'body_unexpected_shape',
  'models_empty',
  'price_unknown',
]);

/** Failure codes that indicate an egress/security block, not a provider problem. */
const BLOCKED: ReadonlySet<string> = new Set(['egress_denied']);

export function classify(code: FailureCode): FailureClass {
  if (PERMANENT.has(code)) return 'permanent';
  if (BLOCKED.has(code)) return 'blocked';
  return 'retryable';
}
