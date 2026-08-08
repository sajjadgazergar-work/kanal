import { lookup } from 'node:dns/promises';
import { ipv4ToInt } from './iputil.js';

/**
 * SSRF protection (plan §16.2 #6 #7): DNS resolution then an IP check against
 * a deny-list (RFC1918, loopback, link-local, CGNAT, IPv6 ULA/mapped) BEFORE
 * connect; re-checked after every redirect hop; `file:`/`gopher:`/`ftp:`
 * schemes rejected outright. `KANAL_ALLOW_PRIVATE_PROVIDERS=1` opts into a
 * local Ollama / vLLM — it narrows the deny-list rather than removing it.
 */

export const BLOCKED_URL_SCHEMES = ['file:', 'gopher:', 'ftp:'] as const;

export const DEFAULT_PRIVATE_IPV4_BLOCKS: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT (RFC 6598)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local / cloud metadata
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments (192.0.0.0/24)
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

export const DEFAULT_PRIVATE_IPV6_BLOCKS: ReadonlyArray<[string, number]> = [
  ['::1', 128], // loopback
  ['::', 128], // unspecified
  ['::ffff:0:0', 96], // IPv4-mapped IPv6 (deny; the mapped v4 check decides)
  ['64:ff9b::', 96], // NAT64 well-known prefix
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local (ULA)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];

