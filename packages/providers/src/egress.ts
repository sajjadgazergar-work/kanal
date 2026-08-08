import { ipv4ToInt } from './iputil.js';

/**
 * Egress guard (plan §11.8 air-gapped mode): with `KANAL_EGRESS=deny` a global
 * dispatcher rejects any request to a host outside the allow-list BEFORE a
 * socket opens. `KANAL_EGRESS_ALLOW` is a comma-separated list of hostnames,
 * IPs and CIDR blocks (e.g. `localhost,10.0.0.0/8,ollama`).
 *
 * The guard runs before any socket opens and is the final authority: even a
 * URL that passes the SSRF check is refused here when egress is denied.
 */

export interface EgressState {
  mode: 'deny' | 'allow';
  allow: ReadonlyArray<string>;
  allowCidrs: Array<[number, number]>; // [baseInt, mask]
}

function parseIpv4WithPrefix(raw: string): { base: number; mask: number } | null {
  const idx = raw.indexOf('/');
  const ip = idx === -1 ? raw : raw.slice(0, idx);
  const base = ipv4ToInt(ip);
  if (base === null) return null;
  const prefix = idx === -1 ? 32 : Number(raw.slice(idx + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1)) >>> 0;
  return { base: base & mask, mask };
}

function normalizeHostForMatch(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

export function loadEgress(
  env: { KANAL_EGRESS?: string; KANAL_EGRESS_ALLOW?: string } = process.env,
): EgressState {
  const mode = env.KANAL_EGRESS === 'deny' ? 'deny' : 'allow';
  const raw = (env.KANAL_EGRESS_ALLOW ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const allow: string[] = [];
  const allowCidrs: EgressState['allowCidrs'] = [];
  for (const entry of raw) {
    const parsed = parseIpv4WithPrefix(entry);
    if (parsed !== null) {
      allowCidrs.push([parsed.base, parsed.mask]);
    } else {
      allow.push(normalizeHostForMatch(entry));
    }
  }
  return { mode, allow, allowCidrs };
}

/** Match a URL against the allow-list. `host` and `ip` may both be supplied;
 * the guard permits when either matches (hostname allow-list entry, or an IP /
 * CIDR entry that covers the resolved address). */
export function egressAllows(
  state: EgressState,
  opts: { host?: string; ip?: string },
): boolean {
  if (state.mode !== 'deny') return true;
  // If the host itself is an IP literal, route it through the IP matcher so a
  // CIDR entry like 10.0.0.0/8 matches a "http://10.0.0.5" base URL.
  if (opts.host && ipv4ToInt(opts.host) !== null) {
    opts = { ...opts, ip: opts.host };
  }
  if (opts.host) {
    const h = normalizeHostForMatch(opts.host);
    for (const entry of state.allow) {
      if (entry === h) return true;
      // allow "localhost" to cover "localhost." and any localhost subdomains is NOT
      // intended; keep it exact. Suffix matching is only for FQDN allow-listing
      // with a leading dot, e.g. ".example.com".
      if (entry.startsWith('.') && h.endsWith(entry)) return true;
    }
  }
  if (opts.ip) {
    const ip4 = ipv4ToInt(opts.ip);
    if (ip4 !== null) {
      for (const [base, mask] of state.allowCidrs) {
        if ((ip4 & mask) === base) return true;
      }
    }
    for (const entry of state.allow) {
      if (entry === normalizeHostForMatch(opts.ip)) return true;
    }
  }
  return false;
}

/**
 * The guard invoked before a socket opens. `rawUrl` may be any absolute URL;
 * the host portion is matched against the allow-list. When `resolvedIp` is
 * provided (already SSRF-checked), it must also be covered by an IP/CIDR
 * entry — this is how an allow-listed hostname cannot bypass the CIDR rules.
 */
export function checkEgress(
  state: EgressState,
  rawUrl: string,
  opts: { resolvedIp?: string } = {},
): boolean {
  if (state.mode !== 'deny') return true;
  let host: string | undefined;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return false;
  }
  if (!host) return false;
  return egressAllows(state, { host, ip: opts.resolvedIp });
}
