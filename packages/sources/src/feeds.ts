/**
 * RSS / Atom / JSONFeed parsing with fast-xml-parser (plan §8.1). Each parser
 * produces normalized `SourceItemInput`-shaped records.
 */

import { XMLParser } from 'fast-xml-parser';
import { normalizeText, normalizeTitle } from './text.js';
import type { SourceItemInput } from './types.js';

export interface ParsedFeed {
  kind: 'rss' | 'atom' | 'jsonfeed';
  items: SourceItemInput[];
  /** Feed-level title (channel/feed title), when available. */
  feedTitle?: string | null;
}

function toDate(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return new Date(value * 1000);
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function coerceString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    // fast-xml-parser returns { '#text': ... } for elements with attributes.
    const txt = (value as Record<string, unknown>)['#text'];
    if (typeof txt === 'string') return txt;
    return null;
  }
  return null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

export function parseRssOrAtom(xml: string): ParsedFeed {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error('XML parse error');
  }
  const root = (doc as Record<string, unknown>) ?? {};
  if (root['rss']) return parseRss(root['rss'] as Record<string, unknown>);
  if (root['feed']) return parseAtom(root['feed'] as Record<string, unknown>);
  throw new Error('Unrecognized feed format (expected <rss> or <feed>)');
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function parseRss(rss: Record<string, unknown>): ParsedFeed {
  const channel = rss['channel'] as Record<string, unknown> | undefined;
  if (!channel) throw new Error('RSS missing <channel>');
  const feedTitle = coerceString(channel['title']);
  const itemsRaw = channel['item'] as unknown;
  const items: SourceItemInput[] = [];

  for (const it of asArray(itemsRaw as Record<string, unknown> | Record<string, unknown>[])) {
    if (typeof it !== 'object' || it === null) continue;
    const link = rssItemLink(it);
    if (!link) continue;
    const rawUrl = link;
    const description = coerceString(it['description']) ?? coerceString(it['summary']) ?? '';
    const content = coerceString(it['content:encoded']) ?? coerceString(it['content']) ?? description;
    const title = normalizeTitle(coerceString(it['title']));
    const pubDate = toDate(coerceString(it['pubDate']) ?? coerceString(it['dc:date']) ?? coerceString(it['published']));

    items.push({
      rawUrl,
      title,
      bodyText: normalizeText(`${title ?? ''} ${content}`),
      publishedAt: pubDate,
      lang: coerceString(it['dc:language']) ?? undefined,
      metadata: { description: normalizeText(description) },
    });
  }

  return { kind: 'rss', items, feedTitle };
}

/**
 * Resolve the link for an RSS item: <link> text or href, else <guid>.
 */
function rssItemLink(item: Record<string, unknown>): string | null {
  const link = item['link'];
  const linkStr = coerceString(link) ?? (typeof link === 'object' ? coerceString((link as Record<string, unknown>)['#text']) : null);
  if (linkStr) return linkStr;
  const guid = item['guid'];
  const guidStr = coerceString(guid) ?? (typeof guid === 'object' ? coerceString((guid as Record<string, unknown>)['#text']) : null);
  return guidStr;
}

function parseAtom(feed: Record<string, unknown>): ParsedFeed {
  const feedTitle = coerceString(feed['title']);
  const entriesRaw = feed['entry'] as unknown;
  const items: SourceItemInput[] = [];

  for (const e of asArray(entriesRaw as Record<string, unknown> | Record<string, unknown>[])) {
    if (typeof e !== 'object' || e === null) continue;
    const link = atomLinkHref(e['link']);
    if (!link) continue;
    const title = normalizeTitle(coerceString(e['title']));
    const content = coerceString(e['content']) ?? coerceString(e['summary']) ?? '';
    const publishedAt = toDate(coerceString(e['published']) ?? coerceString(e['updated']));
    const author = atomAuthor(e['author']);

    items.push({
      rawUrl: link,
      title,
      bodyText: normalizeText(`${title ?? ''} ${content}`),
      publishedAt,
      lang: coerceString(e['xml:lang']) ?? undefined,
      metadata: { author, description: normalizeText(coerceString(e['summary']) ?? '') },
    });
  }

  return { kind: 'atom', items, feedTitle };
}

function atomLinkHref(link: unknown): string | null {
  if (Array.isArray(link)) {
    // Prefer rel=alternate (or first rel-less) link.
    const withRel = link.find((l) => {
      const rec = l as Record<string, unknown>;
      return rec['@_rel'] === 'alternate' || rec['@_rel'] === undefined;
    });
    const chosen = withRel ?? link[0];
    return typeof (chosen as Record<string, unknown>)?.['@_href'] === 'string'
      ? (chosen as Record<string, unknown>)['@_href'] as string
      : null;
  }
  if (typeof link === 'object' && link !== null) {
    return typeof (link as Record<string, unknown>)['@_href'] === 'string'
      ? ((link as Record<string, unknown>)['@_href'] as string)
      : null;
  }
  return null;
}

function atomAuthor(author: unknown): string | null {
  if (!author || typeof author !== 'object') return null;
  const name = coerceString((author as Record<string, unknown>)['name']);
  return name;
}

// ---- JSONFeed ----

export interface JsonFeedItem {
  id?: string;
  url?: string;
  external_url?: string;
  title?: string;
  content_html?: string;
  content_text?: string;
  summary?: string;
  date_published?: string;
  date_modified?: string;
  author?: { name?: string };
  language?: string;
  [key: string]: unknown;
}

export function parseJsonFeed(json: string): ParsedFeed {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('JSON parse error');
  }
  const feed = data as Record<string, unknown>;
  if (!feed || typeof feed !== 'object') throw new Error('JSONFeed root must be an object');
  const version = String(feed['version'] ?? '');
  if (!version.startsWith('https://jsonfeed.org/')) {
    throw new Error(`Not a JSONFeed document (version=${version})`);
  }
  const items: SourceItemInput[] = [];
  const rawItems = Array.isArray(feed['items']) ? (feed['items'] as JsonFeedItem[]) : [];
  for (const it of rawItems) {
    const rawUrl = it.url ?? it.external_url ?? it.id;
    if (!rawUrl) continue;
    const contentText = it.content_text ?? stripHtml(it.content_html ?? '') ?? '';
    const title = normalizeTitle(it.title);
    const publishedAt = toDate(it.date_published ?? it.date_modified);
    items.push({
      rawUrl: String(rawUrl),
      title,
      bodyText: normalizeText(`${title ?? ''} ${contentText}`),
      publishedAt,
      lang: it.language ?? undefined,
      metadata: {
        summary: normalizeText(it.summary ?? ''),
        author: it.author?.name,
      },
    });
  }
  return {
    kind: 'jsonfeed',
    items,
    feedTitle: coerceString(feed['title']),
  };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
}
