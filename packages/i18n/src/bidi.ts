/**
 * Bidi helpers (plan §14.8). Canonical home for FSI/PDI, <bdi>, direction,
 * and directional-icon classification. Other modules import from here.
 *
 * - Every user-content string is wrapped in `<bdi>`.
 * - Interpolated values inside translated strings are wrapped in
 *   U+2068 FSI / U+2069 PDI by the formatter helper (never by hand).
 * - Directional icons are mirrored in RTL via CSS; non-directional icons are
 *   exempted.
 */

export const FSI = '⁨'; // U+2068 FIRST STRONG ISOLATE
export const PDI = '⁩'; // U+2069 POP DIRECTIONAL ISOLATE

export type Direction = 'ltr' | 'rtl';

/** Wrap a value in FSI/PDI isolates. */
export function fsi(value: string | number): string {
  return `${FSI}${String(value)}${PDI}`;
}

/** Alias for symmetry with the FSI helper. */
export function pdi(value: string | number): string {
  return `${FSI}${String(value)}${PDI}`;
}

/** Wrap a user-content string in a <bdi> element. */
export function wrapBidi(value: string): string {
  return `<bdi>${value}</bdi>`;
}

export function isRtlLocale(locale: string): boolean {
  return locale === 'fa';
}

export function localeDirection(locale: string): Direction {
  return isRtlLocale(locale) ? 'rtl' : 'ltr';
}

/**
 * The CSS that mirrors directional icons in RTL. Include once in the UI shell.
 * Icons that imply direction (back, next, send, caret-left/right) carry the
 * `.icon-directional` class; icons that do not (clock, checkmark, play, pause,
 * settings gear) are explicitly exempted by NOT carrying the class.
 */
export const DIRECTIONAL_ICON_CSS = `[dir=rtl] .icon-directional { transform: scaleX(-1) }`;

/** Icons that imply direction and must be mirrored in RTL. */
export const DIRECTIONAL_ICONS = new Set([
  'back',
  'forward',
  'next',
  'prev',
  'send',
  'chevron-left',
  'chevron-right',
  'arrow-left',
  'arrow-right',
  'share',
  'reply',
  'undo',
]);

/** Icons that carry no direction (clock, checkmark, play, ...) — never mirrored. */
export const NON_DIRECTIONAL_ICONS = new Set([
  'clock',
  'check',
  'checkmark',
  'play',
  'pause',
  'gear',
  'settings',
  'magnifier',
  'search',
  'bell',
  'trash',
  'edit',
  'copy',
]);

/** Classify an icon name as directional (mirrored in RTL) or not. */
export function isDirectionalIcon(icon: string): boolean {
  return DIRECTIONAL_ICONS.has(icon);
}

/** Class list to emit for an icon in a component. */
export function iconClass(icon: string): string {
  const cls = `icon icon-${icon}`;
  return isDirectionalIcon(icon) ? `${cls} icon-directional` : cls;
}
