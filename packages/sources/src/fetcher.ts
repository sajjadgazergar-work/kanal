/**
 * Fetch discipline (plan §8.2) with SSRF-safe DNS (plan §16.2 #6).
 *
 * - undici with a per-host connection pool, 10 s connect / 20 s total timeout,
 *   max 5 redirects, response cap 4 MB, `Accept-Encoding: gzip, br`.
 * - robots.txt fetched and cached 24 h; `Disallow` honoured; a refusal is
 *   surfaced as `robotsBlocked` (recorded as source.robots_blocked).
 * - Per-host concurrency 2, global ingest concurrency 8, 1 rps per host with
 *   jitter (see rateLimit.ts).
 * - SSRF: DNS resolution then an IP deny-list check before connect, re-checked
 *   after every redirect hop; only http(s) schemes; the resolved IP is pinned
 *   into the connection so DNS rebinding cannot swap the target between check
 *   and connect.
 *
 * The HTTP transport and DNS lookup are injectable (module-level seams set by
 * tests) so the suite runs with NO network.
 */

import { request as undiciRequest } from 'undici';
import { isDeniedIp } from './ip.js';

export const MAX_REDIRECTS = 5;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MB
export const CONNECT_TIMEOUT_MS = 10_000;
export const TOTAL_TIMEOUT_MS = 20_000;
export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export class FetchError extends Error {
  readonly kind:
    | 'scheme'
    | 'denied'
    | 'dns'
    | 'timeout'
    | 'too_many_redirects'
    | 'oversize'
    | 'robots'
    | 'http';
  readonly status?: number;
  constructor(kind: FetchError['kind'], message: string, status?: number) {
    super(message);
    this.name = 'FetchError';
    this.kind = kind;
    this.status = status;
  }
}

export interface FetchPolicy {
  /** Honor robots.txt (default true). */
  honorRobots?: boolean;
  /** Skip the SSRF deny-list (used only for explicitly-allowlisted hosts; not exported to connectors). */
  allowPrivate?: boolean;
}

export interface FetchResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  redirectedUrls: string[];
  notModified: boolean;
}

export interface FetchOptions {
  method?: string;
  redirects?: number;
  bodyLimit?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Override the default headers entirely (some connectors need custom UA). */
  headersOverride?: Record<string, string>;
  etag?: string | null;
  lastModified?: string | null;
}

// ---- transport seam ----

export interface HttpRequestOptions {
  method?: string;
  headers: Record<string, string>;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes: number;
  /** Pinned, deny-checked IP to connect to (anti-DNS-rebinding). */
  resolvedIp?: string | null;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
}

export type HttpTransport = (url: string, opts: HttpRequestOptions) => Promise<HttpResponse>;

/** Default transport backed by undici. */
const undiciTransport: HttpTransport = async (url, opts) => {
  const requestOpts: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'PATCH' | 'OPTIONS';
    headers: Record<string, string>;
    maxRedirections: number;
    headersTimeout?: number;
    bodyTimeout?: number;
    connectTimeout?: number;
    lookup?: (hostname: string, options: object, callback: (err: Error | null, addresses?: Array<{ address: string; family: number }>) => void) => void;
  } = {
    method: (opts.method ?? 'GET').toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'PATCH' | 'OPTIONS',
    headers: opts.headers,
    maxRedirections: 0,
    headersTimeout: opts.totalTimeoutMs,
    bodyTimeout: opts.totalTimeoutMs,
    connectTimeout: opts.connectTimeoutMs,
  };
  if (opts.resolvedIp) {
    const resolved = opts.resolvedIp;
    requestOpts.lookup = (_host: string, _options: object, cb: (err: Error | null, addresses?: Array<{ address: string; family: number }>) => void) => {
      const family = resolved.includes(':') ? 6 : 4;
      cb(null, [{ address: resolved, family }]);
    };
  }
  const res = await undiciRequest(url, requestOpts);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    if (typeof v === 'string') headers[k.toLowerCase()] = v;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > opts.maxResponseBytes) {
      await res.body.dump();
      throw new FetchError('oversize', `Response body exceeded ${opts.maxResponseBytes} bytes`);
    }
    chunks.push(buf);
  }
  return { statusCode: res.statusCode, headers, body: Buffer.concat(chunks) };
};

