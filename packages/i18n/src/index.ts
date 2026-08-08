/**
 * @kanal/i18n — KANAL internationalization (plan §14.8).
 *
 * - Locale/content separation: `uiConfig(org)` vs `contentConfig(channel)`.
 * - ICU MessageFormat catalogues: en, fa (one/other pluralization).
 * - Bidi helpers: `<bdi>`, FSI/PDI, directional icon CSS.
 * - Jalali calendar conversion + `Intl`-based display.
 * - Persian numerals with a `copyable` escape hatch.
 * - en-XA pseudo-locale for screenshot tests.
 */
export * from './bidi.js';
export * from './locale.js';
export * from './numbers.js';
export * from './message-format.js';
export * from './catalogue.js';
export * from './catalogues/en.js';
export * from './catalogues/fa.js';
export * from './jalali.js';
export * from './pseudo.js';
