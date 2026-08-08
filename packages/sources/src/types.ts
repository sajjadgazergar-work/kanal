/**
 * Shared source-system types (plan §8). All connector output is a normalized
 * `SourceItem`-shaped record — a transport-neutral shape the harvester maps
 * onto the `source_item` table.
 */

export const SOURCE_KINDS = [
  'rss',
  'atom',
  'jsonfeed',
  'sitemap',
  'html_selector',
  'reddit_json',
  'youtube_rss',
  'hn_algolia',
  'arxiv',
  'webhook',
  'manual',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type FreshnessConfidence = 'high' | 'low';

/**
 * A normalized inbound item produced by a connector. Fields mirror the
 * `source_item` table (see packages/db/src/schema.ts) except that canonical /
 * dedup fields (urlHash, simhash, clusterId, bodySha256, firstSeenAt, fetchedAt)
 * are attached by the pipeline, not by connectors.
 */
export interface SourceItemInput {
  /** Raw URL as found in the feed/payload. */
  rawUrl: string;
  /** Canonicalized URL (set by the pipeline before persistence). */
  canonicalUrl?: string;
  title?: string | null;
  /** The article body — already normalized plain text. */
  bodyText: string;
  lang?: string | null;
  publishedAt?: Date | string | null;
  /** Additional per-connector data (author, image, tags, ...). */
  metadata?: Record<string, unknown>;
}

/**
 * A fully-processed item, ready to map onto `source_item`.
 */
export interface ProcessedSourceItem extends SourceItemInput {
  canonicalUrl: string;
  /** sha256(canonicalUrl) mapped to uuid space. */
  urlHash: string;
  /** 64-bit simhash of the normalized body, as a signed bigint string. */
  simhash: string;
  bodySha256: string;
  firstSeenAt: Date;
  fetchedAt: Date;
  publishedAt: Date | null;
  lang: string | null;
}

/**
 * Result of a connector poll.
 */
export interface PollResult {
  /** Normalized items (dedup/canonicalization not yet applied). */
  items: SourceItemInput[];
  /** True when the server answered 304 (no work) or the feed is otherwise unchanged. */
  notModified?: boolean;
  /** HTTP status of the primary fetch, when applicable. */
  httpStatus?: number | null;
  /** Raw response size in bytes, when applicable. */
  contentBytes?: number | null;
  /** Server-provided validators for the next conditional GET. */
  etag?: string | null;
  lastModified?: string | null;
  /** Set when robots.txt disallowed the fetch — recorded as source.robots_blocked. */
  robotsBlocked?: boolean;
  /** Set when an html_selector source is quarantined by the drift detector. */
  quarantined?: boolean;
  /** Connector-specific warnings. */
  warnings?: string[];
}

/**
 * Options every poll connector receives.
 */
export interface ConnectorContext {
  /** Existing validators for conditional GET. */
  etag?: string | null;
  lastModified?: string | null;
  /** Per-source URL list for html_selector links extraction. */
  selectors?: Record<string, string>;
  /** SPA path prefixes for canonicalization (per-source config). */
  spaPathPrefixes?: string[];
  /** Per-niche decay constant, hours (news default 8). */
  freshnessTauHours?: number;
  /** Optional override for time (tests). */
  now?: Date;
}

/** A connector is a function from raw bytes + context to normalized items. */
export interface PollConnector {
  (ctx: ConnectorContext): Promise<PollResult>;
}
