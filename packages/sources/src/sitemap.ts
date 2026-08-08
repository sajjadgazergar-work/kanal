/**
 * Sitemap.xml parsing (plan §8.1). Sitemap index files are flattened; a hard
 * cap of 200 new URLs per poll is enforced by the connector.
 */

import { XMLParser } from 'fast-xml-parser';
import type { SourceItemInput } from './types.js';

export interface SitemapUrl {
  loc: string;
  lastmod?: Date | null;
}

export interface SitemapIndex {
  urls: SitemapUrl[];
  /** Sub-sitemap URLs (sitemap index files). */
  subSitemaps: string[];
  isIndex: boolean;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

export function parseSitemap(xml: string): SitemapIndex {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error('XML parse error');
  }
  const root = (doc as Record<string, unknown>) ?? {};
  const urlset = root['urlset'] as Record<string, unknown> | undefined;
  const sitemapIndex = root['sitemapindex'] as Record<string, unknown> | undefined;

  if (urlset) {
    const urls: SitemapUrl[] = [];
    const raw = urlset['url'] as unknown;
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    for (const u of list) {
      const rec = u as Record<string, unknown>;
      if (!rec || typeof rec !== 'object') continue;
      const loc = coerce(rec['loc']);
      if (!loc) continue;
      const lastmodRaw = coerce(rec['lastmod']);
      const lastmod = lastmodRaw ? new Date(lastmodRaw) : null;
      urls.push({ loc, lastmod: lastmod && !Number.isNaN(lastmod.getTime()) ? lastmod : null });
    }
    return { urls, subSitemaps: [], isIndex: false };
  }

  if (sitemapIndex) {
    const subSitemaps: string[] = [];
    const raw = sitemapIndex['sitemap'] as unknown;
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    for (const s of list) {
      const rec = s as Record<string, unknown>;
      if (!rec || typeof rec !== 'object') continue;
      const loc = coerce(rec['loc']);
      if (loc) subSitemaps.push(loc);
    }
    return { urls: [], subSitemaps, isIndex: true };
  }

  throw new Error('Unrecognized sitemap format (expected <urlset> or <sitemapindex>)');
}

function coerce(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const txt = (value as Record<string, unknown>)['#text'];
    if (typeof txt === 'string') return txt;
  }
  return null;
}

/**
 * Build normalized items for URLs newer than a remembered `lastmod` watermark.
 * When a URL has no lastmod, it is always considered new (subject to the
 * connector's cap).
 */
export function sitemapItemsToInput(
  urls: SitemapUrl[],
  lastSeenLastmod: Date | null,
  cap = 200,
): SourceItemInput[] {
  const items: SourceItemInput[] = [];
  for (const u of urls) {
    if (items.length >= cap) break;
    if (u.lastmod && lastSeenLastmod && u.lastmod.getTime() <= lastSeenLastmod.getTime()) continue;
    items.push({
      rawUrl: u.loc,
      title: null,
      bodyText: '',
      publishedAt: u.lastmod,
    });
  }
  return items;
}
