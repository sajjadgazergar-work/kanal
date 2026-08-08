import { type HttpResponse, type HttpRequestOptions, type HttpTransportError, type Transport } from './transport.js';
import { checkSsrf, resolveDns, type SsrfOptions, type Resolver } from './ssrf.js';
import { checkEgress, loadEgress, type EgressState } from './egress.js';

/**
 * Production transport over `fetch`. Two guards run BEFORE a socket opens
 * (plan §16.2 #6 #7, §11.8):
 *   1. SSRF: resolve DNS, check every address against the deny-list, re-check
 *      after every redirect hop; reject file:/gopher:/ftp: schemes.
 *   2. Egress: in air-gapped mode the host must be in KANAL_EGRESS_ALLOW.
 */

export interface FetchTransportOptions {
  ssrf?: SsrfOptions;
  egress?: EgressState;
  fetchFn?: typeof fetch;
  /** Override DNS resolution (defaults to the system resolver). */
  resolver?: Resolver;
}

export class FetchTransport implements Transport {
  private readonly ssrf: SsrfOptions;
  private readonly egress: EgressState;
  private readonly fetchFn: typeof fetch;
  private readonly resolver: Resolver;

  constructor(opts: FetchTransportOptions = {}) {
    this.ssrf = opts.ssrf ?? { allowPrivate: false };
    this.egress = opts.egress ?? loadEgress();
    this.fetchFn = opts.fetchFn ?? ((globalThis.fetch as typeof fetch | undefined) ?? (() => { throw new Error('no fetch in this environment'); }));
    this.resolver = opts.resolver ?? resolveDns;
  }

  async request(opts: HttpRequestOptions): Promise<HttpResponse> {
    const url = opts.url;
    // Scheme + DNS + IP deny-list, BEFORE connect. `resolvedIps` pins the IP
    // for the egress check (and would be the IP we pin into the connection to
    // defeat DNS rebinding).
    const ssrf = await checkSsrf(url, this.ssrf, this.resolver);
    if (!ssrf.allowed) {
      throw transportError('egress_denied', `SSRF guard blocked ${url} (${ssrf.reason})`);
    }
    // Egress guard: air-gapped mode, allow-list before a socket opens.
    if (this.egress.mode === 'deny') {
      if (!checkEgress(this.egress, url, { resolvedIp: ssrf.resolvedIps?.[0] })) {
        throw transportError('egress_denied', `egress guard blocked ${url}`);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
    try {
      let resp = await this.fetchFn(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        signal: controller.signal,
        redirect: 'manual',
      });
      let redirects = 0;
      // Follow redirects manually so we can re-run the SSRF check at every hop.
      while (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (!location) break;
        if (++redirects > 5) throw transportError('tcp_timeout', 'too many redirects');
        const nextUrl = new URL(location, url).toString();
        const hopSsrf = await checkSsrf(nextUrl, this.ssrf, this.resolver);
        if (!hopSsrf.allowed) {
          throw transportError('egress_denied', `SSRF guard blocked redirect to ${nextUrl} (${hopSsrf.reason})`);
        }
        if (this.egress.mode === 'deny') {
          if (!checkEgress(this.egress, nextUrl, { resolvedIp: hopSsrf.resolvedIps?.[0] })) {
            throw transportError('egress_denied', `egress guard blocked redirect to ${nextUrl}`);
          }
        }
        const hopController = new AbortController();
        const hopTimer = setTimeout(() => hopController.abort(), opts.timeoutMs ?? 60_000);
        try {
          resp = await this.fetchFn(nextUrl, {
            method: opts.method,
            headers: opts.headers,
            body: opts.body,
            signal: hopController.signal,
            redirect: 'manual',
          });
        } finally {
          clearTimeout(hopTimer);
        }
      }
      const headers: Record<string, string> = {};
      resp.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const body = await resp.text();
      return { status: resp.status, statusText: resp.statusText, headers, body };
    } catch (e) {
      throw classifyFetchError(e);
    } finally {
      clearTimeout(timer);
    }
  }

}

function transportError(code: HttpTransportError['code'], message: string): HttpTransportError {
  const err: HttpTransportError = new Error(message) as HttpTransportError;
  err.name = 'TransportError';
  err.code = code;
  return err;
}

const KANAL_TRANSPORT_CODES = new Set([
  'dns_nxdomain',
  'dns_timeout',
  'tcp_refused',
  'tcp_timeout',
  'tls_cert_invalid',
  'tls_protocol',
  'egress_denied',
]);

function classifyFetchError(e: unknown): HttpTransportError {
  if (e instanceof Error && 'code' in e) {
    const code = (e as { code?: string }).code;
    // Already a KANAL transport error (e.g. SSRF/egress guard threw) — pass through.
    if (code !== undefined && KANAL_TRANSPORT_CODES.has(code)) {
      return transportError(code as HttpTransportError['code'], e.message);
    }
    switch (code) {
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return transportError('dns_nxdomain', 'DNS lookup failed');
      case 'ECONNREFUSED':
        return transportError('tcp_refused', 'connection refused');
      case 'ECONNRESET':
        return transportError('tcp_refused', 'connection reset');
      case 'ETIMEDOUT':
        return transportError('tcp_timeout', 'connection timed out');
      case 'CERT_HAS_EXPIRED':
      case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        return transportError('tls_cert_invalid', 'certificate verification failed');
      case 'ERR_TLS_CERT_ALTNAME_INVALID':
        return transportError('tls_cert_invalid', 'certificate hostname mismatch');
      default:
        if (String(code).toLowerCase().includes('tls') || String(code).toLowerCase().includes('ssl')) {
          return transportError('tls_protocol', 'TLS handshake failed');
        }
        if (String(code).toLowerCase().includes('dns')) {
          return transportError('dns_timeout', 'DNS lookup timed out');
        }
        if (String(code).toLowerCase().includes('timeout')) {
          return transportError('tcp_timeout', 'request timed out');
        }
    }
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return transportError('tcp_timeout', 'request timed out');
  }
  if (e instanceof Error) {
    return transportError('tcp_timeout', e.message);
  }
  return transportError('tcp_timeout', 'unknown transport error');
}
