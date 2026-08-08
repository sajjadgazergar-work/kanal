import { type FailureCode } from '../failures.js';

/**
 * Provider validation state machine (plan §11.2).
 *
 *   unconfigured → dns → tcp → tls → http → parse → probing → healthy | degraded
 *
 * Every failure leaves the machine in a distinct dead state carrying the §11.3
 * failure code. Deterministic transitions only — the machine never jumps, it
 * only moves one state forward on success or into a failure state.
 */

export type ValidationState =
  | 'unconfigured'
  | 'dns'
  | 'tcp'
  | 'tls'
  | 'http'
  | 'parse'
  | 'probing'
  | 'healthy'
  | 'degraded';

export const VALIDATION_SEQUENCE: readonly ValidationState[] = [
  'unconfigured',
  'dns',
  'tcp',
  'tls',
  'http',
  'parse',
  'probing',
  'healthy',
  'degraded',
];

/** Failure states per §11.2: fail_dns, fail_tcp, fail_tls, fail_auth, fail_path,
 * fail_throttled, fail_upstream, fail_body, fail_empty, fail_probe. */
export type FailureState =
  | 'fail_dns'
  | 'fail_tcp'
  | 'fail_tls'
  | 'fail_auth'
  | 'fail_path'
  | 'fail_throttled'
  | 'fail_upstream'
  | 'fail_body'
  | 'fail_empty'
  | 'fail_probe';

/** Mapping from failure state → the single §11.3 code the UI renders. */
export const FAILURE_STATE_CODE: Record<FailureState, FailureCode> = {
  fail_dns: 'dns_nxdomain', // dns_timeout is set via code override when the resolver reports a timeout
  fail_tcp: 'tcp_refused', // tcp_timeout set via override
  fail_tls: 'tls_cert_invalid', // tls_protocol set via override
  fail_auth: 'http_401', // http_403_region / http_403_other set via override
  fail_path: 'http_404',
  fail_throttled: 'http_429',
  fail_upstream: 'http_5xx',
  fail_body: 'body_not_json', // body_unexpected_shape set via override
  fail_empty: 'models_empty',
  fail_probe: 'probe_no_tool_calling',
};

export interface TransitionResult {
  /** The state the machine is in now (success or failure). */
  state: ValidationState | FailureState;
  /** §11.3 failure code when `state` is a failure state. */
  code?: FailureCode;
}

function toFailure(state: FailureState, code?: FailureCode): TransitionResult {
  return { state, code: code ?? FAILURE_STATE_CODE[state] };
}

/**
 * The deterministic transition table. `probeResult` (with
 * `toolCallingPassed`, `structuredOutputPassed`, `contextPassed`) decides
 * healthy vs degraded at the `probing` step (§11.4 drift rule: any single
 * failed probe = degraded, all failed = fail_probe).
 */
export function transition(
  current: ValidationState,
  outcome: 'success' | 'fail' | 'timeout' | 'refused' | 'cert_invalid' | 'protocol' | 'not_json' | 'unexpected_shape' | 'empty' | 'unauthorized' | 'forbidden_region' | 'forbidden_other' | 'not_found' | 'throttled' | 'upstream' | 'probe_partial' | 'probe_all_fail' | 'probe_pass',
): TransitionResult {
  switch (current) {
    case 'unconfigured':
      return outcome === 'success' ? { state: 'dns' } : toFailure('fail_dns');
    case 'dns':
      if (outcome === 'success') return { state: 'tcp' };
      if (outcome === 'timeout') return toFailure('fail_dns', 'dns_timeout');
      return toFailure('fail_dns');
    case 'tcp':
      if (outcome === 'success') return { state: 'tls' };
      if (outcome === 'timeout') return toFailure('fail_tcp', 'tcp_timeout');
      if (outcome === 'refused') return toFailure('fail_tcp');
      return toFailure('fail_tcp');
    case 'tls':
      if (outcome === 'success') return { state: 'http' };
      if (outcome === 'protocol') return toFailure('fail_tls', 'tls_protocol');
      if (outcome === 'cert_invalid') return toFailure('fail_tls');
      return toFailure('fail_tls');
    case 'http':
      if (outcome === 'success') return { state: 'parse' };
      if (outcome === 'unauthorized') return toFailure('fail_auth', 'http_401');
      if (outcome === 'forbidden_region') return toFailure('fail_auth', 'http_403_region');
      if (outcome === 'forbidden_other') return toFailure('fail_auth', 'http_403_other');
      if (outcome === 'not_found') return toFailure('fail_path', 'http_404');
      if (outcome === 'throttled') return toFailure('fail_throttled', 'http_429');
      if (outcome === 'upstream') return toFailure('fail_upstream', 'http_5xx');
      return toFailure('fail_upstream');
    case 'parse':
      if (outcome === 'success') return { state: 'probing' };
      if (outcome === 'unexpected_shape') return toFailure('fail_body', 'body_unexpected_shape');
      if (outcome === 'empty') return toFailure('fail_empty', 'models_empty');
      return toFailure('fail_body');
    case 'probing':
      if (outcome === 'probe_pass') return { state: 'healthy' };
      if (outcome === 'probe_partial') return { state: 'degraded' };
      return toFailure('fail_probe');
    case 'healthy':
      return outcome === 'success' ? { state: 'healthy' } : { state: 'degraded' };
    case 'degraded':
      return outcome === 'success' ? { state: 'healthy' } : { state: 'degraded' };
    default:
      // Unreachable: unconfigured handled above; failure states are terminal.
      return toFailure('fail_probe');
  }
}

export type ValidationOutcome = Parameters<typeof transition>[1];
