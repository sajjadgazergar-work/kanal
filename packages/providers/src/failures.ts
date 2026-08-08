/**
 * Every distinguishable failure mode and what the UI says (plan §11.3).
 *
 * The W1 rule: never show "invalid configuration". Each code maps to a
 * distinct English message and a distinct suggested action.
 */

export const FAILURE_CODES = [
  'dns_nxdomain',
  'dns_timeout',
  'tcp_refused',
  'tcp_timeout',
  'tls_cert_invalid',
  'tls_protocol',
  'http_401',
  'http_403_region',
  'http_403_other',
  'http_404',
  'http_429',
  'http_5xx',
  'body_not_json',
  'body_unexpected_shape',
  'models_empty',
  'probe_no_tool_calling',
  'probe_no_structured_output',
  'probe_context_short',
  'price_unknown',
  'egress_denied',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export interface FailureInfo {
  code: FailureCode;
  /** Exact English UI message (plan §11.3). */
  message: string;
  /** Exact suggested action (plan §11.3). */
  action: string;
}

export const FAILURE_INFO: Record<FailureCode, FailureInfo> = {
  dns_nxdomain: {
    code: 'dns_nxdomain',
    message: 'The host in your base URL does not resolve.',
    action: 'Check the URL; try DNS-over-HTTPS',
  },
  dns_timeout: {
    code: 'dns_timeout',
    message: 'DNS lookup timed out. Your network may be filtering it.',
    action: 'Switch dnsMode to doh',
  },
  tcp_refused: {
    code: 'tcp_refused',
    message: 'The server refused the connection.',
    action: 'Check the port; check the proxy',
  },
  tcp_timeout: {
    code: 'tcp_timeout',
    message: 'Could not reach the server. This is what a blocked route looks like.',
    action: 'Configure a proxy for this provider',
  },
  tls_cert_invalid: {
    code: 'tls_cert_invalid',
    message: "The server's TLS certificate did not verify. This can mean interception.",
    action: 'Do not enable tlsInsecure unless you control the endpoint',
  },
  tls_protocol: {
    code: 'tls_protocol',
    message: 'TLS handshake failed — the endpoint may not be an HTTPS API.',
    action: 'Check scheme and port',
  },
  http_401: {
    code: 'http_401',
    message: 'The API key was rejected.',
    action: 'Re-enter the key',
  },
  http_403_region: {
    code: 'http_403_region',
    message: "This provider refused the request from your network's location.",
    action: 'Use a gateway (OpenRouter, LiteLLM) or a proxy',
  },
  http_403_other: {
    code: 'http_403_other',
    message: 'Access denied by the provider.',
    action: 'Check key scopes and org access',
  },
  http_404: {
    code: 'http_404',
    message:
      'No model list at this path. Your base URL may include or omit /v1 incorrectly.',
    action: 'Show the exact URL tried, and offer the with-and-without-/v1 variant as a one-click fix',
  },
  http_429: {
    code: 'http_429',
    message: 'Rate limited while validating.',
    action: 'Retry with backoff; automatic',
  },
  http_5xx: {
    code: 'http_5xx',
    message: 'Provider returned a server error.',
    action: 'Retry; escalate to circuit breaker after 5',
  },
  body_not_json: {
    code: 'body_not_json',
    message: 'The response was not JSON. A captive portal or filtering proxy usually causes this.',
    action: 'Show the first 200 bytes of the body verbatim',
  },
  body_unexpected_shape: {
    code: 'body_unexpected_shape',
    message: 'This endpoint answered, but not with a model list.',
    action: 'Confirm the dialect',
  },
  models_empty: {
    code: 'models_empty',
    message: 'The provider returned an empty model list.',
    action: 'Check key permissions',
  },
  probe_no_tool_calling: {
    code: 'probe_no_tool_calling',
    message: '{model} did not return a valid tool call.',
    action: 'Mark unsupported; route stages needing it elsewhere',
  },
  probe_no_structured_output: {
    code: 'probe_no_structured_output',
    message: '{model} did not honour the JSON schema.',
    action: 'Mark unsupported; route stages needing it elsewhere',
  },
  probe_context_short: {
    code: 'probe_context_short',
    message:
      '{model} rejected a {n}-token prompt; its usable context is smaller than advertised.',
    action: 'Store the observed ceiling',
  },
  price_unknown: {
    code: 'price_unknown',
    message: 'Cost cannot be computed for {model}.',
    action: 'Enter prices, or accept pricing_confidence: none',
  },
  egress_denied: {
    code: 'egress_denied',
    message: 'Air-gapped mode blocked this request.',
    action: 'Add the host to KANAL_EGRESS_ALLOW',
  },
};

export function failureInfo(code: FailureCode): FailureInfo {
  return FAILURE_INFO[code];
}

/**
 * Render a failure message with §11.3 placeholders substituted.
 * Used so the probe messages carry the concrete model name / token count.
 */
export function formatFailure(code: FailureCode, vars: Record<string, string | number> = {}): string {
  let msg = FAILURE_INFO[code].message;
  for (const [k, v] of Object.entries(vars)) {
    msg = msg.replaceAll(`{${k}}`, String(v));
  }
  return msg;
}

export function isFailureCode(v: string): v is FailureCode {
  return (FAILURE_CODES as readonly string[]).includes(v);
}
