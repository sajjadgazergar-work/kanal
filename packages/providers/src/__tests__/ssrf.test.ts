import { describe, expect, it } from 'vitest';
import {
  checkSsrf,
  checkHost,
  isDeniedIp,
  ipInBlocks,
  DEFAULT_PRIVATE_IPV4_BLOCKS,
  DEFAULT_PRIVATE_IPV6_BLOCKS,
  BLOCKED_URL_SCHEMES,
} from '../ssrf.js';

/** A fake resolver: no network, maps a host to a literal IP. */
const literal = (ip: string) => async () => [ip];
const multi = (ips: string[]) => async () => ips;

describe('SSRF deny-list (plan §16.2 #6 #7)', () => {
  it('blocks cloud metadata 169.254.169.254', async () => {
    const r = await checkSsrf('http://169.254.169.254/latest/meta-data', { allowPrivate: false }, literal('169.254.169.254'));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ip_denied');
  });

  it('blocks localhost and 127.x loopback', async () => {
    expect((await checkSsrf('http://localhost/ollama', { allowPrivate: false }, literal('127.0.0.1'))).allowed).toBe(false);
    expect((await checkSsrf('http://127.0.0.1:8000/v1/models', { allowPrivate: false }, literal('127.0.0.1'))).allowed).toBe(false);
  });

  it('blocks RFC1918 10.x, 172.16.x, 192.168.x', async () => {
    for (const ip of ['10.0.0.5', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1']) {
      expect(isDeniedIp(ip, { allowPrivate: false }), ip).toBe(true);
    }
  });

  it('blocks link-local and CGNAT', async () => {
    expect(isDeniedIp('169.254.0.1', { allowPrivate: false })).toBe(true);
    expect(isDeniedIp('100.64.0.1', { allowPrivate: false })).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 (::ffff:169.254.169.254)', async () => {
    expect(isDeniedIp('::ffff:169.254.169.254', { allowPrivate: false })).toBe(true);
  });

  it('blocks IPv6 ULA and link-local', async () => {
    expect(isDeniedIp('fc00::1', { allowPrivate: false })).toBe(true);
    expect(isDeniedIp('fd12:3456:789a::1', { allowPrivate: false })).toBe(true);
    expect(isDeniedIp('fe80::1', { allowPrivate: false })).toBe(true);
  });

  it('blocks loopback IPv6 ::1', async () => {
    expect(isDeniedIp('::1', { allowPrivate: false })).toBe(true);
  });

  it('allows public addresses', async () => {
    expect(isDeniedIp('8.8.8.8', { allowPrivate: false })).toBe(false);
    expect(isDeniedIp('93.184.216.34', { allowPrivate: false })).toBe(false);
    expect(isDeniedIp('2606:2800:220:1:248:1893:25c8:1946', { allowPrivate: false })).toBe(false);
  });

  it('resolves a hostname then blocks a private resolved IP', async () => {
    const r = await checkSsrf('http://api.example.com/v1/models', { allowPrivate: false }, literal('10.1.2.3'));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ip_denied');
    expect(r.resolvedIps).toEqual(['10.1.2.3']);
    expect(r.hostname).toBe('api.example.com');
  });

  it('rejects file:, gopher:, ftp: schemes', async () => {
    expect(BLOCKED_URL_SCHEMES).toContain('file:');
    expect(BLOCKED_URL_SCHEMES).toContain('gopher:');
    expect(BLOCKED_URL_SCHEMES).toContain('ftp:');
    for (const scheme of ['file', 'gopher', 'ftp']) {
      const r = await checkSsrf(`${scheme}://example.com/x`, { allowPrivate: false }, literal('1.2.3.4'));
      expect(r.allowed, scheme).toBe(false);
      expect(r.reason).toBe('scheme_blocked');
    }
  });

  it('checkHost works on the raw host with a mocked resolver', async () => {
    const r = await checkHost('internal.corp', { allowPrivate: false }, literal('192.168.0.10'));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ip_denied');
  });

  it('multi-address resolution blocks when ANY address is denied', async () => {
    const r = await checkSsrf('http://dual.example.com', { allowPrivate: false }, multi(['8.8.8.8', '10.0.0.1']));
    expect(r.allowed).toBe(false);
  });

  it('KANAL_ALLOW_PRIVATE_PROVIDERS opt-in permits private providers but keeps metadata blocked', () => {
    // Local Ollama: opt-in permits loopback/RFC1918.
    expect(isDeniedIp('127.0.0.1', { allowPrivate: true })).toBe(false);
    expect(isDeniedIp('10.0.0.5', { allowPrivate: true })).toBe(false);
    // Cloud metadata stays denied even with the opt-in.
    expect(isDeniedIp('169.254.169.254', { allowPrivate: true })).toBe(true);
  });

  it('public IP passes the full check', async () => {
    const r = await checkSsrf('https://api.openai.com/v1/models', { allowPrivate: false }, literal('104.18.1.1'));
    expect(r.allowed).toBe(true);
  });

  it('ipInBlocks is consistent with isDeniedIp', () => {
    expect(ipInBlocks('10.0.0.1', DEFAULT_PRIVATE_IPV4_BLOCKS)).toBe(true);
    expect(ipInBlocks('fc00::1', DEFAULT_PRIVATE_IPV6_BLOCKS)).toBe(true);
  });
});