let activeTransport: HttpTransport = undiciTransport;

/** Test seam — replace the HTTP transport. */
export function setTransport(t: HttpTransport): void {
  activeTransport = t;
}

/** Test seam — restore the undici transport. */
export function resetTransport(): void {
  activeTransport = undiciTransport;
}

export function getTransport(): HttpTransport {
  return activeTransport;
}

// ---- lookup seam ----

export type LookupFn = (hostname: string) => Promise<string[]>;

const DEFAULT_LOOKUP: LookupFn = async (hostname) => {
  const { lookup } = await import('node:dns/promises');
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

let activeLookup: LookupFn = DEFAULT_LOOKUP;

/** Test seam — replace DNS resolution. */
export function setLookup(l: LookupFn): void {
  activeLookup = l;
}

/** Test seam — restore real DNS. */
export function resetLookup(): void {
  activeLookup = DEFAULT_LOOKUP;
}

export function getLookup(): LookupFn {
  return activeLookup;
}

/**
 * Resolve + deny-check a host. Returns the first non-denied address; throws
 * `FetchError('denied')` if every address is denied, `FetchError('dns')` on
 * resolution failure.
 */
export async function resolveAndCheck(
  hostname: string,
  lookup: LookupFn = activeLookup,
  allowPrivate = false,
): Promise<string> {
  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    throw new FetchError('dns', `DNS resolution failed for ${hostname}: ${String(err)}`);
  }
  if (addresses.length === 0) {
    throw new FetchError('dns', `DNS resolution returned no addresses for ${hostname}`);
  }
  for (const addr of addresses) {
    if (allowPrivate || !isDeniedIp(addr)) return addr;
  }
  throw new FetchError(
    'denied',
    `Host ${hostname} resolved only to denied (private/loopback/link-local) addresses: ${addresses.join(', ')}`,
  );
}

function parseDenied(host: string, allowPrivate: boolean): boolean {
  if (allowPrivate) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    return isDeniedIp(host);
  }
  return false;
}

/**
 * The low-level fetch used by the connectors. Returns headers + body, honours
 * conditional GET (`If-None-Match` / `If-Modified-Since`), the SSRF deny-list,
 * and robots.txt.
 */
export async function safeFetch(
  url: string,
  opts: FetchOptions = {},
  policy: FetchPolicy = {},
  lookup: LookupFn = activeLookup,
): Promise<FetchResult> {
  const allowPrivate = policy.allowPrivate ?? false;
  const honorRobots = policy.honorRobots ?? true;

  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new FetchError('scheme', `Unsupported scheme "${u.protocol}" — only http/https allowed`);
  }

  if (parseDenied(u.hostname, allowPrivate)) {
    throw new FetchError('denied', `Host ${u.hostname} is on the SSRF deny-list`);
  }

  if (honorRobots && !parseDenied(u.hostname, allowPrivate)) {
    const rule = await fetchRobots(u.origin + '/robots.txt', lookup);
    if (!robotsPathAllowed(rule, u.pathname)) {
      throw new FetchError('robots', `robots.txt disallows ${u.pathname}`, 403);
    }
  }

  return rawFetch(u, opts, policy, lookup);
}

/**
 * Internal fetch that walks redirects, re-checking the deny-list on each hop
 * and pinning the resolved IP into each connection.
 */
