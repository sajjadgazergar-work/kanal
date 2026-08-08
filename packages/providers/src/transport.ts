import { type ProviderConfig } from './config.js';

/**
 * Injectable HTTP transport. The whole subsystem is built against this
 * interface so tests run with zero network access (a fake transport returns
 * canned responses / throws canned errors).
 */

export interface HttpResponse {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  /** Raw body text (never parsed here). */
  body: string;
}

export interface HttpRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Per-request timeout in ms; the transport must abort at the deadline. */
  timeoutMs?: number;
}

export interface HttpTransportError extends Error {
  code?:
    | 'dns_nxdomain'
    | 'dns_timeout'
    | 'tcp_refused'
    | 'tcp_timeout'
    | 'tls_cert_invalid'
    | 'tls_protocol'
    | 'egress_denied';
}

export interface Transport {
  request(opts: HttpRequestOptions): Promise<HttpResponse>;
}

/** Build the request headers the transport sends for a provider. The key is
 * already decrypted plaintext; it never survives beyond this call. */
export function headersForProvider(
  cfg: Pick<ProviderConfig, 'dialect' | 'authKind' | 'customHeaderName' | 'extraHeaders'>,
  decryptedKey: string | undefined,
): Record<string, string> {
  const h: Record<string, string> = { ...(cfg.extraHeaders ?? {}) };
  switch (cfg.authKind) {
    case 'bearer':
      if (decryptedKey) h.Authorization = `Bearer ${decryptedKey}`;
      break;
    case 'x_api_key':
      if (decryptedKey) h['x-api-key'] = decryptedKey;
      break;
    case 'custom_header':
      if (cfg.customHeaderName && decryptedKey) h[cfg.customHeaderName] = decryptedKey;
      break;
    case 'none':
      break;
  }
  if (cfg.dialect === 'anthropic') {
    h['anthropic-version'] ??= '2023-06-01';
  }
  return h;
}
