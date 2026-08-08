/**
 * RSS / Atom / JSONFeed / sitemap poll connectors (plan §8.1). All use
 * conditional GET; a 304 means no work.
 */

import { fetchDocument } from '../fetchDocument.js';
import { parseRssOrAtom, parseJsonFeed, type ParsedFeed } from '../feeds.js';
import { parseSitemap, sitemapItemsToInput, type SitemapUrl } from '../sitemap.js';
import type { ConnectorContext, PollResult } from '../types.js';

function resultFromFeed(
  parsed: ParsedFeed,
  doc: Awaited<ReturnType<typeof fetchDocument>>,
): PollResult {
  return {
    items: parsed.items,
    notModified: doc.fetch.notModified,
    httpStatus: doc.fetch.status,
    contentBytes: doc.fetch.body.length,
    etag: doc.fetch.headers['etag'] ?? null,
    lastModified: doc.fetch.headers['last-modified'] ?? null,
  };
}

/**
 * Poll an RSS/Atom feed.
 */
export async function pollFeed(
  url: string,
  ctx: ConnectorContext = {},
): Promise<PollResult> {
  const doc = await fetchDocument(url, {
    etag: ctx.etag,
    lastModified: ctx.lastModified,
    spaPathPrefixes: ctx.spaPathPrefixes,
    extract: false,
  });
  if (doc.fetch.notModified) {
    return {
      items: [],
      notModified: true,
      etag: doc.fetch.headers['etag'] ?? null,
      lastModified: doc.fetch.headers['last-modified'] ?? null,
    };
  }
  const parsed = parseRssOrAtom(doc.html);
  return resultFromFeed(parsed, doc);
}

/**
 * Poll a JSONFeed endpoint.
 */
export async function pollJsonFeed(
  url: string,
  ctx: ConnectorContext = {},
): Promise<PollResult> {
  const doc = await fetchDocument(url, {
    etag: ctx.etag,
    lastModified: ctx.lastModified,
    spaPathPrefixes: ctx.spaPathPrefixes,
    extract: false,
  });
  if (doc.fetch.notModified) {
    return {
      items: [],
      notModified: true,
      etag: doc.fetch.headers['etag'] ?? null,
      lastModified: doc.fetch.headers['last-modified'] ?? null,
    };
  }
  const parsed = parseJsonFeed(doc.html);
  return resultFromFeed(parsed, doc);
}

export const SITEMAP_CAP = 200;

/**
 * Poll a sitemap: fetch the sitemap (or index, flattened), diff by lastmod,
 * and emit up to `cap` new URLs. The cap is hard per poll.
 */
export async function pollSitemap(
  url: string,
  lastSeenLastmod: Date | null,
  ctx: ConnectorContext = {},
): Promise<PollResult> {
  const doc = await fetchDocument(url, {
    etag: ctx.etag,
    lastModified: ctx.lastModified,
    extract: false,
  });
  if (doc.fetch.notModified) {
    return {
      items: [],
      notModified: true,
      etag: doc.fetch.headers['etag'] ?? null,
      lastModified: doc.fetch.headers['last-modified'] ?? null,
    };
  }
  const parsed = parseSitemap(doc.html);
  let urls: SitemapUrl[] = parsed.urls;

  // Flatten a sitemap index: fetch each sub-sitemap (recursion depth limited).
  if (parsed.isIndex) {
    const collected: SitemapUrl[] = [];
    for (const sub of parsed.subSitemaps.slice(0, 20)) {
      if (collected.length >= SITEMAP_CAP) break;
      try {
        const subDoc = await fetchDocument(sub, { extract: false, honorRobots: false });
        const subParsed = parseSitemap(subDoc.html);
        collected.push(...subParsed.urls);
      } catch {
        // A broken sub-sitemap is skipped, not fatal.
      }
    }
    urls = collected;
  }

  const items = sitemapItemsToInput(urls, lastSeenLastmod, SITEMAP_CAP);
  return {
    items,
    httpStatus: doc.fetch.status,
    contentBytes: doc.fetch.body.length,
    etag: doc.fetch.headers['etag'] ?? null,
    lastModified: doc.fetch.headers['last-modified'] ?? null,
  };
}
