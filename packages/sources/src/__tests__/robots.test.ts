import { describe, it, expect, afterEach } from 'vitest';
import { parseRobots, robotsPathAllowed, safeFetch, setTransport, setLookup, resetTransport, resetLookup, resetRobotsCache } from '../fetcher.js';

afterEach(() => {
  resetTransport();
  resetLookup();
  resetRobotsCache();
});

describe('robots.txt parser', () => {
  it('allows everything when no robots file', () => {
    const rule = parseRobots('');
    expect(rule.allowed).toBe(true);
  });

  it('blocks "/" under a wildcard Disallow', () => {
    const rule = parseRobots('User-agent: *\nDisallow: /');
    expect(rule.allowed).toBe(false);
    expect(robotsPathAllowed(rule, '/anything')).toBe(false);
  });

  it('blocks specific paths', () => {
    const rule = parseRobots('User-agent: *\nDisallow: /private/');
    expect(rule.allowed).toBe(true);
    expect(robotsPathAllowed(rule, '/private/data')).toBe(false);
    expect(robotsPathAllowed(rule, '/public/data')).toBe(true);
  });

  it('Allow overrides Disallow', () => {
    const rule = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public.html');
    expect(robotsPathAllowed(rule, '/private/public.html')).toBe(true);
    expect(robotsPathAllowed(rule, '/private/secret.html')).toBe(false);
  });

  it('a specific agent group wins over wildcard', () => {
    const rule = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: kanal\nAllow: /');
    expect(robotsPathAllowed(rule, '/anything')).toBe(true);
  });

  it('empty Disallow means allow all', () => {
    const rule = parseRobots('User-agent: *\nDisallow:');
    expect(rule.allowed).toBe(true);
    expect(robotsPathAllowed(rule, '/x')).toBe(true);
  });

  it('ignores comments', () => {
    const rule = parseRobots('# comment\nUser-agent: *\n# another\nDisallow: /admin');
    expect(robotsPathAllowed(rule, '/admin')).toBe(false);
  });
});

describe('safeFetch honours robots.txt', () => {
  it('refuses a path disallowed by robots.txt', async () => {
    setLookup(async () => ['93.184.216.34']);
    setTransport(async (url) => {
      if (url === 'http://example.com/robots.txt') {
        return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: *\nDisallow: /admin') };
      }
      return { statusCode: 200, headers: {}, body: Buffer.from('page') };
    });
    await expect(safeFetch('http://example.com/admin/secret', {})).rejects.toMatchObject({ kind: 'robots' });
  });

  it('allows a path not disallowed by robots.txt', async () => {
    setLookup(async () => ['93.184.216.34']);
    setTransport(async (url) => {
      if (url === 'http://example.com/robots.txt') {
        return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: *\nDisallow: /admin') };
      }
      return { statusCode: 200, headers: {}, body: Buffer.from('page') };
    });
    const res = await safeFetch('http://example.com/public/page', {});
    expect(res.status).toBe(200);
  });

  it('allows when robots.txt is 404', async () => {
    setLookup(async () => ['93.184.216.34']);
    setTransport(async (url) => {
      if (url === 'http://example.com/robots.txt') {
        return { statusCode: 404, headers: {}, body: Buffer.from('nope') };
      }
      return { statusCode: 200, headers: {}, body: Buffer.from('page') };
    });
    const res = await safeFetch('http://example.com/anything', {});
    expect(res.status).toBe(200);
  });

  it('can be disabled with honorRobots: false', async () => {
    setLookup(async () => ['93.184.216.34']);
    setTransport(async (url) => {
      if (url === 'http://example.com/robots.txt') {
        return { statusCode: 200, headers: {}, body: Buffer.from('User-agent: *\nDisallow: /') };
      }
      return { statusCode: 200, headers: {}, body: Buffer.from('page') };
    });
    const res = await safeFetch('http://example.com/blocked', {}, { honorRobots: false });
    expect(res.status).toBe(200);
  });
});
