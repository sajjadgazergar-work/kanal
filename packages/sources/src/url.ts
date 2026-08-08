import { domainToASCII } from 'node:url';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';

/**
 * URL canonicalization (plan §8.3) plus hashing helpers.
 *
 * The canonical URL algorithm, in order:
 *   1. Lowercase scheme and host; strip default ports; punycode-normalize the host.
 *   2. Follow redirects to a maximum of 5 hops (done by the fetcher, not here).
 *   3. If the document has `<link rel="canonical">` on the same registrable
 *      domain, prefer it (same-domain check prevents a hostile page from
 *      canonicalizing itself onto someone else's URL).
 *   4. Strip tracking parameters: utm_*, fbclid, gclid, mc_cid, mc_eid, igshid,
 *      ref, ref_src, s, _hsenc, _hsmi, yclid.
 *   5. Sort remaining query parameters lexicographically; drop empty values.
 *   6. Strip the fragment unless the path is a known SPA route pattern.
 *   7. Strip a trailing slash unless the path is `/`.
 */

const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443' };

export const TRACKING_PARAMS = new Set<string>([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref',
  'ref_src',
  's',
  '_hsenc',
  '_hsmi',
  'yclid',
]);

/**
 * Multi-label public suffixes. A registrable domain is eTLD+1: for these
 * suffixes the registrable domain takes three labels, otherwise two. This is a
 * heuristic approximation of the Public Suffix List (we deliberately add no
 * PSL dependency); the security-relevant consequence is that the canonical-link
 * same-domain check can under-merge (harmless) but never treat two unrelated
 * sites as the same domain when they are in fact under a shared suffix here.
 */
const COMPOUND_SUFFIXES = new Set<string>([
  // country-coded second levels
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'ad.jp', 'go.jp',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'edu.in', 'gov.in',
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.tw', 'org.tw', 'co.kr', 'or.kr', 'ne.kr', 're.kr', 'pe.kr', 'go.kr',
  'com.mx', 'org.mx', 'gob.mx', 'co.za', 'org.za', 'com.tr', 'org.tr', 'net.tr', 'gov.tr',
  'co.il', 'org.il', 'ac.il', 'gov.il', 'co.ir', 'com.ir', 'net.ir', 'org.ir', 'ac.ir',
  'com.sg', 'org.sg', 'co.th', 'or.th', 'ac.th', 'go.th', 'com.hk', 'org.hk',
  'com.eg', 'org.eg', 'com.sa', 'org.sa', 'com.ua', 'org.ua', 'com.pl', 'com.ru', 'org.ru',
  'com.ar', 'com.bo', 'com.cl', 'com.pe', 'org.pe', 'com.py', 'com.uy', 'com.ec',
  'com.gt', 'com.do', 'com.co', 'com.ve', 'com.pt', 'com.vn', 'com.my', 'com.ph',
  'com.pk', 'com.bd', 'com.np', 'com.ng', 'co.ke', 'co.tz', 'com.gh', 'com.ng',
  'com.by', 'com.ge', 'com.am', 'com.az', 'com.kz', 'com.uz', 'com.hr', 'com.si',
  // platform / user-content suffixes — where two DIFFERENT registrants can
  // collide if we naively take only two labels
  'github.io', 'gitlab.io', 'gitbook.io', 'readthedocs.io', 'blogspot.com',
  'wordpress.com', 'medium.com', 'wixsite.com', 'squarespace.com', 'webflow.io',
  'netlify.app', 'vercel.app', 'firebaseapp.com', 'web.app', 'pages.dev',
  'surge.sh', 'herokuapp.com', 'onrender.com', 'glitch.me', 'repl.co',
  'railway.app', 'cloudfront.net', 'azurewebsites.net', 'azurestaticapps.net',
  'appspot.com', 'godaddysites.com', 'myshopify.com', 'weebly.com',
  'strikingly.com', 'notion.site', 'substack.com', 'beehiiv.com', 'ghost.io',
  'tumblr.com', 'mytumblr.com', 'typepad.com', 'blogger.com', 'blogspot.in',
  'blogspot.fr', 'blogspot.de', 'blogspot.it', 'blogspot.es', 'blogspot.ca',
  'blogspot.co.uk', 'w3spaces.com', 'micro.blog', 'liara.run', 'deno.dev',
]);

