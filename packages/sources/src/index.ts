/**
 * @kanal/sources — the source system (plan §8).
 */

// types
export * from './types.js';

// URL canonicalization
export {
  canonicalizeUrl,
  canonicalHrefFromHtml,
  preferCanonicalLink,
  canonicalizeWithDocument,
  registrableDomain,
  sha256Hex,
  hexToUuid,
  TRACKING_PARAMS,
} from './url.js';

// fetch discipline + SSRF
export {
  safeFetch,
  fetchRobots,
  parseRobots,
  robotsPathAllowed,
  resolveAndCheck,
  FetchError,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  ROBOTS_TTL_MS,
  setTransport,
  resetTransport,
  setLookup,
  resetLookup,
  resetRobotsCache,
  type HttpTransport,
  type HttpRequestOptions,
  type HttpResponse,
  type LookupFn,
  type FetchResult,
  type FetchOptions,
  type FetchPolicy,
} from './fetcher.js';
export { isPrivateIpv4, isPrivateIpv6, isDeniedIp, ipv6ToBigInt } from './ip.js';
export { fetchDocument, type DocumentResult, type FetchDocumentOptions } from './fetchDocument.js';
export { RateLimiter } from './rateLimit.js';

// text normalization
export { normalizeText, normalizeTitle, tokenize } from './text.js';

// simhash + trigram
export {
  simhash,
  hash64,
  hammingDistance,
  isNearDuplicate,
  simhashToString,
  stringToSimhash,
} from './simhash.js';
export {
  trigrams,
  cosineSimilarity,
  diceSimilarity,
  TITLE_TRIGRAM_THRESHOLD,
  EMBEDDING_COSINE_THRESHOLD,
} from './trigram.js';

// freshness + trust
export {
  freshnessOf,
  TAU_NEWS_HOURS,
  TAU_EVERGREEN_HOURS,
  type FreshnessResult,
} from './freshness.js';
export { trustScore, initialTrustScore, canAuthorHighRiskClaim, clamp, MAX_TRUST_TIER } from './trust.js';

// dedup + vector-off mode
export {
  findDuplicate,
  assignCluster,
  dedupAssignCluster,
  chooseClusterPrimary,
  vectorModeEnabled,
  NEAR_EXACT_WINDOW_MS,
  SEMANTIC_WINDOW_MS,
  SIMHASH_HAMMING_THRESHOLD,
  type DedupCandidate,
  type DedupContext,
  type DedupVerdict,
} from './dedup.js';
export {
  vectorMode,
  vectorsEnabled,
  retrievalSearch,
  dedupFallbackMatch,
  type VectorMode,
  type RetrievalQuery,
  type RetrievedItem,
} from './vectorMode.js';

// pipeline
export { processItem, processItems, urlHashOf, type ProcessedItem } from './pipeline.js';

// parsers
export {
  parseRssOrAtom,
  parseJsonFeed,
  type ParsedFeed,
  type JsonFeedItem,
} from './feeds.js';
export {
  parseSitemap,
  sitemapItemsToInput,
  type SitemapUrl,
  type SitemapIndex,
} from './sitemap.js';

// connectors
export {
  pollFeed,
  pollJsonFeed,
  pollSitemap,
  SITEMAP_CAP,
} from './connectors/feedConnectors.js';
export {
  pollHtmlSelector,
  extractItems,
  recordSelectorDrift,
  resetDriftCounts,
  shouldQuarantine,
  QUARANTINE_AFTER_CONSECUTIVE_ZEROS,
  type HtmlSelectorConfig,
} from './connectors/htmlSelector.js';
export {
  pollRedditJson,
  pollYoutubeRss,
  pollHnAlgolia,
  pollArxiv,
  parseRedditJson,
  parseHnAlgolia,
  parseArxiv,
  type RawFetch,
} from './connectors/apiConnectors.js';
export {
  verifyWebhookSignature,
  webhookToItem,
  manualToItem,
  resetReplayCache,
  type WebhookPayload,
  type WebhookVerification,
} from './connectors/inbound.js';
