/**
 * `html_selector` connector (plan §8.1) with the selector drift detector.
 *
 * If a selector yields 0 nodes twice consecutively, the source is quarantined
 * and the caller is told (surfaced as source.quarantinedAt + a notification).
 * The drift detector keeps per-source consecutive-zero counts.
 */

import { load, type CheerioAPI } from 'cheerio';
import { fetchDocument } from '../fetchDocument.js';
import { normalizeText, normalizeTitle } from '../text.js';
import type { ConnectorContext, PollResult, SourceItemInput } from '../types.js';

export const QUARANTINE_AFTER_CONSECUTIVE_ZEROS = 2;

export interface HtmlSelectorConfig {
  /** CSS selector for the list container (each match is one item). */
  itemSelector: string;
  /** Relative CSS selectors within an item. */
  titleSelector?: string;
  linkSelector?: string;
  bodySelector?: string;
  /** Absolute base URL (required if links are relative). */
  baseUrl?: string;
}

const driftCounts = new Map<string, number>();

/**
 * Track selector drift. Returns the new consecutive-zero count for the source.
 * Callers use `driftCounts` to decide whether to quarantine.
 */
export function recordSelectorDrift(sourceId: string, nodeCount: number): number {
  if (nodeCount === 0) {
    const next = (driftCounts.get(sourceId) ?? 0) + 1;
    driftCounts.set(sourceId, next);
    return next;
  }
  driftCounts.set(sourceId, 0);
  return 0;
}

/** Test-only reset. */
export function resetDriftCounts(): void {
  driftCounts.clear();
}

export function shouldQuarantine(sourceId: string): boolean {
  return (driftCounts.get(sourceId) ?? 0) >= QUARANTINE_AFTER_CONSECUTIVE_ZEROS;
}

export function extractItems($: CheerioAPI, cfg: HtmlSelectorConfig, baseUrl: string): SourceItemInput[] {
  const items: SourceItemInput[] = [];
  const base = new URL(baseUrl);
  $(cfg.itemSelector).each((_, el) => {
    const $el = $(el);
    const title = normalizeTitle($el.find(cfg.titleSelector ?? 'h2,h3,h4').first().text()) ?? normalizeTitle($el.text());
    let href = $el.find(cfg.linkSelector ?? 'a[href]').first().attr('href') ?? null;
    if (href) {
      try {
        href = new URL(href, base).toString();
      } catch {
        href = null;
      }
    }
    if (!href) {
      // No link → skip; items need a URL for dedup.
      return;
    }
    const body = normalizeText(
      cfg.bodySelector ? $el.find(cfg.bodySelector).first().text() : $el.find('p').text(),
    );
    items.push({
      rawUrl: href,
      title,
      bodyText: body || title || '',
      metadata: { selector: cfg.itemSelector },
    });
  });
  return items;
}

/**
 * Poll an html_selector source.
 *
 * @param ctx.sourceKey  stable per-source key for the drift counter (source id)
 * @param ctx.url        page URL
 * @param ctx.selectors  parsed selector config
 */
export async function pollHtmlSelector(
  url: string,
  sourceKey: string,
  selectors: HtmlSelectorConfig,
  ctx: ConnectorContext = {},
): Promise<PollResult> {
  const baseUrl = selectors.baseUrl ?? url;
  const doc = await fetchDocument(url, {
    etag: ctx.etag,
    lastModified: ctx.lastModified,
    spaPathPrefixes: ctx.spaPathPrefixes,
    extract: false,
  });
  if (doc.fetch.notModified) {
    return { items: [], notModified: true, etag: doc.fetch.headers['etag'] ?? null, lastModified: doc.fetch.headers['last-modified'] ?? null };
  }
  const $ = load(doc.html);
  const items = extractItems($, selectors, baseUrl);
  const zeroCount = recordSelectorDrift(sourceKey, items.length);
  const quarantined = zeroCount >= QUARANTINE_AFTER_CONSECUTIVE_ZEROS;

  return {
    items,
    httpStatus: doc.fetch.status,
    contentBytes: doc.fetch.body.length,
    etag: doc.fetch.headers['etag'] ?? null,
    lastModified: doc.fetch.headers['last-modified'] ?? null,
    quarantined,
    warnings: quarantined
      ? [`Selector "${selectors.itemSelector}" returned 0 nodes ${zeroCount} consecutive times — source quarantined`]
      : [],
  };
}