export interface CanonicalizeOptions {
  /** Path prefixes for which the fragment is preserved (known SPA routes). */
  spaPathPrefixes?: string[];
}

export function isIpLike(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * eTLD+1 approximation for the canonical-link same-domain check.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (isIpLike(host) || !host.includes('.')) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (COMPOUND_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}

/**
 * sha256 hex digest (lowercase, 64 chars).
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Map a sha256 hex digest onto the UUID space (first 16 bytes) so it can be
 * stored in a `uuid` column (plan §6.2 — sha256(canonical_url) kept as uuid in
 * V1 for index locality).
 */
export function hexToUuid(hex: string): string {
  const h = hex.replace(/[^0-9a-f]/gi, '').slice(0, 32).padEnd(32, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * The 7-step canonicalization algorithm for http(s) URLs. Non-http(s) inputs
 * are returned unchanged (they cannot be fetched and are not dedup candidates).
 */
export function canonicalizeUrl(input: string, opts: CanonicalizeOptions = {}): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input;
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return input;

  // Step 1 — lowercase scheme/host, punycode host, strip default port.
  let host = u.hostname.toLowerCase();
  if (!host.includes(':') && !isIpLike(host)) {
    try {
      host = domainToASCII(host);
    } catch {
      // keep host as-is if punycode conversion fails
    }
  }
  let port = '';
  if (u.port) {
    const dp = DEFAULT_PORTS[scheme];
    port = dp && u.port === dp ? '' : `:${u.port}`;
  }

  // Steps 4–5 — strip tracking params, sort remaining, drop empty values.
  const kept: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) {
    const key = k.toLowerCase();
    if (key.startsWith('utm_')) continue;
    if (TRACKING_PARAMS.has(key)) continue;
    if (v === '') continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const qs = new URLSearchParams();
  for (const [k, v] of kept) qs.append(k, v);
  const query = qs.toString();

  // Step 7 — strip trailing slash unless path is `/`.
  let path = u.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  // Step 6 — strip fragment unless the path is a known SPA route.
  let fragment = '';
  if (u.hash) {
    const spa = (opts.spaPathPrefixes ?? []).some((p) => path.startsWith(p));
    if (spa) fragment = u.hash;
  }

  let out = `${scheme}://${host}${port}${path}`;
  if (query) out += `?${query}`;
  if (fragment) out += fragment;
  return out;
}

/**
 * Extract the `<link rel="canonical">` href from an HTML document, if any.
 */
export function canonicalHrefFromHtml(html: string): string | null {
  try {
    const $ = load(html);
    return $('link[rel~="canonical"]').first().attr('href') ?? null;
  } catch {
    return null;
  }
}

/**
 * Prefer a same-registrable-domain `<link rel="canonical">` target over the
 * fetched URL (plan §8.3 step 3). The same-domain guard is the security
 * boundary: a hostile page must not be able to canonicalize onto a URL outside
 * its own registrable domain.
 */
export function preferCanonicalLink(
  fetchedUrl: string,
  canonicalHref: string | null,
  opts: CanonicalizeOptions = {},
): string {
  const base = canonicalizeUrl(fetchedUrl, opts);
  if (!canonicalHref) return base;
  let target: string;
  try {
    target = canonicalizeUrl(new URL(canonicalHref, fetchedUrl).toString(), opts);
  } catch {
    return base;
  }
  try {
    const a = registrableDomain(new URL(base).hostname);
    const b = registrableDomain(new URL(target).hostname);
    if (a && b && a === b) return target;
  } catch {
    return base;
  }
  return base;
}

/**
 * Full canonicalization over a fetched document: canonicalize the fetched URL,
 * then apply the same-domain canonical link preference, then canonicalize the
 * result again.
 */
export function canonicalizeWithDocument(
  fetchedUrl: string,
  html: string | null,
  opts: CanonicalizeOptions = {},
): string {
  const href = html ? canonicalHrefFromHtml(html) : null;
  return preferCanonicalLink(fetchedUrl, href, opts);
}
