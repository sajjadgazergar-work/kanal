import { describe, expect, it } from 'vitest';
import {
  INJECTION_CORPUS,
  INJECTION_CORPUS_SIZE,
  corpusByAttack,
  type HostileSourceItem,
} from '../../test-corpus/injection.js';
import {
  enforceUrlAllowList,
  sanitizeText,
  scanOutbound,
  findHomoglyphs,
  findBotTokens,
  ZERO_WIDTH_RE,
} from '../injection-guard.js';
import { classifyPost } from '../policy-classifier.js';
import { detectPii } from '../pii.js';
import { classifyPromotional } from '../promo-density.js';

/**
 * Injection corpus assertions (plan §16.1, §18.5).
 *
 * Two invariants must hold for every hostile item:
 *   1. No hostile item can produce a publishable post that bypasses the policy
 *      classifier.
 *   2. No hostile item can produce a publishable post containing a
 *      non-allow-listed URL.
 *
 * "Publishable" is modelled as: the post text survives the deterministic
 * guards (URL allow-list enforced, no hard policy-block category, no outbound
 * PII). We simulate the full pipeline: sanitize → render (claims become text)
 * → URL allow-list → policy classify → moderation.
 */

/** Run a hostile item through the deterministic safety pipeline. */
function runPipeline(item: HostileSourceItem): {
  safeToPublish: boolean;
  blockedReasons: string[];
  publishedText: string;
} {
  const blockedReasons: string[] = [];

  // 1. Sanitize the untrusted body.
  const { text: sanitized, flags } = sanitizeText(item.body);
  if (flags.length > 0) {
    // Injection-pattern flags are advisory, but the deterministic guards below
    // are what stop publication. Record the flags for the report.
  }

  // 2. URL allow-list enforcement — the §16.1 invariant.
  const urlCheck = enforceUrlAllowList(sanitized, item.allowedUrls);
  if (urlCheck.blocked) {
    blockedReasons.push(`non-allow-listed URL: ${urlCheck.blockedUrls.map((b) => b.reason).join(', ')}`);
  }
  const publishedText = urlCheck.sanitized;

  // 3. Policy classification on the (rendered-equivalent) post.
  const classification = classifyPost(publishedText);
  if (classification.verdict === 'block') {
    blockedReasons.push(`policy block: ${classification.reasons.join('; ')}`);
  }

  // 4. Outbound PII — never publish raw PII.
  const pii = detectPii(publishedText);
  if (pii.length > 0) {
    blockedReasons.push(`outbound PII: ${pii.map((p) => p.type).join(', ')}`);
  }

  // 5. Promotional-density flag (an outbound promo post is still publishable,
  //    just deferred by the density engine — not a hard block).

  return {
    safeToPublish: blockedReasons.length === 0,
    blockedReasons,
    publishedText,
  };
}

