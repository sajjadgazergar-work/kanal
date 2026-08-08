import { describe, expect, it } from 'vitest';
import {
  FAILURE_CODES,
  FAILURE_INFO,
  failureInfo,
  formatFailure,
  isFailureCode,
} from '../failures.js';
import { classify } from '../classify.js';

describe('§11.3 failure codes', () => {
  it('exports all 20 failure codes', () => {
    expect(FAILURE_CODES).toHaveLength(20);
    expect(FAILURE_CODES).toEqual(expect.arrayContaining([
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
    ]));
  });

  it('each code has the exact §11.3 UI message and action', () => {
    const expected: Record<string, { message: string; action: string }> = {
      dns_nxdomain: {
        message: 'The host in your base URL does not resolve.',
        action: 'Check the URL; try DNS-over-HTTPS',
      },
      dns_timeout: {
        message: 'DNS lookup timed out. Your network may be filtering it.',
        action: 'Switch dnsMode to doh',
      },
      tcp_refused: {
        message: 'The server refused the connection.',
        action: 'Check the port; check the proxy',
      },
      tcp_timeout: {
        message: 'Could not reach the server. This is what a blocked route looks like.',
        action: 'Configure a proxy for this provider',
      },
      tls_cert_invalid: {
        message: "The server's TLS certificate did not verify. This can mean interception.",
        action: 'Do not enable tlsInsecure unless you control the endpoint',
      },
      tls_protocol: {
        message: 'TLS handshake failed — the endpoint may not be an HTTPS API.',
        action: 'Check scheme and port',
      },
      http_401: {
        message: 'The API key was rejected.',
        action: 'Re-enter the key',
      },
      http_403_region: {
        message: "This provider refused the request from your network's location.",
        action: 'Use a gateway (OpenRouter, LiteLLM) or a proxy',
      },
      http_403_other: {
        message: 'Access denied by the provider.',
        action: 'Check key scopes and org access',
      },
      http_404: {
        message: 'No model list at this path. Your base URL may include or omit /v1 incorrectly.',
        action: 'Show the exact URL tried, and offer the with-and-without-/v1 variant as a one-click fix',
      },
      http_429: {
        message: 'Rate limited while validating.',
        action: 'Retry with backoff; automatic',
      },
      http_5xx: {
        message: 'Provider returned a server error.',
        action: 'Retry; escalate to circuit breaker after 5',
      },
      body_not_json: {
        message: 'The response was not JSON. A captive portal or filtering proxy usually causes this.',
        action: 'Show the first 200 bytes of the body verbatim',
      },
      body_unexpected_shape: {
        message: 'This endpoint answered, but not with a model list.',
        action: 'Confirm the dialect',
      },
      models_empty: {
        message: 'The provider returned an empty model list.',
        action: 'Check key permissions',
      },
      probe_no_tool_calling: {
        message: '{model} did not return a valid tool call.',
        action: 'Mark unsupported; route stages needing it elsewhere',
      },
      probe_no_structured_output: {
        message: '{model} did not honour the JSON schema.',
        action: 'Mark unsupported; route stages needing it elsewhere',
      },
      probe_context_short: {
        message: '{model} rejected a {n}-token prompt; its usable context is smaller than advertised.',
        action: 'Store the observed ceiling',
      },
      price_unknown: {
        message: 'Cost cannot be computed for {model}.',
        action: 'Enter prices, or accept pricing_confidence: none',
      },
      egress_denied: {
        message: 'Air-gapped mode blocked this request.',
        action: 'Add the host to KANAL_EGRESS_ALLOW',
      },
    };

    for (const code of FAILURE_CODES) {
      expect(FAILURE_INFO[code], code).toEqual({ code, ...expected[code] });
    }
  });

  it('formatFailure substitutes placeholders', () => {
    expect(formatFailure('probe_no_tool_calling', { model: 'gpt-4o' })).toBe(
      'gpt-4o did not return a valid tool call.',
    );
    expect(formatFailure('probe_context_short', { model: 'claude-3', n: 8000 })).toBe(
      'claude-3 rejected a 8000-token prompt; its usable context is smaller than advertised.',
    );
  });

  it('isFailureCode narrows correctly', () => {
    expect(isFailureCode('http_404')).toBe(true);
    expect(isFailureCode('http_999')).toBe(false);
  });

  it('failureInfo returns the entry', () => {
    expect(failureInfo('http_401').message).toBe('The API key was rejected.');
  });

  describe('classification for routing (plan §11.6)', () => {
    it('permanent codes are never retried', () => {
      for (const code of ['http_401', 'http_403_region', 'http_403_other', 'http_404'] as const) {
        expect(classify(code)).toBe('permanent');
      }
    });
    it('retryable codes get backoff then next binding', () => {
      for (const code of ['http_429', 'http_5xx', 'tcp_timeout', 'dns_timeout'] as const) {
        expect(classify(code)).toBe('retryable');
      }
    });
    it('egress_denied is blocked', () => {
      expect(classify('egress_denied')).toBe('blocked');
    });
  });
});
