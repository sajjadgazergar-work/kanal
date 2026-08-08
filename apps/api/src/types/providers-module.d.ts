/**
 * Ambient declaration for `@kanal/providers`, which is still in flight and not
 * yet a resolvable workspace dependency. The providers route imports it
 * dynamically and returns 501 when it is unavailable, so the whole API build
 * must not hard-fail on its absence (plan §11 is a work-in-progress package).
 *
 * The shape mirrors the real package's exports (validation.validateProvider,
 * fetchTransport.FetchTransport) so the adapter type-checks, but the module is
 * not imported at build time.
 */
declare module '@kanal/providers' {
  export interface ProviderConfig {
    label: string;
    dialect: 'openai_compatible' | 'anthropic' | 'ollama';
    baseUrl: string;
    authKind: 'bearer' | 'x_api_key' | 'none' | 'custom_header';
    customHeaderName?: string;
    extraHeaders: Record<string, string>;
    timeoutMs: number;
    maxConcurrent: number;
  }

  export interface HttpRequestOptions {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }

  export interface Transport {
    request(opts: HttpRequestOptions): Promise<unknown>;
  }

  export interface DiscoveryDeps {
    transport: Transport;
    decryptKey: () => string | undefined;
  }

  export class FetchTransport implements Transport {
    constructor(opts?: unknown);
    request(opts: HttpRequestOptions): Promise<unknown>;
  }

  export function validateProvider(
    cfg: ProviderConfig,
    deps: DiscoveryDeps,
    probeClient?: unknown,
    opts?: unknown,
  ): Promise<unknown>;
}