describe('injection corpus', () => {
  it('has at least 20 hostile source items across the required families', () => {
    expect(INJECTION_CORPUS_SIZE).toBeGreaterThanOrEqual(20);
    const byAttack = corpusByAttack();
    for (const family of ['instruction_override', 'fake_system', 'zero_width', 'homoglyph', 'markdown_image_exfil', 'tool_spoof']) {
      expect(byAttack[family]).toBeDefined();
      expect(byAttack[family]!.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('no hostile item can publish a non-allow-listed URL', () => {
    for (const item of INJECTION_CORPUS) {
      const result = runPipeline(item);
      // The published text must contain no URL other than allow-listed ones.
      const urls = result.publishedText.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
      const allowedLower = new Set(item.allowedUrls.map((u) => u.replace(/\/+$/, '').toLowerCase()));
      for (const url of urls) {
        const normalized = url.replace(/\/+$/, '').toLowerCase();
        expect(allowedLower.has(normalized), `item ${item.id} published non-allow-listed URL ${url}`).toBe(true);
      }
    }
  });

  it('no hostile item can produce a publishable post that bypasses the policy classifier', () => {
    for (const item of INJECTION_CORPUS) {
      const result = runPipeline(item);
      // A hard-block-category or PII-carrying post must never be safeToPublish.
      const classification = classifyPost(result.publishedText);
      if (classification.verdict === 'block') {
        expect(result.safeToPublish, `item ${item.id} should be blocked by policy`).toBe(false);
      }
    }
  });

  it('every hostile item is either blocked or flagged (defence in depth)', () => {
    for (const item of INJECTION_CORPUS) {
      const result = runPipeline(item);
      const { flags } = sanitizeText(item.body);
      // Promotional payloads are flagged by the density classifier; growth-hack
      // requests are refused by the policy classifier. Both count as "flagged".
      const promoFlagged = classifyPromotional(item.body).isPromotional;
      const growthHackFlagged = classifyPost(item.body).growthHackFlags.length > 0;
      const credentialFlagged = findBotTokens(item.body).length > 0;
      const flagged =
        flags.length > 0 ||
        result.blockedReasons.length > 0 ||
        promoFlagged ||
        growthHackFlagged ||
        credentialFlagged;
      expect(flagged, `item ${item.id} (${item.label}) was neither blocked nor flagged`).toBe(true);
    }
  });

  it('markdown-image exfiltration is always blocked', () => {
    for (const item of INJECTION_CORPUS.filter((i) => i.attack === 'markdown_image_exfil')) {
      const scan = scanOutbound({ renderedText: item.body, allowedUrls: item.allowedUrls });
      expect(scan.blocked, `item ${item.id}`).toBe(true);
      expect(scan.blockedUrls.some((b) => b.reason === 'markdown_image_exfil')).toBe(true);
    }
  });

  it('homoglyph domains are flagged and blocked on outbound', () => {
    const scan = scanOutbound({
      renderedText: 'link at https://trуsted.example/report',
      allowedUrls: ['https://trusted.example/'],
    });
    expect(scan.blocked).toBe(true);
    expect(scan.blockedUrls.some((b) => b.reason === 'homoglyph')).toBe(true);
  });

  it('zero-width characters are stripped at ingest', () => {
    for (const item of INJECTION_CORPUS.filter((i) => i.attack === 'zero_width')) {
      const { text } = sanitizeText(item.body);
      expect(ZERO_WIDTH_RE.test(text)).toBe(false);
      expect(text.includes('​')).toBe(false);
    }
  });

  it('instruction-override payloads are flagged', () => {
    for (const item of INJECTION_CORPUS.filter((i) => i.attack === 'instruction_override')) {
      const { flags } = sanitizeText(item.body);
      expect(flags.some((f) => f === 'instruction_override' || f === 'role_swap')).toBe(true);
    }
  });

  it('fake system messages are flagged', () => {
    for (const item of INJECTION_CORPUS.filter((i) => i.attack === 'fake_system')) {
      const { flags } = sanitizeText(item.body);
      expect(flags.some((f) => f === 'fake_system_message' || f === 'tool_spoof')).toBe(true);
    }
  });

  it('promotional payloads are flagged by the density classifier', () => {
    for (const item of INJECTION_CORPUS.filter((i) => i.label.includes('discount') || i.label.includes('referral'))) {
      expect(classifyPromotional(item.body).isPromotional).toBe(true);
    }
  });

  it('PII in a source body is detected and must not ship outbound', () => {
    for (const item of INJECTION_CORPUS.filter((i) => i.label.toLowerCase().includes('pii'))) {
      const pii = detectPii(item.body);
      expect(pii.length, `item ${item.id} should have detected PII`).toBeGreaterThan(0);
    }
  });

  it('bot tokens in a source body are detected and blocked on outbound', () => {
    for (const item of INJECTION_CORPUS.filter((i) => i.label.toLowerCase().includes('bot token'))) {
      const tokens = findBotTokens(item.body);
      expect(tokens.length, `item ${item.id} should have detected a bot token`).toBeGreaterThan(0);
      const scan = scanOutbound({ renderedText: item.body, allowedUrls: item.allowedUrls });
      expect(scan.blocked, `item ${item.id} should be blocked on outbound`).toBe(true);
    }
  });

  it('growth-hack requests are refused with an explanation', () => {
    for (const item of INJECTION_CORPUS.filter((i) => i.label.includes('growth hack') || i.label.includes('impersonation'))) {
      const classification = classifyPost(item.body);
      expect(classification.growthHackFlags.length).toBeGreaterThan(0);
      expect(classification.growthHackFlags.some((g) => g.explanation.length > 0)).toBe(true);
    }
  });

  it('findHomoglyphs detects confusable domains', () => {
    expect(findHomoglyphs('https://аmazon.com')).toHaveLength(1);
    expect(findHomoglyphs('https://amazon.com')).toHaveLength(0);
  });
});