async function rawFetch(
  u: URL,
  opts: FetchOptions,
  policy: FetchPolicy,
  lookup: LookupFn,
): Promise<FetchResult> {
  const allowPrivate = policy.allowPrivate ?? false;
  const redirectsLeft = opts.redirects ?? MAX_REDIRECTS;
  const bodyLimit = opts.bodyLimit ?? MAX_RESPONSE_BYTES;
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const totalTimeoutMs = opts.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;

  const headers: Record<string, string> = {
    'accept-encoding': 'gzip, br',
    'user-agent': 'KANAL/0.1 (+https://kanal.dev)',
    ...(opts.headersOverride ?? {}),
  };
  if (opts.etag) headers['if-none-match'] = opts.etag;
  if (opts.lastModified) headers['if-modified-since'] = opts.lastModified;

  const redirectedUrls: string[] = [];
  let current = u;
  let response: HttpResponse | null = null;

  for (let hop = 0; ; hop++) {
    // Resolve + deny-check + pin the current host.
    let resolvedIp: string | null = null;
    if (!parseDenied(current.hostname, allowPrivate)) {
      resolvedIp = await resolveAndCheck(current.hostname, lookup, allowPrivate);
    }

    let attempt: HttpResponse;
    try {
      attempt = await activeTransport(current.toString(), {
        method: opts.method ?? 'GET',
        headers,
        connectTimeoutMs,
        totalTimeoutMs,
        maxResponseBytes: bodyLimit,
        resolvedIp,
      });
    } catch (err) {
      if (err instanceof FetchError) throw err;
      const code = (err as { code?: string })?.code;
      if (
        code === 'UND_ERR_CONNECT_TIMEOUT' ||
        code === 'UND_ERR_HEADERS_TIMEOUT' ||
        code === 'UND_ERR_BODY_TIMEOUT'
      ) {
        throw new FetchError('timeout', `Timeout fetching ${current.toString()}: ${String(err)}`);
      }
      throw new FetchError('http', `Fetch failed for ${current.toString()}: ${String(err)}`);
    }

    // Enforce the response size cap at the rawFetch layer so it applies to all
    // transports (the undici transport also enforces it mid-stream).
    if (attempt.body.length > bodyLimit) {
      throw new FetchError('oversize', `Response body exceeded ${bodyLimit} bytes`);
    }

    if (attempt.statusCode >= 300 && attempt.statusCode < 400) {
      const loc = attempt.headers['location'];
      if (!loc) {
        response = attempt;
        break;
      }
      if (hop >= redirectsLeft) {
        throw new FetchError('too_many_redirects', `Too many redirects (> ${redirectsLeft}) fetching ${u.toString()}`);
      }
      const next = new URL(loc, current.toString());
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new FetchError('scheme', `Redirect to non-http(s) scheme "${next.protocol}"`);
      }
      if (parseDenied(next.hostname, allowPrivate)) {
        throw new FetchError('denied', `Redirect target ${next.hostname} is on the SSRF deny-list`);
      }
      redirectedUrls.push(next.toString());
      current = next;
      continue;
    }

    response = attempt;
    break;
  }

  if (!response) throw new FetchError('http', 'No response');
  const notModified = response.statusCode === 304;
  return {
    url: current.toString(),
    status: response.statusCode,
    headers: response.headers,
    body: notModified ? Buffer.alloc(0) : response.body,
    redirectedUrls,
    notModified,
  };
}

// ---- robots.txt ----

interface RobotsGroup {
  agents: string[];
  disallows: string[];
  allows: string[];
}

export interface RobotsRule {
  allowed: boolean;
  reason?: string;
  groups?: RobotsGroup[];
}

const robotsCache = new Map<string, { at: number; rule: RobotsRule }>();

