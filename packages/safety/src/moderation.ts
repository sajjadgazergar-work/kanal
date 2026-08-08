import { classifyPost, type ClassifyResult } from './policy-classifier.js';
import { detectPii, redactPii, type PiiFinding } from './pii.js';

/**
 * Moderation pipeline (plan §15.4).
 *
 * Outbound classification runs on the **rendered** post, not the draft, so it
 * sees exactly what would ship. The pipeline is deterministic:
 *
 *   1. PII detection on the rendered text. Any outbound PII hit blocks publish
 *      and requires an explicit, audited human override.
 *   2. Policy classification (risk_class + ToS flags + growth-hack refusal).
 *
 * Ingest hits are stored redacted with `pii_redacted: true`; outbound hits
 * block publish.
 */

export interface OutboundModerationResult {
  blocked: boolean;
  blockedReason: string | null;
  pii: PiiFinding[];
  classification: ClassifyResult;
  /** The rendered text with PII redacted (used for storage/review). */
  redactedText: string;
}

/**
 * Run the full outbound moderation gate on a rendered post. Returns a verdict;
 * when `blocked` is true the publisher must not proceed without an audited
 * human override.
 */
export function moderateOutbound(renderedText: string, manualFlags: { isSponsored?: boolean } = {}): OutboundModerationResult {
  const pii = detectPii(renderedText);
  const classification = classifyPost(renderedText, manualFlags);
  const redactedText = redactPii(renderedText, pii);

  if (pii.length > 0) {
    return {
      blocked: true,
      blockedReason: `outbound PII detected: ${pii.map((f) => f.type).join(', ')}`,
      pii,
      classification,
      redactedText,
    };
  }
  if (classification.verdict === 'block') {
    return {
      blocked: true,
      blockedReason: `policy block: ${classification.reasons.join('; ')}`,
      pii,
      classification,
      redactedText,
    };
  }
  return {
    blocked: false,
    blockedReason: null,
    pii,
    classification,
    redactedText,
  };
}

export interface IngestModerationResult {
  piiRedacted: boolean;
  pii: PiiFinding[];
  redactedBody: string;
}

/** Ingest path: redact PII, store with the `pii_redacted` flag. Never blocks. */
export function moderateIngest(bodyText: string): IngestModerationResult {
  const pii = detectPii(bodyText);
  const redactedBody = redactPii(bodyText, pii);
  return { piiRedacted: pii.length > 0, pii, redactedBody };
}
