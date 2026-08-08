/**
 * Numerals (plan §14.8).
 *
 * Persian numerals apply to displayed counts, dates, and post part markers.
 * They are NEVER applied to identifiers, message_ids, monetary amounts in the
 * cost ledger, or anything copyable into a terminal. Pass `copyable: true` to
 * force Latin digits in every locale.
 */

import type { NumberingSystem } from './locale.js';

export type { NumberingSystem } from './locale.js';

export interface FormatNumberOptions {
  locale?: string;
  numberingSystem?: NumberingSystem;
  /** Force Latin digits — use for identifiers, message_ids, cost amounts, terminal-copyable text. */
  copyable?: boolean;
}

export function formatNumber(
  value: number,
  options: FormatNumberOptions = {},
): string {
  const { locale = 'en', numberingSystem, copyable = false } = options;
  // copyable forces Latin digits in every locale (identifiers, message_ids,
  // cost amounts, terminal-copyable text). Otherwise fall back to the
  // caller's system, or the locale default (fa → arabext).
  const system: NumberingSystem = copyable
    ? 'latn'
    : (numberingSystem ?? (locale === 'fa' ? 'arabext' : 'latn'));
  return new Intl.NumberFormat(locale, { numberingSystem: system }).format(value);
}

/** Convenience: fa displayed counts default to Persian digits. */
export function formatCount(value: number, options: FormatNumberOptions = {}): string {
  return formatNumber(value, {
    locale: options.locale ?? 'fa',
    numberingSystem: options.numberingSystem ?? 'arabext',
    copyable: options.copyable ?? false,
  });
}
