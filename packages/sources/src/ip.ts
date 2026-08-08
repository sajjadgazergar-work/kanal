/**
 * IP deny-list for SSRF protection (plan §16.2 #6).
 *
 * A candidate host is resolved to every A/AAAA record; each address is checked
 * against the deny-list BEFORE a socket is opened, and the resolved addresses
 * are pinned into the connection so a DNS-rebinding attacker cannot swap the
 * target between our check and the connect. Redirect targets are re-checked on
 * every hop.
 */

export const PRIVATE_CIDR4: Array<[number, number]> = [
  [0x00000000, 8], // "this" network
  [0x0a000000, 8], // RFC1918 10/8
  [0x7f000000, 8], // loopback 127/8
  [0x64400000, 10], // CGNAT 100.64/10
  [0xa9fe0000, 16], // link-local 169.254/16
  [0xac100000, 12], // RFC1918 172.16/12
  [0xc0a80000, 16], // RFC1918 192.168/16
  [0xc0000000, 24], // IETF protocol assignments 192.0.0/24 (incl. 192.0.0.0/24, 192.0.0.8/32, 192.0.0.9/32, 192.0.0.10/32, 192.0.0.170/32, 192.0.0.171/32)
  [0xc0000200, 24], // TEST-NET-1 192.0.2/24
  [0xc6120000, 15], // benchmarking 198.18/15
  [0xc6336400, 24], // TEST-NET-2 198.51.100/24
  [0xcb007100, 24], // TEST-NET-3 203.0.113/24
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved (incl. 255.255.255.255)
];

/** IPv4-mapped `::ffff:0:0/96`: high 96 bits are 0x0000_0000_0000_0000_0000_ffff. */
const INADDR_V4_MAPPED = 0xffffn;
/** NAT64 well-known prefix `64:ff9b::/96`: high 96 bits are 0x0064_ff9b_0000_0000_0000_0000. */
const NAT64_PREFIX = 0x0064ff9bn << 64n;

/**
 * Check a single IPv4 address (as 4 bytes) against the deny-list.
 */
export function isPrivateIpv4(octets: [number, number, number, number]): boolean {
  const value =
    ((octets[0]! << 24) >>> 0) | ((octets[1]! << 16) >>> 0) | ((octets[2]! << 8) >>> 0) | octets[3]!;
  for (const [base, bits] of PRIVATE_CIDR4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) === (base & mask)) return true;
  }
  return false;
}

/** Extract the embedded IPv4 (last 32 bits) and deny-check it. */
function checkEmbeddedV4(addr: bigint): boolean {
  const lo = Number(addr & 0xffffffffn);
  const octets: [number, number, number, number] = [
    (lo >>> 24) & 0xff,
    (lo >>> 16) & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff,
  ];
  return isPrivateIpv4(octets);
}

/**
 * Check a single IPv6 address (as a 128-bit bigint) against the deny-list.
 */
export function isPrivateIpv6(addr: bigint): boolean {
  // IPv4-mapped ::ffff:x.y.z.w — top 96 bits are 0x0000…ffff.
  if ((addr >> 32n) === INADDR_V4_MAPPED) {
    return checkEmbeddedV4(addr);
  }
  // v4-translated 64:ff9b::/96 (NAT64) — same embedded check.
  if ((addr >> 32n) === NAT64_PREFIX) {
    return checkEmbeddedV4(addr);
  }

  const top = (addr >> 112n) & 0xffffn;
  const second = (addr >> 96n) & 0xffffn;

  // ::/128 unspecified, ::1/128 loopback.
  if (addr === 0n || addr === 1n) return true;
  // fc00::/7 ULA.
  if ((top & 0xfe00n) === 0xfc00n) return true;
  // fe80::/10 link-local.
  if ((top & 0xffc0n) === 0xfe80n) return true;
  // fec0::/10 site-local (deprecated).
  if ((top & 0xffc0n) === 0xfec0n) return true;
  // ff00::/8 multicast.
  if ((top & 0xff00n) === 0xff00n) return true;
  // 2001:db8::/32 documentation.
  if (top === 0x2001n && second === 0x0db8n) return true;
  // 2001::/32 Teredo + 2002::/16 6to4 — these embed real IPv4 destinations;
  // treat as deny (conservative).
  if (top === 0x2001n) return true;
  if (top === 0x2002n) return true;
  // ::ffff:0:0/96 v4-compatible (deprecated).
  if (addr < (1n << 96n)) return true;

  return false;
}

