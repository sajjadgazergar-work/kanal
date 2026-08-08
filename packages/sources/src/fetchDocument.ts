/**
 * `fetchDocument` — the convenience wrapper connectors use: SSRF-safe fetch +
 * conditional GET + readability extraction (via @mozilla/readability over
 * linkedom) + plain-text normalization.
 */

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { safeFetch, type FetchOptions, type FetchResult } from './fetcher.js';
import { normalizeText } from './text.js';
import { canonicalizeWithDocument } from './url.js';

export interface DocumentResult {
  fetch: FetchResult;
  /** Normalized plain text (NFC, collapsed whitespace, zero-width stripped). */
  text: string;
  /** Raw HTML (for connectors that need selectors or canonical links). */
  html: string;
  /** Canonical URL after the 7-step algorithm + same-domain canonical link. */
  canonicalUrl: string;
  /** The title, normalized. */
  title: string | null;
}

export interface FetchDocumentOptions {
  etag?: string | null;
  lastModified?: string | null;
  spaPathPrefixes?: string[];
  honorRobots?: boolean;
  fetchOptions?: FetchOptions;
  /** Set to false to skip readability (raw HTML connectors). */
  extract?: boolean;
}

/**
 * Fetch a URL, honor conditional GET, extract a readable body, and canonicalize
 * the URL. Returns normalized data suitable for a `SourceItemInput`.
 */
export async function fetchDocument(
  url: string,
  opts: FetchDocumentOptions = {},
): Promise<DocumentResult> {
  const result = await safeFetch(
    url,
    {
      ...(opts.fetchOptions ?? {}),
      etag: opts.etag ?? null,
      lastModified: opts.lastModified ?? null,
    },
    { honorRobots: opts.honorRobots ?? true },
  );

  const html = result.body.toString('utf8');
  const canonicalUrl = canonicalizeWithDocument(url, html, { spaPathPrefixes: opts.spaPathPrefixes });

  let text = '';
  let title: string | null = null;
  const extract = opts.extract ?? true;
  if (extract && result.status === 200 && html.length > 0) {
    try {
      const doc = parseHTML(html).document;
      const article = new Readability(doc, { charThreshold: 20 }).parse();
      if (article) {
        text = article.textContent ?? '';
        title = article.title ?? null;
      }
    } catch {
      // readability failure → fall through to normalized raw text
      text = '';
    }
  }
  if (!text) {
    // Fallback: strip tags crudely from the raw HTML (not a correctness
    // boundary — connectors that need precise extraction use their own parser).
    text = html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
  }
  text = normalizeText(text);
  title = title ? normalizeText(title) : null;

  return {
    fetch: result,
    text,
    html,
    canonicalUrl,
    title: title && title.length > 0 ? title : null,
  };
}
