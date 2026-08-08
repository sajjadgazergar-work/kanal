export { TELEGRAM_DESCRIPTOR } from './descriptor.js';
export { TelegramAdapter } from './adapter.js';
export { TelegramClient, type TelegramClientOptions } from './client.js';
export { sanitizeHtml, validateTag, escapeHtml, tokenize } from './html.js';
export {
  splitBody,
  cutBodyAtMax,
  idempotencyKey,
  partMarkerText,
  toNumerals,
  visibleLength,
  unescapeHtml,
  type NumeralSystem,
} from './splitter.js';
export {
  TokenBucketRateLimiter,
  limiterFromDescriptor,
  type RateLimiterOptions,
} from './rate-limiter.js';
