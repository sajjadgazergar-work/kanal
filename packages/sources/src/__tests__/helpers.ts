import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  setTransport,
  setLookup,
  resetTransport,
  resetLookup,
  resetRobotsCache,
  type HttpTransport,
} from '../fetcher.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, '..', 'test-fixtures');

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export interface FakeRoute {
  /** exact path (with query) to match */
  path: string;
  status?: number;
  headers?: Record<string, string>;
  body: string;
  /** optional: count of times this route has been hit */
  hits?: { count: number };
}

/**
 * Build a fake HTTP transport from route tables. Host is matched first, then
 * path. Returns a transport and a hit counter.
 */
export function fakeTransport(
  routes: Array<{ host?: string; path: string; status?: number; headers?: Record<string, string>; body: string }>,
): { transport: HttpTransport; hits: Map<string, number> } {
  const hits = new Map<string, number>();
  const transport: HttpTransport = async (url, _opts) => {
    const u = new URL(url);
    const key = `${u.host}${u.pathname}${u.search}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    for (const r of routes) {
      const hostOk = r.host === undefined || r.host === u.host;
      if (!hostOk) continue;
      // route.path may be exact path+query, or a prefix ending with *
      if (r.path.endsWith('*')) {
        const prefix = r.path.slice(0, -1);
        if (!u.pathname.startsWith(prefix)) continue;
      } else {
        const routePath = r.path;
        const matches =
          routePath === u.pathname ||
          routePath === `${u.pathname}${u.search}` ||
          (routePath.startsWith(u.pathname) && routePath.endsWith(u.search));
        if (!matches) continue;
      }
      // 304 handling
      if (r.status === 304) {
        return { statusCode: 304, headers: { ...(r.headers ?? {}), 'etag': 'abc' }, body: Buffer.alloc(0) };
      }
      return {
        statusCode: r.status ?? 200,
        headers: { 'content-type': 'text/html; charset=utf-8', ...(r.headers ?? {}) },
        body: Buffer.from(r.body, 'utf8'),
      };
    }
    return { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') };
  };
  return { transport, hits };
}

export function withFakeFetch(routes: Array<{ host?: string; path: string; status?: number; headers?: Record<string, string>; body: string }>): () => void {
  const { transport } = fakeTransport(routes);
  setTransport(transport);
  setLookup(async (host) => {
    if (host === '127.0.0.1' || host === 'localhost') return ['127.0.0.1'];
    return ['93.184.216.34']; // example.com — a public address
  });
  resetRobotsCache();
  return () => {
    resetTransport();
    resetLookup();
    resetRobotsCache();
  };
}

export const NOW = new Date('2026-08-08T12:00:00Z');
