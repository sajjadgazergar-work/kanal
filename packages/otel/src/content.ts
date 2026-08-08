/**
 * Prompt/completion content policy (§13.2).
 *
 * `KANAL_TRACE_CONTENT` controls whether message content is stored on spans:
 *   - `redacted` (default): stores only a SHA-256 of each message plus its
 *     token count. Content is never recoverable from the trace.
 *   - `full`: stores content verbatim for local debugging.
 *   - `off`: stores nothing about content at all.
 *
 * This is the only defensible default for a tool that ingests a user's private
 * drafts and sends them to an OTLP endpoint they may have pointed at a third
 * party. Content keys always live under `kanal.content.*` so the deny-by-default
 * allow-list never sees them.
 */

import { createHash } from 'node:crypto';

export const TRACE_CONTENT_REDACTED = 'redacted';
export const TRACE_CONTENT_FULL = 'full';
export const TRACE_CONTENT_OFF = 'off';
export type TraceContentMode = typeof TRACE_CONTENT_REDACTED | typeof TRACE_CONTENT_FULL | typeof TRACE_CONTENT_OFF;

/** Key family for content-bearing attributes. Never on the allow-list. */
export const CONTENT_SHA256_ATTR = 'kanal.content.sha256';
export const CONTENT_TOKENS_ATTR = 'kanal.content.tokens';

export function parseTraceContentMode(raw: string | undefined): TraceContentMode {
  switch (raw) {
    case TRACE_CONTENT_FULL:
      return TRACE_CONTENT_FULL;
    case TRACE_CONTENT_OFF:
      return TRACE_CONTENT_OFF;
    case TRACE_CONTENT_REDACTED:
    case undefined:
    case '':
      return TRACE_CONTENT_REDACTED;
    default:
      return TRACE_CONTENT_REDACTED;
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface RedactedContent {
  sha256: string;
  tokens: number;
}

/**
 * Content attributes to attach to a span for one message, honouring the
 * configured mode. Never emits anything for `off`.
 */
export function contentAttributes(
  mode: TraceContentMode,
  text: string,
  tokenCount: number,
): Record<string, string | number> {
  if (mode === TRACE_CONTENT_OFF) return {};
  if (mode === TRACE_CONTENT_FULL) {
    return { 'kanal.content.full': text, [CONTENT_TOKENS_ATTR]: tokenCount };
  }
  // redacted (default)
  return { [CONTENT_SHA256_ATTR]: sha256Hex(text), [CONTENT_TOKENS_ATTR]: tokenCount };
}

export function isContentMode(mode: string): mode is TraceContentMode {
  return mode === TRACE_CONTENT_REDACTED || mode === TRACE_CONTENT_FULL || mode === TRACE_CONTENT_OFF;
}
