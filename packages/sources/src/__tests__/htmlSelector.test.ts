import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { load } from 'cheerio';
import { extractItems, recordSelectorDrift, resetDriftCounts, shouldQuarantine, QUARANTINE_AFTER_CONSECUTIVE_ZEROS, pollHtmlSelector } from '../connectors/htmlSelector.js';
import { fixture, withFakeFetch } from './helpers.js';

describe('html_selector extraction', () => {
  it('extracts items with title, link, and body (raw URLs — canonicalization happens in the pipeline)', () => {
    const html = fixture('sample-page.html');
    const $ = load(html);
    const items = extractItems($, { itemSelector: '.item', titleSelector: '.title', linkSelector: 'a[href]' }, 'https://example.test');
    expect(items).toHaveLength(2);
    expect(items[0]!.rawUrl).toBe('https://example.test/stories/one?utm_source=test&ref=nav');
    expect(items[0]!.title).toContain('Story one');
  });

  it('resolves relative links against the base URL', () => {
    const html = fixture('sample-page.html');
    const $ = load(html);
    const items = extractItems($, { itemSelector: '.item', linkSelector: 'a[href]' }, 'https://example.test/roundup');
    expect(items[1]!.rawUrl).toBe('https://example.test/stories/two?utm_source=test&fbclid=abc');
  });
});

describe('selector drift detector', () => {
  beforeEach(() => resetDriftCounts());
  afterEach(() => resetDriftCounts());

  it('quarantines after two consecutive zero-node results', () => {
    expect(recordSelectorDrift('src-1', 0)).toBe(1);
    expect(shouldQuarantine('src-1')).toBe(false);
    expect(recordSelectorDrift('src-1', 0)).toBe(2);
    expect(shouldQuarantine('src-1')).toBe(true);
    expect(QUARANTINE_AFTER_CONSECUTIVE_ZEROS).toBe(2);
  });

  it('resets on a non-zero result', () => {
    recordSelectorDrift('src-1', 0);
    recordSelectorDrift('src-1', 5);
    expect(shouldQuarantine('src-1')).toBe(false);
    expect(recordSelectorDrift('src-1', 0)).toBe(1);
  });

  it('tracks sources independently', () => {
    recordSelectorDrift('src-a', 0);
    recordSelectorDrift('src-a', 0);
    expect(shouldQuarantine('src-a')).toBe(true);
    expect(shouldQuarantine('src-b')).toBe(false);
  });

  it('pollHtmlSelector reports the quarantine flag', async () => {
    const restore = withFakeFetch([{ path: '/page', body: '<html><body><div class="items"></div></body></html>' }]);
    try {
      const r1 = await pollHtmlSelector('http://example.test/page', 'src-drift', { itemSelector: '.items .item' });
      expect(r1.quarantined).toBe(false);
      const r2 = await pollHtmlSelector('http://example.test/page', 'src-drift', { itemSelector: '.items .item' });
      expect(r2.quarantined).toBe(true);
      expect(r2.warnings?.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it('honours conditional GET via 304', async () => {
    const restore = withFakeFetch([
      { path: '/page', status: 304, headers: { 'etag': 'v1' }, body: '' },
    ]);
    try {
      const r1 = await pollHtmlSelector('http://example.test/page', 'src-cond', { itemSelector: '.items .item' }, { etag: 'v1' });
      expect(r1.notModified).toBe(true);
      expect(r1.items).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