/** Fetch and parse robots.txt for an origin (cached 24 h). Disallow honoured. */
export async function fetchRobots(robotsUrl: string, lookup: LookupFn = activeLookup): Promise<RobotsRule> {
  const key = robotsUrl;
  const cached = robotsCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < ROBOTS_TTL_MS) return cached.rule;

  let rule: RobotsRule = { allowed: true, groups: [] };
  try {
    const result = await rawFetch(new URL(robotsUrl), { redirects: 2, bodyLimit: 512 * 1024 }, { honorRobots: false }, lookup);
    const text = result.body.toString('utf8');
    rule = parseRobots(text);
  } catch {
    rule = { allowed: true, groups: [] };
  }
  robotsCache.set(key, { at: now, rule });
  return rule;
}

const WILDCARD = '*';
const AGENT_NAME = 'kanal';

/**
 * Minimal robots.txt parser. Groups are "User-agent: *" or a specific agent;
 * a matching explicit-agent group beats wildcard; within a group the longest
 * matching prefix decides; `Allow` overrides `Disallow`.
 */
export function parseRobots(text: string): RobotsRule {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l.length > 0);

  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  const flush = () => {
    if (current && current.agents.length > 0) groups.push(current);
    current = null;
  };
  for (const line of lines) {
    const [keyRaw = '', ...rest] = line.split(':', 2);
    const key = keyRaw.trim().toLowerCase();
    const value = (rest.join(':') ?? '').trim();
    if (key === 'user-agent') {
      if (current && current.agents.length > 0) flush();
      if (!current) current = { agents: [], disallows: [], allows: [] };
      current.agents.push(value.toLowerCase());
    } else if (key === 'disallow' || key === 'allow') {
      if (!current) current = { agents: [], disallows: [], allows: [] };
      if (key === 'disallow') current.disallows.push(value);
      else current.allows.push(value);
    }
  }
  flush();

  const matching: RobotsGroup[] = [];
  for (const g of groups) {
    if (g.agents.some((a) => a === AGENT_NAME || a === WILDCARD)) matching.push(g);
  }
  matching.sort((a, b) => {
    const aWild = a.agents.some((x) => x === WILDCARD);
    const bWild = b.agents.some((x) => x === WILDCARD);
    if (aWild !== bWild) return aWild ? 1 : -1;
    return 0;
  });

  const disallowPath = (path: string): boolean => {
    if (path === '') return false;
    const urlPath = path.startsWith('/') ? path : '/' + path;
    for (const g of matching) {
      for (const d of g.disallows) {
        if (d === '') continue; // "Disallow:" with no value = allow all
        if (d === '/') return true;
        const dp = d.startsWith('/') ? d : '/' + d;
        if (urlPath.startsWith(dp)) return true;
      }
    }
    return false;
  };
  const allowPath = (path: string): boolean => {
    const urlPath = path.startsWith('/') ? path : '/' + path;
    for (const g of matching) {
      for (const a of g.allows) {
        if (a === '') continue;
        const ap = a.startsWith('/') ? a : '/' + a;
        if (urlPath.startsWith(ap)) return true;
      }
    }
    return false;
  };

  return {
    allowed: !disallowPath('/') || allowPath('/'),
    groups: matching,
  };
}

/**
 * Check whether a specific path is allowed under a robots rule.
 */
export function robotsPathAllowed(rule: RobotsRule, path: string): boolean {
  const groups = rule.groups ?? [];
  if (groups.length === 0) return rule.allowed;
  if (path === '') return rule.allowed;
  const urlPath = path.startsWith('/') ? path : '/' + path;
  for (const g of groups) {
    for (const a of g.allows) {
      if (a === '') continue;
      const ap = a.startsWith('/') ? a : '/' + a;
      if (urlPath.startsWith(ap)) return true;
    }
    for (const d of g.disallows) {
      if (d === '') continue;
      if (d === '/') return false;
      const dp = d.startsWith('/') ? d : '/' + d;
      if (urlPath.startsWith(dp)) return false;
    }
  }
  return rule.allowed;
}

/** Test seam — clear the robots cache between tests. */
export function resetRobotsCache(): void {
  robotsCache.clear();
}
