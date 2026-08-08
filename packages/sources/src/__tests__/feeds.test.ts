import { describe, it, expect, afterEach } from 'vitest';
import { parseRssOrAtom, parseJsonFeed } from '../feeds.js';
import { pollFeed, pollJsonFeed } from '../connectors/feedConnectors.js';
import { normalizeText } from '../text.js';
import { fixture, withFakeFetch } from './helpers.js';

describe('RSS parser', () => {
  it('parses items with links, titles, dates, bodies', () => {
    const parsed = parseRssOrAtom(fixture('sample-feed.rss'));
    expect(parsed.kind).toBe('rss');
    expect(parsed.items).toHaveLength(3);
    const first = parsed.items[0]!;
    expect(first.rawUrl).toBe('https://example.test/news/openai-reasoning-model');
    expect(first.title).toContain('OpenAI unveils new reasoning model');
    expect(first.publishedAt).toBeInstanceOf(Date);
    expect(first.bodyText).toContain('reasoning model');
  });

  it('strips zero-width and soft-hyphen payloads (attack #4)', () => {
    const parsed = parseRssOrAtom(fixture('sample-feed.rss'));
    const zwsp = parsed.items.find((i) => i.rawUrl.includes('zwsp'))!;
    expect(zwsp.bodyText).not.toContain('​'); // zero-width space
    expect(zwsp.bodyText).not.toContain('­'); // soft hyphen
  });
});

describe('Atom parser', () => {
  it('parses entries with link resolution', () => {
    const parsed = parseRssOrAtom(fixture('sample-atom.xml'));
    expect(parsed.kind).toBe('atom');
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]!.rawUrl).toBe('https://example.test/atom/db-entry');
    expect(parsed.items[0]!.title).toContain('databases');
  });
});

describe('JSONFeed parser', () => {
  it('parses a JSONFeed document', () => {
    const json = JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1',
      title: 'Example Feed',
      items: [
        {
          id: '1',
          url: 'https://example.test/post/1',
          title: 'First post',
          content_text: 'The body of the first post.',
          date_published: '2026-08-07T10:00:00Z',
        },
        {
          id: '2',
          url: 'https://example.test/post/2',
          title: 'Second post',
          content_html: '<p>HTML body</p>',
          date_modified: '2026-08-07T11:00:00Z',
        },
      ],
    });
    const parsed = parseJsonFeed(json);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]!.bodyText).toContain('first post');
    expect(parsed.items[1]!.bodyText).toContain('HTML body');
  });
});

describe('pollFeed — conditional GET', () => {
  afterEach(() => {
    // withFakeFetch cleans up via its returned restore fn; here we use it inline
  });

  it('returns notModified on a 304', async () => {
    const restore = withFakeFetch([{ path: '/feed.xml', status: 304, headers: { 'etag': 'abc' }, body: '' }]);
    try {
      const result = await pollFeed('http://example.test/feed.xml', { etag: 'abc' });
      expect(result.notModified).toBe(true);
      expect(result.items).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('parses a fresh feed', async () => {
    const restore = withFakeFetch([{ path: '/feed.xml', body: fixture('sample-feed.rss') }]);
    try {
      const result = await pollFeed('http://example.test/feed.xml');
      expect(result.items).toHaveLength(3);
      expect(result.httpStatus).toBe(200);
    } finally {
      restore();
    }
  });
});

describe('pollJsonFeed — conditional GET', () => {
  it('parses a fresh JSONFeed', async () => {
    const json = JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1',
      title: 'JSON Feed',
      items: [{ id: '1', url: 'https://example.test/jf/1', title: 'JF item', content_text: 'body' }],
    });
    const restore = withFakeFetch([{ path: '/feed.json', body: json }]);
    try {
      const result = await pollJsonFeed('http://example.test/feed.json');
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.title).toBe('JF item');
    } finally {
      restore();
    }
  });
});

describe('normalization of fixture bodies', () => {
  it('normalizeText collapses whitespace (incl. NBSP) and NFC-normalizes', () => {
    // NBSP between Hello and world is collapsed to a plain space —
    // the whole point of the §8.2 normalization is that invisible/unusual
    // whitespace cannot survive into stored body text.
    expect(normalizeText("  Hello\u00a0world\n\n\t  again  ")).toBe('Hello world again');
  });
});
