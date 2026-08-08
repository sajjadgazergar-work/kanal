/**
 * Injection guard (plan §16.1, §18.5).
 *
 * The safety engine's role in the prompt-injection isolation boundary is
 * defence-in-depth and, crucially, the **deterministic** control that makes a
 * hostile source item structurally unable to produce a publishable post:
 *
 *   1. Sanitization: NFC normalization, zero-width/control-character strip,
 *      and removal of fake system/tool delimiters from untrusted text.
 *   2. URL allow-list enforcement: any URL not in the caller's allow-list is
 *      stripped (never silently — the flag is returned). A model that writes
 *      `http://attacker.example` produces a post without that link.
 *   3. Injection-pattern flags: written to `source_item.injection_flags`,
 *      advisory only — they raise review priority and lower trust, and are
 *      never the *control* that prevents harm.
 *   4. Outbound scan: homoglyph domains, confusable URLs, markdown-image
 *      exfiltration, and credential leakage (bot tokens) are flagged on the
 *      rendered post.
 *
 * The invariants the injection corpus tests assert:
 *   - No hostile item can produce a publishable post that bypasses the policy
 *     classifier.
 *   - No hostile item can produce a publishable post containing a
 *     non-allow-listed URL.
 */

export const ZERO_WIDTH_CHARS =
  '​‌‍‎‏⁠﻿­‪‫‬‭‮';
// Zero-width / bidi formatting chars. `no-misleading-character-class` flags the
// ZWJ (U+200D, an emoji-join char) inside the class; the class is intentional —
// these are exactly the bytes we must strip from untrusted text (plan §16.2 #4).
// eslint-disable-next-line no-misleading-character-class
export const ZERO_WIDTH_RE = new RegExp(`[${ZERO_WIDTH_CHARS}]`, 'g');

export interface UrlInjectionDetail {
  url: string;
  reason: 'not_in_allowlist' | 'homoglyph' | 'private_ip' | 'markdown_image_exfil';
}

export interface InjectionScanResult {
  sanitized: string;
  flags: string[];
  blocked: boolean;
  /** When blocked, the URL(s) that caused the block. */
  blockedUrls: UrlInjectionDetail[];
}

export interface OutboundScanInput {
  renderedText: string;
  allowedUrls: string[];
}

