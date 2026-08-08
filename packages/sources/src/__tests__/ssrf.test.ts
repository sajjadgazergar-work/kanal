import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isDeniedIp, isPrivateIpv4, isPrivateIpv6, ipv6ToBigInt } from '../ip.js';
import { safeFetch, FetchError, resolveAndCheck, setTransport, setLookup, resetTransport, resetLookup, resetRobotsCache } from '../fetcher.js';

describe('IP deny-list', () => {
  it('denies RFC1918 ranges', () => {
    expect(isDeniedIp('10.0.0.1')).toBe(true);
    expect(isDeniedIp('172.16.0.1')).toBe(true);
    expect(isDeniedIp('172.31.255.255')).toBe(true);
    expect(isDeniedIp('192.168.1.1')).toBe(true);
  });

  it('denies loopback, link-local, CGNAT', () => {
    expect(isDeniedIp('127.0.0.1')).toBe(true);
    expect(isDeniedIp('127.0.0.2')).toBe(true);
    expect(isDeniedIp('169.254.169.254')).toBe(true); // cloud metadata
    expect(isDeniedIp('100.64.0.1')).toBe(true);
    expect(isDeniedIp('100.127.255.254')).toBe(true);
  });

  it('allows public addresses', () => {
    expect(isDeniedIp('8.8.8.8')).toBe(false);
    expect(isDeniedIp('93.184.216.34')).toBe(false);
    expect(isDeniedIp('1.1.1.1')).toBe(false);
  });

  it('denies IPv6 loopback, ULA, link-local, mapped v4', () => {
    expect(isDeniedIp('::1')).toBe(true);
    expect(isDeniedIp('::')).toBe(true);
    expect(isDeniedIp('fc00::1')).toBe(true);
    expect(isDeniedIp('fd00::1')).toBe(true);
    expect(isDeniedIp('fe80::1')).toBe(true);
    expect(isDeniedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isDeniedIp('::ffff:10.0.0.1')).toBe(true);
    expect(isDeniedIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('denies NAT64 64:ff9b::/96 embedded private v4', () => {
    expect(isDeniedIp('64:ff9b::a00:1')).toBe(true); // 10.0.0.1
    expect(isDeniedIp('64:ff9b::808:808')).toBe(false); // 8.8.8.8
  });

  it('is privateIpv4 correct for boundaries', () => {
    expect(isPrivateIpv4([172, 15, 0, 1])).toBe(false);
    expect(isPrivateIpv4([172, 16, 0, 1])).toBe(true);
    expect(isPrivateIpv4([172, 32, 0, 1])).toBe(false);
    expect(isPrivateIpv4([100, 63, 0, 1])).toBe(false);
    expect(isPrivateIpv4([100, 64, 0, 1])).toBe(true);
  });

  it('ipv6ToBigInt parses compressed forms', () => {
    expect(ipv6ToBigInt('::1')).toBe(1n);
    expect(ipv6ToBigInt('::')).toBe(0n);
    expect(ipv6ToBigInt('::ffff:127.0.0.1')).toBe(0xffffn * (1n << 32n) + 0x7f000001n);
    expect(ipv6ToBigInt('fe80::1')).not.toBeNull();
    expect(isPrivateIpv6(ipv6ToBigInt('fd00::1')!)).toBe(true);
  });
});

describe('SSRF-safe fetch', () => {
  beforeEach(() => {
    setTransport(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('ok'),
    }));
    resetLookup();
    resetRobotsCache();
  });
  afterEach(() => {
    resetTransport();
    resetLookup();
    resetRobotsCache();
  });

  it('rejects literal private IPs before any fetch', async () => {
    setLookup(async () => ['127.0.0.1']);
    await expect(safeFetch('http://127.0.0.1/admin', {}, { honorRobots: false })).rejects.toMatchObject({ kind: 'denied' });
    await expect(safeFetch('http://169.254.169.254/latest/meta-data', {}, { honorRobots: false })).rejects.toMatchObject({ kind: 'denied' });
  });

  it('rejects hosts that resolve to private IPs', async () => {
    setLookup(async (host) => {
      if (host === 'metadata.internal') return ['169.254.169.254'];
      if (host === 'internal.example') return ['10.0.0.5'];
      return ['93.184.216.34'];
    });
    await expect(safeFetch('http://metadata.internal/latest', {}, { honorRobots: false })).rejects.toMatchObject({ kind: 'denied' });
    await expect(safeFetch('http://internal.example/x', {}, { honorRobots: false })).rejects.toMatchObject({ kind: 'denied' });
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(safeFetch('file:///etc/passwd', {}, { honorRobots: false })).rejects.toMatchObject({ kind: 'scheme' });
    await expect(safeFetch('gopher://example.com', {}, { honorRobots: false })).rejects.toMatchObject({ kind: 'scheme' });
    await expect(safeFetch('ftp://example.com', {}, { honorRobots: false })).rejects.toMatchObject({ kind: 'scheme' });
  });

  it('re-checks the deny-list after a redirect hop', async () => {
    setLookup(async (host) => {
      if (host === 'public.example') return ['93.184.216.34'];
      if (host === 'internal.example') return ['10.0.0.5'];
      return ['93.184.216.34'];
    });
    setTransport(async (url) => {
      if (url === 'http://public.example/start') {
        return { statusCode: 302, headers: { location: 'http://internal.example/admin' }, body: Buffer.alloc(0) };
      }
      return { statusCode: 200, headers: {}, body: Buffer.from('ok') };
    });
    await expect(safeFetch('http://public.example/start', {}, { honorRobots: false })).rejects.toMatchObject({ kind: 'denied' });
  });

  it('allows public hosts to fetch', async () => {
    setLookup(async () => ['93.184.216.34']);
    setTransport(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('hello'),
    }));
    const res = await safeFetch('http://example.com/page', {}, { honorRobots: false });
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('hello');
  });

  it('resolveAndCheck throws denied when all addresses are private', async () => {
    setLookup(async () => ['10.0.0.1', '127.0.0.1']);
    await expect(resolveAndCheck('host')).rejects.toMatchObject({ kind: 'denied' });
  });

  it('times out on redirect loops', async () => {
    setLookup(async () => ['93.184.216.34']);
    setTransport(async (url) => ({
      statusCode: 302,
      headers: { location: url }, // infinite loop
      body: Buffer.alloc(0),
    }));
    await expect(safeFetch('http://example.com/a', {}, { honorRobots: false })).rejects.toMatchObject({ kind: 'too_many_redirects' });
  });

  it('enforces the response size cap', async () => {
    setLookup(async () => ['93.184.216.34']);
    setTransport(async () => ({
      statusCode: 200,
      headers: {},
      body: Buffer.alloc(1024 * 1024 * 5), // 5 MB > 4 MB cap
    }));
    await expect(safeFetch('http://example.com/big', {}, { honorRobots: false })).rejects.toMatchObject({ kind: 'oversize' });
  });
});

describe('FetchError kind checks', () => {
  it('has a typed kind', () => {
    expect(new FetchError('denied', 'no').kind).toBe('denied');
  });
});
