import { describe, it, expect } from 'vitest';
import { parseRedditJson, parseHnAlgolia, parseArxiv } from '../connectors/apiConnectors.js';
import { pollSitemap, SITEMAP_CAP } from '../connectors/feedConnectors.js';
import { parseSitemap, sitemapItemsToInput } from '../sitemap.js';
import { fixture, withFakeFetch } from './helpers.js';

describe('reddit_json parser', () => {
  it('parses a Reddit listing', () => {
    const body = JSON.stringify({
      data: {
        children: [
          { data: { title: 'Great post', selftext: 'Self text here', url: 'https://example.test/rp', created_utc: 1700000000 } },
          { data: { title: 'Link post', url: 'https://example.test/other', permalink: '/r/sub/comments/abc' } },
        ],
      },
    });
    const items = parseRedditJson(body);
    expect(items).toHaveLength(2);
    expect(items[0]!.publishedAt).toBeInstanceOf(Date);
    // When `url` is present it is the canonical target; permalink is the
    // fallback for self-posts without an external url.
    expect(items[1]!.rawUrl).toBe('https://example.test/other');
  });
});

describe('hn_algolia parser', () => {
  it('applies score and comment thresholds', () => {
    const body = JSON.stringify({
      hits: [
        { objectID: '1', title: 'Top story', url: 'https://example.test/top', points: 100, num_comments: 50 },
        { objectID: '2', title: 'Low story', url: 'https://example.test/low', points: 2, num_comments: 1 },
      ],
    });
    const items = parseHnAlgolia(body, 10, 5);
    expect(items).toHaveLength(1);
    expect(items[0]!.rawUrl).toBe('https://example.test/top');
  });

  it('falls back to the HN item URL', () => {
    const body = JSON.stringify({ hits: [{ objectID: '42', title: 'Ask HN', points: 200 }] });
    const items = parseHnAlgolia(body);
    expect(items[0]!.rawUrl).toBe('https://news.ycombinator.com/item?id=42');
  });
});

describe('arxiv parser', () => {
  it('reuses the Atom path for arXiv responses', () => {
    const atom = fixture('sample-atom.xml');
    const items = parseArxiv(atom);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.metadata?.connector).toBe('arxiv');
  });
});

describe('sitemap connector', () => {
  it('parses a sitemap and diffs by lastmod', () => {
    const xml = fixture('sample-sitemap.xml');
    const parsed = parseSitemap(xml);
    expect(parsed.urls).toHaveLength(4);
    // lastSeen watermark of Aug 7 00:00 → Aug 7 09:00 and Aug 8 09:00 are new
    const items = sitemapItemsToInput(parsed.urls, new Date('2026-08-07T00:00:00Z'), 200);
    expect(items).toHaveLength(2);
    expect(items[0]!.rawUrl).toBe('https://example.test/pages/one');
    expect(items[1]!.rawUrl).toBe('https://example.test/pages/three');
  });

  it('emits all URLs when there is no lastmod on any entry', () => {
    const xml = fixture('sample-sitemap.xml');
    const parsed = parseSitemap(xml);
    const items = sitemapItemsToInput(parsed.urls, null, 200);
    expect(items).toHaveLength(4);
  });

  it('caps new URLs at 200', () => {
    expect(SITEMAP_CAP).toBe(200);
    const urls = Array.from({ length: 500 }, (_, i) => ({ loc: `https://example.test/p/${i}`, lastmod: null }));
    const items = sitemapItemsToInput(urls, null, SITEMAP_CAP);
    expect(items).toHaveLength(200);
  });

  it('pollSitemap fetches and parses via the fake transport', async () => {
    const restore = withFakeFetch([{ path: '/sitemap.xml', body: fixture('sample-sitemap.xml') }]);
    try {
      const result = await pollSitemap('http://example.test/sitemap.xml', new Date('2026-08-07T00:00:00Z'));
      expect(result.items).toHaveLength(2);
    } finally {
      restore();
    }
  });
});
