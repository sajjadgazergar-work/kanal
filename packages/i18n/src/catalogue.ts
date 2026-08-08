/**
 * Catalogue loader (plan §14.8). Provides a typed `t()` across en and fa.
 */
import { enCatalog, enKeys, type EnKey, formatEn } from './catalogues/en.js';
import { faCatalog, faKeys, type FaKey, formatFa } from './catalogues/fa.js';
import type { Locale } from './locale.js';
import type { MessageArgs } from './message-format.js';

export type { EnKey, FaKey };
export { enCatalog, enKeys, faCatalog, faKeys, formatEn, formatFa };

export type CatalogueKey = EnKey & FaKey;

const catalogues: Record<Locale, Record<CatalogueKey, string>> = {
  en: enCatalog as Record<CatalogueKey, string>,
  fa: faCatalog as Record<CatalogueKey, string>,
};

/** Keys are the English key set (source of truth for the UI shape). */
export type Catalogue = typeof enCatalog;

export function getCatalogue(locale: Locale): Catalogue {
  return catalogues[locale] as Catalogue;
}

export function t(locale: Locale, key: CatalogueKey, args: MessageArgs = {}): string {
  if (locale === 'fa') {
    return formatFa(key as FaKey, args);
  }
  return formatEn(key as EnKey, args);
}

/** Parity check used by tests and a lint-time assertion: en/fa share every key. */
export function catalogueParity(): { missingInFa: string[]; missingInEn: string[] } {
  const enSet = new Set<string>(enKeys);
  const faSet = new Set<string>(faKeys);
  return {
    missingInFa: enKeys.filter((k) => !faSet.has(k)),
    missingInEn: faKeys.filter((k) => !enSet.has(k)),
  };
}