export interface OutboundScanResult {
  blocked: boolean;
  reason: string | null;
  strippedText: string;
  flags: string[];
  blockedUrls: UrlInjectionDetail[];
}

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/gi;
/** Non-http URI schemes that can carry a link/redirect payload (tg://, ipfs://, …). */
const NON_HTTP_URI_RE = /\b(?:tg|telesco\.pe|ipfs|ipns|data|file|gopher|ftp):\/\/[^\s<>"']+/gi;

const CYRILLIC_RE = /[Ѐ-ӿ]/;
const GREEK_RE = /[Ͱ-Ͽ]/;

/** Telegram bot tokens: `\d{5,}:` followed by ~35 base64url chars. */
const BOT_TOKEN_RE = /\b\d{5,}:[A-Za-z0-9_-]{30,40}\b/g;

function hostOf(url: string): string {
  return (url.replace(/^https?:\/\//i, '').split('/')[0] ?? '').toLowerCase();
}

function containsHomoglyph(url: string): boolean {
  const host = hostOf(url);
  if (CYRILLIC_RE.test(host) || GREEK_RE.test(host)) return true;
  // Greek o (omicron) inside an ascii host.
  if (/ο/.test(host)) return true;
  return false;
}

function isPrivateOrReserved(host: string): boolean {
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (/^0\./.test(host)) return true;
  if (host.startsWith('169.254.')) return true; // link-local
  if (host.includes(':')) return true; // ipv6 (approximation, flagged)
  return false;
}

/**
 * Strip zero-width/control characters, NFC-normalize, and remove fake system
 * delimiters. This is the deterministic sanitization applied at ingest and
 * again on outbound.
 */
export function sanitizeText(input: string): { text: string; flags: string[] } {
  let text = input.normalize('NFC');
  const flags: string[] = [];
  const zwCount = (text.match(ZERO_WIDTH_RE) ?? []).length;
  if (zwCount > 0) {
    flags.push(`zero_width:${zwCount}`);
    text = text.replace(ZERO_WIDTH_RE, '');
  }
  // Fake system delimiters / role-swap payloads.
  if (/ignore (all )?previous instructions/i.test(text)) flags.push('instruction_override');
  if (/system\s*:|\bsystem message\b/i.test(text)) flags.push('fake_system_message');
  if (/\b(now you are|you are now)\b/i.test(text)) flags.push('role_swap');
  if (/\[tool_calls?\]|\[\/tool\]|\[function_call\]|\[system\]|\[tool\]/i.test(text)) flags.push('tool_spoof');
  // Strip control chars 0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F, 0x7F (excludes \n \t \r).
  const controlRe = new RegExp(
    `[${String.fromCharCode(0x0000, 0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x0008, 0x000b, 0x000c, 0x000e, 0x000f, 0x0010, 0x0011, 0x0012, 0x0013, 0x0014, 0x0015, 0x0016, 0x0017, 0x0018, 0x0019, 0x001a, 0x001b, 0x001c, 0x001d, 0x001e, 0x001f, 0x007f)}]`,
    'g',
  );
  text = text.replace(controlRe, '');
  // Remove fake system/tool marker blocks (a hostile source item can embed
  // "system: …" mid-body; strip the marker tokens deterministically).
  text = text
    .replace(/\bsystem\s*:\s*/gi, '')
    .replace(/\[system\]:?\s*/gi, '')
    .replace(/\[tool\]:?\s*/gi, '')
    .replace(/\[function_call\]:?\s*/gi, '')
    .replace(/ignore (all )?previous instructions\.?\s*/gi, '');
  return { text, flags };
}

/**
 * Extract URLs from a text and filter them against the allow-list. Any URL not
 * in the allow-list is stripped from the text. This is the §16.1 invariant:
 * the model cannot emit an arbitrary link.
 */
export function enforceUrlAllowList(text: string, allowedUrls: string[]): InjectionScanResult {
  const { text: clean, flags } = sanitizeText(text);
  const allowed = new Set(allowedUrls.map((u) => u.trim().replace(/\/+$/, '').toLowerCase()));
  const blockedUrls: UrlInjectionDetail[] = [];

  // Detect markdown-image exfiltration on the ORIGINAL text before any
  // stripping, so an image-URL payload is caught even when its URL would be
  // removed by the plain-text URL strip (plan §16.2 #5).
  for (const m of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const cap = m[1];
    if (cap && !cap.startsWith('data:') === false) {
      // data: URIs are always blocked for images.
    }
    if (cap && !cap.toLowerCase().startsWith('data:')) {
      blockedUrls.push({ url: cap, reason: 'markdown_image_exfil' });
    } else if (cap) {
      blockedUrls.push({ url: cap, reason: 'markdown_image_exfil' });
    }
  }

  // Homoglyph detection on the original URLs.
  for (const m of text.matchAll(URL_RE)) {
    if (containsHomoglyph(m[0])) {
      blockedUrls.push({ url: m[0], reason: 'homoglyph' });
    } else if (isPrivateOrReserved(hostOf(m[0]))) {
      blockedUrls.push({ url: m[0], reason: 'private_ip' });
    }
  }

  // Non-http URI laundering (tg://, ipfs://, data:, file:, gopher:, ftp:) —
  // these can point a reader at attacker-controlled destinations and are never
  // in the allow-list.
  for (const m of text.matchAll(NON_HTTP_URI_RE)) {
    blockedUrls.push({ url: m[0], reason: 'not_in_allowlist' });
  }

  // Strip non-allow-listed URLs from the text.
  let stripped = clean.replace(URL_RE, (m) => {
    const normalized = m.replace(/\/+$/, '').toLowerCase();
    if (allowed.has(normalized)) return m;
    blockedUrls.push({ url: m, reason: 'not_in_allowlist' });
    return '';
  });
  // Strip non-http URIs (never allow-listed).
  stripped = stripped.replace(NON_HTTP_URI_RE, '');

  return {
    sanitized: stripped.replace(/[ \t]{2,}/g, ' ').trim(),
    flags,
    blocked: blockedUrls.length > 0,
    blockedUrls,
  };
}

/**
 * Outbound scan of a rendered post. Flags homoglyph/confusable domains,
 * markdown-image URLs, and credential leaks; strips non-allow-listed URLs.
 */
export function scanOutbound(input: OutboundScanInput): OutboundScanResult {
  const { sanitized, flags, blockedUrls } = enforceUrlAllowList(input.renderedText, input.allowedUrls);
  const allBlocked = [...blockedUrls];
  const extraFlags = [...flags];

  // Credential leak: telegram bot tokens must never ship.
  const botTokens = input.renderedText.match(BOT_TOKEN_RE) ?? [];
  if (botTokens.length > 0) {
    extraFlags.push('bot_token_leak');
    allBlocked.push({ url: botTokens[0]!, reason: 'not_in_allowlist' });
  }

  const imageHits = allBlocked.filter((b) => b.reason === 'markdown_image_exfil');
  const homoglyphHits = allBlocked.filter((b) => b.reason === 'homoglyph');
  const hardBlock =
    imageHits.length > 0 ||
    homoglyphHits.length > 0 ||
    botTokens.length > 0 ||
    extraFlags.includes('instruction_override') ||
    extraFlags.includes('fake_system_message');

  return {
    blocked: hardBlock,
    reason: hardBlock ? `outbound injection guard blocked: ${allBlocked.map((b) => b.reason).join(', ')}` : null,
    strippedText: sanitized,
    flags: extraFlags,
    blockedUrls: allBlocked,
  };
}

/** Detect homoglyph domain names in arbitrary text (used by tests + ingest). */
export function findHomoglyphs(text: string): string[] {
  const urls = text.match(URL_RE) ?? [];
  return urls.filter(containsHomoglyph);
}

/** Detect telegram bot tokens in text. */
export function findBotTokens(text: string): string[] {
  return text.match(BOT_TOKEN_RE) ?? [];
}
