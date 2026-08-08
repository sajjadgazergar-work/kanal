/**
 * Source pipeline (plan §8.2–§8.4): from a connector's raw items to
 * fully-processed, canonicalized, hashed, freshness-scored records ready for
 * the `source_item` table.
 */

import { canonicalizeUrl, sha256Hex, hexToUuid } from './url.js';
import { simhash, simhashToString } from './simhash.js';
import { freshnessOf, type FreshnessResult } from './freshness.js';
import { normalizeText, normalizeTitle } from './text.js';
import type { ProcessedSourceItem, SourceItemInput } from './types.js';

export interface ProcessedItem extends ProcessedSourceItem {
  freshness: FreshnessResult;
  vectorsOn: boolean;
}

export function processItem(
  input: SourceItemInput,
  opts: { spaPathPrefixes?: string[]; now?: Date; vectorsOn?: boolean } = {},
): ProcessedItem {
  const now = opts.now ?? new Date();
  const vectorsOn = opts.vectorsOn ?? process.env.KANAL_VECTOR !== 'off';
  const canonicalUrl = canonicalizeUrl(input.rawUrl, { spaPathPrefixes: opts.spaPathPrefixes });
  const urlHash = hexToUuid(sha256Hex(canonicalUrl));
  const bodyText = normalizeText(input.bodyText);
  const bodySha256 = hexToUuid(sha256Hex(bodyText));
  const title = normalizeTitle(input.title);

  const publishedAt = input.publishedAt ? new Date(input.publishedAt) : null;
  const firstSeenAt = now;

  const sim = simhash(bodyText);
  const freshness = freshnessOf({ publishedAt, firstSeenAt, now });

  return {
    ...input,
    canonicalUrl,
    urlHash,
    simhash: simhashToString(sim),
    bodySha256,
    title,
    bodyText,
    lang: input.lang ?? null,
    publishedAt,
    firstSeenAt,
    fetchedAt: now,
    freshness,
    vectorsOn,
  };
}

export function processItems(
  inputs: SourceItemInput[],
  opts: { spaPathPrefixes?: string[]; now?: Date; vectorsOn?: boolean } = {},
): ProcessedItem[] {
  return inputs.map((i) => processItem(i, opts));
}

/**
 * Build a `url_hash` for a raw URL without processing an item (dedup probe).
 */
export function urlHashOf(rawUrl: string): string {
  return hexToUuid(sha256Hex(canonicalizeUrl(rawUrl)));
}
