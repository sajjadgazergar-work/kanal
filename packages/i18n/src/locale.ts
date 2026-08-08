/**
 * Locale/content separation (plan §14.8).
 *
 * `org.ui_locale` drives the interface: UI language, direction, fonts,
 * numerals, and calendar.
 * `channel.content_locale` drives generation: model prompt language, the
 * voice pack, the banned-pattern list, and text shaping inside the post
 * preview.
 *
 * They are never read from the same variable. Packages inside `packages/prompts`
 * must only ever use `contentConfig`; the UI must only ever use `uiConfig`.
 * A lint rule forbids importing the UI locale inside `packages/prompts`
 * (plan §14.8) — the type-level separation here is the enforcement point the
 * prompts package relies on.
 */

import { isRtlLocale, localeDirection, type Direction } from './bidi.js';

/** Locales KANAL ships catalogue data for. */
export const SUPPORTED_LOCALES = ['en', 'fa'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export type { Direction } from './bidi.js';

/** Numerals drive displayed counts/dates/post part markers. */
export type NumberingSystem = 'latn' | 'arabext';

/** Calendar system is org-level (plan §14.8, schema: org.calendar_system). */
export type CalendarSystem = 'gregory' | 'persian';

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Accessor separation
// ---------------------------------------------------------------------------

/**
 * Which settings a UI renderer may read. This type is intentionally NOT the
 * same shape as `ContentConfig`: the two locales never share a variable.
 */
export interface UiConfig {
  locale: Locale;
  direction: Direction;
  /** Persian numeral set used for displayed counts/dates/post part markers. */
  numberingSystem: NumberingSystem;
  calendarSystem: CalendarSystem;
}

/**
 * Which settings a content-generation renderer may read. The prompts package
 * may only consume this config — never the UI locale.
 */
export interface ContentConfig {
  locale: Locale;
  /** Generation language of the model prompt and the voice pack. */
  voicePackLocale: Locale;
  isRtl: boolean;
}

/**
 * Minimal shapes of `org` and `channel` rows (as persisted by the db package).
 * Structural typing keeps i18n independent of the db layer.
 */
export interface OrgRow {
  id?: string;
  uiLocale?: string;
  timezone?: string;
  calendarSystem?: string;
  numeralSystem?: string;
}

export interface ChannelRow {
  id?: string;
  orgId?: string;
  contentLocale?: string;
  contentTimezone?: string;
}

/**
 * UI accessor. Reads ONLY `ui_locale` (+ the org's calendar/numeral prefs).
 * Never reads `content_locale`.
 */
export function uiConfig(org: OrgRow): UiConfig {
  const locale = org.uiLocale ?? 'en';
  const calendarSystem: CalendarSystem =
    org.calendarSystem === 'persian' ? 'persian' : 'gregory';
  const numberingSystem: NumberingSystem =
    org.numeralSystem === 'arabext' ? 'arabext' : 'latn';
  return {
    locale: isSupportedLocale(locale) ? locale : 'en',
    direction: localeDirection(locale),
    numberingSystem,
    calendarSystem,
  };
}

/**
 * Content accessor. Reads ONLY `content_locale`. Never reads `ui_locale`.
 */
export function contentConfig(channel: ChannelRow): ContentConfig {
  const locale = channel.contentLocale ?? 'en';
  return {
    locale: isSupportedLocale(locale) ? locale : 'en',
    voicePackLocale: isSupportedLocale(locale) ? locale : 'en',
    isRtl: isRtlLocale(locale),
  };
}
