import { describe, it, expect } from 'vitest';
import { canonicalizeUrl, canonicalizeWithDocument, canonicalHrefFromHtml, preferCanonicalLink, registrableDomain, hexToUuid } from '../url.js';
import { fixture } from './helpers.js';

describe('canonicalizeUrl — 7-step algorithm', () => {
  it('lowercases scheme and host', () => {
    expect(canonicalizeUrl('HTTP://Example.COM/Path')).toBe('http://example.com/Path');
  });

  it('strips default ports', () => {
    expect(canonicalizeUrl('https://example.com:443/a')).toBe('https://example.com/a');
    expect(canonicalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
    expect(canonicalizeUrl('http://example.com:8080/a')).toBe('http://example.com:8080/a');
  });

  it('strips tracking params and sorts remaining query params', () => {
    expect(canonicalizeUrl('https://example.com/a?b=2&a=1&utm_source=x&fbclid=abc&ref=nav&c='))
      .toBe('https://example.com/a?a=1&b=2');
  });

  it('drops empty query values', () => {
    expect(canonicalizeUrl('https://example.com/a?b=&c=1')).toBe('https://example.com/a?c=1');
  });

  it('strips the trailing slash unless path is root', () => {
    expect(canonicalizeUrl('https://example.com/a/')).toBe('https://example.com/a');
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('strips the fragment unless on a known SPA route', () => {
    expect(canonicalizeUrl('https://example.com/article?x=1#section')).toBe('https://example.com/article?x=1');
    expect(canonicalizeUrl('https://example.com/app#/settings', { spaPathPrefixes: ['/app'] }))
      .toBe('https://example.com/app#/settings');
    expect(canonicalizeUrl('https://example.com/app#/home', { spaPathPrefixes: ['/app'] }))
      .toBe('https://example.com/app#/home');
  });

  it('returns non-http(s) schemes unchanged', () => {
    expect(canonicalizeUrl('file:///etc/passwd')).toBe('file:///etc/passwd');
    expect(canonicalizeUrl('gopher://example.com')).toBe('gopher://example.com');
    expect(canonicalizeUrl('ftp://example.com/x')).toBe('ftp://example.com/x');
  });

  it('handles the full utm + ref + sort + trailing slash combination', () => {
    const input = 'https://example.com/story/?utm_source=rss&utm_medium=feed&b=2&a=1&gclid=g#frag';
    expect(canonicalizeUrl(input)).toBe('https://example.com/story?a=1&b=2');
  });
});

describe('canonical link handling', () => {
  it('extracts the canonical href from HTML', () => {
    const html = fixture('sample-page.html');
    expect(canonicalHrefFromHtml(html)).toBe('https://example.test/roundup?canonical=yes');
  });

  it('prefers a same-registrable-domain canonical link', () => {
    const base = canonicalizeUrl('https://example.test/roundup?utm_source=x');
    const canonical = canonicalizeUrl('https://example.test/roundup?canonical=yes');
    expect(preferCanonicalLink(base, canonical)).toBe('https://example.test/roundup?canonical=yes');
  });

  it('rejects a cross-domain canonical link (hostile canonicalization)', () => {
    const base = canonicalizeUrl('https://example.test/roundup');
    const hostile = canonicalizeUrl('https://evil.example/roundup');
    expect(preferCanonicalLink(base, hostile)).toBe('https://example.test/roundup');
  });

  it('handles a canonical link on a different subdomain of the same registrable domain', () => {
    // subdomain swap is same registrable domain → allowed
    const base = canonicalizeUrl('https://www.example.com/page');
    const canonical = canonicalizeUrl('https://cdn.example.com/page');
    expect(preferCanonicalLink(base, canonical)).toBe('https://cdn.example.com/page');
  });

  it('canonicalizeWithDocument applies the full algorithm', () => {
    const html = fixture('sample-page.html');
    const result = canonicalizeWithDocument('https://example.test/roundup?utm_source=test&a=1', html);
    expect(result).toBe('https://example.test/roundup?canonical=yes');
  });
});

describe('registrable domain', () => {
  it('returns eTLD+1', () => {
    expect(registrableDomain('www.example.com')).toBe('example.com');
    expect(registrableDomain('a.b.co.uk')).toBe('b.co.uk');
    expect(registrableDomain('x.github.io')).toBe('x.github.io');
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
  });

  it('handles IPs and single labels', () => {
    expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1');
    expect(registrableDomain('localhost')).toBe('localhost');
  });
});

describe('uuid hashing', () => {
  it('maps a sha256 hex to a uuid-shaped string', () => {
    const hex = 'a'.repeat(64);
    const uuid = hexToUuid(hex);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(hexToUuid(hex)).toBe(hexToUuid(hex));
  });
});
