/**
 * API-style connectors (plan §8.1): reddit_json, youtube_rss, hn_algolia, arxiv.
 * All parse JSON or XML payloads already in hand — the fetcher is injected so
 * the unit suite runs with NO network.
 */

import { parseRssOrAtom } from '../feeds.js';
import { normalizeText, normalizeTitle } from '../text.js';
import type { ConnectorContext, PollResult, SourceItemInput } from '../types.js';

export interface RawFetch {
  (url: string, ctx?: ConnectorContext): Promise<{ status: number; body: string }>;
}

const jsonFetch: RawFetch = async (url, ctx = {}) => {
  const { fetchDocument } = await import('../fetchDocument.js');
  const doc = await fetchDocument(url, {
    etag: ctx.etag,
    lastModified: ctx.lastModified,
    extract: false,
  });
  return { status: doc.fetch.status, body: doc.html };
};

// ---- reddit_json ----

export interface RedditJsonPost {
  data?: {
    title?: string;
    selftext?: string;
    url?: string;
    permalink?: string;
    created_utc?: number;
    subreddit?: string;
    domain?: string;
  };
  [key: string]: unknown;
}

export function parseRedditJson(body: string): SourceItemInput[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('JSON parse error');
  }
  // Reddit listing: { data: { children: [ { data: {...} } ] } }
  const root = data as { data?: { children?: RedditJsonPost[] } };
  const children = root.data?.children ?? [];
  const items: SourceItemInput[] = [];
  for (const child of children) {
    const d = child?.data;
    if (!d) continue;
    const rawUrl = d.url ?? `https://www.reddit.com${d.permalink ?? ''}`;
    if (!rawUrl) continue;
    const title = normalizeTitle(d.title);
    const body = normalizeText(`${title ?? ''} ${d.selftext ?? ''}`);
    items.push({
      rawUrl,
      title,
      bodyText: body,
      publishedAt: d.created_utc ? new Date(d.created_utc * 1000) : null,
      metadata: { subreddit: d.subreddit, domain: d.domain },
    });
  }
  return items;
}

export async function pollRedditJson(
  url: string,
  ctx: ConnectorContext = {},
  fetchImpl: RawFetch = jsonFetch,
): Promise<PollResult> {
  const res = await fetchImpl(url, ctx);
  const items = parseRedditJson(res.body);
  return { items, httpStatus: res.status };
}

// ---- youtube_rss ----

export async function pollYoutubeRss(
  url: string,
  ctx: ConnectorContext = {},
  fetchImpl: RawFetch = jsonFetch,
): Promise<PollResult> {
  const res = await fetchImpl(url, ctx);
  const parsed = parseRssOrAtom(res.body);
  // Normalize YouTube titles which look like "Title — Channel" (nice but not
  // required for dedup; title trigram similarity still works).
  return { items: parsed.items, httpStatus: res.status };
}

// ---- hn_algolia ----

export interface HnHit {
  objectID?: string;
  title?: string;
  url?: string;
  story_text?: string | null;
  points?: number;
  num_comments?: number;
  created_at?: string;
  [key: string]: unknown;
}

export function parseHnAlgolia(body: string, minPoints = 0, minComments = 0): SourceItemInput[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('JSON parse error');
  }
  const hits = (data as { hits?: HnHit[] }).hits ?? [];
  const items: SourceItemInput[] = [];
  for (const hit of hits) {
    const points = hit.points ?? 0;
    const comments = hit.num_comments ?? 0;
    if (points < minPoints || comments < minComments) continue;
    const rawUrl = hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID ?? ''}`;
    const title = normalizeTitle(hit.title);
    const body = normalizeText(`${title ?? ''} ${hit.story_text ?? ''}`);
    items.push({
      rawUrl,
      title,
      bodyText: body,
      publishedAt: hit.created_at ? new Date(hit.created_at) : null,
      metadata: { points, numComments: comments, objectId: hit.objectID },
    });
  }
  return items;
}

export async function pollHnAlgolia(
  url: string,
  minPoints: number,
  minComments: number,
  ctx: ConnectorContext = {},
  fetchImpl: RawFetch = jsonFetch,
): Promise<PollResult> {
  const res = await fetchImpl(url, ctx);
  const items = parseHnAlgolia(res.body, minPoints, minComments);
  return { items, httpStatus: res.status };
}

// ---- arxiv ----

export interface ArxivEntry {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  updated?: string;
  author?: unknown;
  'arxiv:comment'?: unknown;
  [key: string]: unknown;
}

export function parseArxiv(body: string): SourceItemInput[] {
  // arXiv serves Atom; reuse the Atom parser path.
  const parsed = parseRssOrAtom(body);
  return parsed.items.map((it) => ({
    ...it,
    metadata: { ...(it.metadata ?? {}), connector: 'arxiv' },
  }));
}

export async function pollArxiv(
  url: string,
  ctx: ConnectorContext = {},
  fetchImpl: RawFetch = jsonFetch,
): Promise<PollResult> {
  const res = await fetchImpl(url, ctx);
  const items = parseArxiv(res.body);
  return { items, httpStatus: res.status };
}