function blockContains(ipInt: number, base: string, prefix: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  if (prefix <= 0) return true;
  const mask = prefix >= 32 ? 0xffffffff : ~((1 << (32 - prefix)) - 1) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

export interface IpBlock {
  base: string;
  prefix: number;
}

function normalizeV6(s: string): string {
  // lowercase, strip a single trailing zone id
  let t = s.toLowerCase();
  const zoneIdx = t.indexOf('%');
  if (zoneIdx !== -1) t = t.slice(0, zoneIdx);
  return t;
}

/** Expand an IPv6 address to 8 groups of 4 hex digits, supporting `::`. */
function expandV6(addr: string): string | null {
  let s = normalizeV6(addr).trim();
  if (s.includes('.')) return null; // only handles pure v6; mapped is handled by ::ffff detection below
  let doubleColon = false;
  if (s.includes('::')) {
    if (s.split('::').length - 1 !== 1) return null;
    doubleColon = true;
    s = s.replace('::', ':');
  }
  const groups = s.split(':').filter((g) => g.length > 0);
  if (groups.length === 0) return null;
  for (const g of groups) {
    if (g.length > 4 || !/^[0-9a-f]{1,4}$/.test(g)) return null;
  }
  if (groups.length > 8) return null;
  const parts: string[] = [];
  if (doubleColon) {
    const missing = 8 - groups.length;
    for (const g of groups) parts.push(g);
    for (let i = 0; i < missing; i++) parts.push('0');
  } else {
    if (groups.length !== 8) return null;
    parts.push(...groups);
  }
  return parts.map((g) => g.padStart(4, '0')).join(':');
}

function v6ToInt(expanded: string): bigint | null {
  const groups = expanded.split(':');
  let n = 0n;
  for (const g of groups) {
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

function v6BlockContains(addrInt: bigint, base: string, prefix: number): boolean {
  const expanded = expandV6(base);
  if (expanded === null) return false;
  const baseInt = v6ToInt(expanded);
  if (baseInt === null) return false;
  if (prefix >= 128) return addrInt === baseInt;
  if (prefix <= 0) return true;
  return (addrInt >> BigInt(128 - prefix)) === (baseInt >> BigInt(128 - prefix));
}

/** Is `ip` inside any block? `blocks` entries are [base, prefix]. */
export function ipInBlocks(
  ip: string,
  blocks: ReadonlyArray<[string, number]>,
): boolean {
  const ip4 = ipv4ToInt(ip);
  if (ip4 !== null) {
    for (const [base, prefix] of blocks) {
      if (blockContains(ip4, base, prefix)) return true;
    }
    return false;
  }
  // IPv6
  if (!ip.includes(':') || ip.includes('.')) {
    // An embedded IPv4 tail like ::ffff:169.254.169.254 — expand and re-check
    // as v4. Only valid when the IPv4 part is the low 32 bits.
    const m = ip.match(/::(ffff(?::0{1,4})?)?:(?<v4>[\d.]+)$/i);
    const v4 = m?.groups?.v4;
    if (v4) {
      const low = ipv4ToInt(v4);
      if (low !== null) {
        for (const [base, prefix] of blocks) {
          if (blockContains(low, base, prefix)) return true;
        }
      }
    }
    return false;
  }
  const expanded = expandV6(ip);
  if (expanded === null) return false;
  const addrInt = v6ToInt(expanded);
  if (addrInt === null) return false;
  for (const [base, prefix] of blocks) {
    if (v6BlockContains(addrInt, base, prefix)) return true;
  }
  return false;
}

/** A DNS resolver returning literal IPs. Injectable for tests (no network). */
export type Resolver = (host: string) => Promise<string[]>;

export interface SsrfOptions {
  /** When true, private/loopback addresses are permitted for local providers
   * (KANAL_ALLOW_PRIVATE_PROVIDERS=1, plan §16.2 #7). */
  allowPrivate: boolean;
  /** When allowPrivate, further restrict to this block (or allow all private). */
  privateAllow?: string | undefined;
  extraDeny?: ReadonlyArray<[string, number]> | undefined;
}

export interface SsrfCheckResult {
  allowed: boolean;
  reason: 'ok' | 'scheme_blocked' | 'dns_failed' | 'host_blocked' | 'ip_denied';
  /** The resolved addresses, when the check got that far. */
  resolvedIps?: string[];
  /** The host that was resolved, if any. */
  hostname?: string;
}

function urlSchemeOf(rawUrl: string): string {
  const m = rawUrl.match(/^([a-z][a-z0-9+.-]*):/i);
  return m?.[1] ? m[1].toLowerCase() : '';
}

/**
 * Check a raw URL: scheme allow-list first, then resolve its host and check
 * every resolved address against the deny-list. Call BEFORE connecting and
 * again after every redirect (plan §16.2 #6).
 */
export async function checkSsrf(
  rawUrl: string,
  opts: SsrfOptions,
  resolver: (host: string) => Promise<string[]> = resolveDns,
): Promise<SsrfCheckResult> {
  const scheme = urlSchemeOf(rawUrl);
  if (BLOCKED_URL_SCHEMES.includes(scheme as (typeof BLOCKED_URL_SCHEMES)[number])) {
    return { allowed: false, reason: 'scheme_blocked' };
  }
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ws' && scheme !== 'wss') {
    return { allowed: false, reason: 'scheme_blocked' };
  }

  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return { allowed: false, reason: 'dns_failed' };
  }
  if (!hostname) return { allowed: false, reason: 'dns_failed' };

  const res = await checkHost(hostname, opts, resolver);
  return { ...res, hostname };
}

/** Resolve a host and check all addresses; export for redirect re-checks. */
export async function checkHost(
  hostname: string,
  opts: SsrfOptions,
  resolver: (host: string) => Promise<string[]> = resolveDns,
): Promise<SsrfCheckResult> {
  // An IP literal host needs no DNS; check it directly (also defeats
  // DNS-rebinding for literal addresses and lets tests run without a resolver).
  if (ipv4ToInt(hostname) !== null || hostname.includes(':')) {
    const ips = [hostname];
    if (isDeniedIp(hostname, opts)) {
      return { allowed: false, reason: 'ip_denied', resolvedIps: ips };
    }
    return { allowed: true, reason: 'ok', resolvedIps: ips };
  }
  let ips: string[];
  try {
    ips = await resolver(hostname);
  } catch {
    return { allowed: false, reason: 'dns_failed' };
  }
  if (ips.length === 0) return { allowed: false, reason: 'dns_failed' };

  for (const ip of ips) {
    if (isDeniedIp(ip, opts)) return { allowed: false, reason: 'ip_denied', resolvedIps: ips };
  }
  return { allowed: true, reason: 'ok', resolvedIps: ips };
}

export function isDeniedIp(ip: string, opts: SsrfOptions): boolean {
  // Extra deny rules always apply, even under allowPrivate.
  if (opts.extraDeny) {
    if (ipInBlocks(ip, opts.extraDeny)) return true;
  }

  // Deny-by-default.
  if (!opts.allowPrivate) {
    if (ipInBlocks(ip, DEFAULT_PRIVATE_IPV4_BLOCKS)) return true;
    if (ipInBlocks(ip, DEFAULT_PRIVATE_IPV6_BLOCKS)) return true;
  } else {
    // Narrowed deny-list (plan §16.2 #7): only the documented-test + metadata
    // block stays denied unless the operator's privateAllow covers it.
    const narrowV4: Array<[string, number]> = [
      ['169.254.0.0', 16], // link-local / cloud metadata (never OK)
      ['192.0.2.0', 24],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['0.0.0.0', 8],
    ];
    if (opts.privateAllow) {
      const [base, prefix] = parseBlock(opts.privateAllow);
      if (base) {
        // if the operator's allow block covers this ip entirely, permit it
        const ip4 = ipv4ToInt(ip);
        if (ip4 !== null && blockContains(ip4, base, prefix)) {
          return false;
        }
      }
    }
    if (ipInBlocks(ip, narrowV4)) return true;
    // Under the opt-in, only deny the IPv6 documentation + metadata-adjacent
    // ranges; loopback/ULA/link-local are what a local Ollama needs.
    const narrowV6: Array<[string, number]> = [
      ['2001:db8::', 32], // documentation
      ['100::', 64], // discard-only
    ];
    if (ipInBlocks(ip, narrowV6)) return true;
  }
  return false;
}

function parseBlock(block: string): [string, number] | [null, 0] {
  const idx = block.indexOf('/');
  if (idx === -1) {
    const ip4 = ipv4ToInt(block);
    if (ip4 !== null) return [block, 32];
    return [null, 0];
  }
  const base = block.slice(0, idx);
  const prefix = Number(block.slice(idx + 1));
  if (!Number.isFinite(prefix)) return [null, 0];
  if (ipv4ToInt(base) === null) return [null, 0];
  return [base, prefix];
}

/** Node default resolver: resolves all A + AAAA records for a host. */
export async function resolveDns(host: string): Promise<string[]> {
  const addresses = await lookup(host, { all: true });
  return addresses.map((a) => a.address);
}