/**
 * Parse an IP string (v4 or v6) and return a private/deny verdict.
 */
export function isDeniedIp(address: string): boolean {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
    const parts = address.split('.').map((p) => Number(p));
    if (parts.some((p) => p > 255)) return false;
    return isPrivateIpv4(parts as [number, number, number, number]);
  }
  // IPv6
  if (address.includes(':')) {
    try {
      const big = ipv6ToBigInt(address);
      if (big === null) return true; // unparseable — deny closed
      return isPrivateIpv6(big);
    } catch {
      return true;
    }
  }
  return true; // not a valid IP literal — deny closed
}

/**
 * Convert an IPv6 string to a 128-bit bigint, expanding :: and mapping v4 tails.
 */
export function ipv6ToBigInt(input: string): bigint | null {
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.includes('%')) s = s.slice(0, s.indexOf('%')); // strip zone id

  let v4Tail: string | null = null;
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':');
    v4Tail = s.slice(idx + 1);
    // Drop the trailing ':' so `::ffff:127.0.0.1` → `::ffff`.
    s = s.slice(0, idx);
  }
  if (!s.includes(':')) {
    // only a v4 address
    if (v4Tail) {
      const big = ipv4ToBigInt(v4Tail);
      if (big === null) return null;
      // map into ::ffff:0:0/96? Actually a bare v4 becomes ::ffff:a.b.c.d for
      // IPv4-mapped. We treat bare-v4 input as the v4 address mapped.
      return (0xffffn << 32n) | big;
    }
    return null;
  }

  const doubleColon = s.indexOf('::');
  let head: string[];
  let tail: string[] = [];
  if (doubleColon >= 0) {
    head = doubleColon === 0 ? [] : s.slice(0, doubleColon).split(':');
    tail = doubleColon === s.length - 2 ? [] : s.slice(doubleColon + 2).split(':');
  } else {
    head = s.split(':');
  }
  // Filter empty segments: `::` in the middle leaves an empty string in
  // split() results (e.g. `1::2`.split(':') === ['1','','2']).
  head = head.filter((g) => g !== '');
  tail = tail.filter((g) => g !== '');

  let headLen = head.length;
  let tailLen = tail.length;
  // An embedded v4 tail occupies two hextets (e.g. ::ffff:192.0.2.1 has
  // hextets [ffff, c000:0201]). The v4 is appended as 32 bits at the end.
  if (v4Tail) {
    if (tailLen > 0) tailLen += 2;
    else headLen += 2;
  }
  const groups = 8;
  // `::` expands to (groups - headLen - tailLen) zero groups.
  const missing = groups - headLen - tailLen;
  if (missing < 0) return null;

  const numbers: number[] = [];
  for (const g of head) {
    const n = parseInt(g, 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    numbers.push(n);
  }
  for (let i = 0; i < missing; i++) numbers.push(0);
  for (const g of tail) {
    const n = parseInt(g, 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    numbers.push(n);
  }
  // With an embedded v4 tail, numbers holds 6 hextets; the v4 is appended as
  // the final 32 bits (the two remaining hextets).
  if (numbers.length !== (v4Tail ? groups - 2 : groups)) return null;

  let big = 0n;
  for (const n of numbers) {
    big = (big << 16n) | BigInt(n);
  }
  if (v4Tail) {
    const v4 = ipv4ToBigInt(v4Tail);
    if (v4 === null) return null;
    big = (big << 32n) | v4;
  }
  return big;
}

function ipv4ToBigInt(addr: string): bigint | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    const n = Number(p);
    if (!/^\d{1,3}$/.test(p) || n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}
