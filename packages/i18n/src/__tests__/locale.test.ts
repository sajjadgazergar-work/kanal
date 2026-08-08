import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_LOCALES,
  isSupportedLocale,
  uiConfig,
  contentConfig,
} from '../locale.js';
import { isRtlLocale, localeDirection, fsi, pdi, wrapBidi } from '../bidi.js';

describe('locale primitives', () => {
  it('exposes the supported set', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'fa']);
  });

  it('validates locales', () => {
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('fa')).toBe(true);
    expect(isSupportedLocale('ar')).toBe(false);
  });

  it('computes direction', () => {
    expect(isRtlLocale('fa')).toBe(true);
    expect(isRtlLocale('en')).toBe(false);
    expect(localeDirection('fa')).toBe('rtl');
    expect(localeDirection('en')).toBe('ltr');
  });

  it('exports bidi helpers', () => {
    expect(fsi('x')).toMatch(/⁨/);
    expect(pdi('x')).toMatch(/⁩/);
    expect(wrapBidi('x')).toBe('<bdi>x</bdi>');
  });
});

describe('accessor separation (never the same variable)', () => {
  it('uiConfig is driven by org.ui_locale', () => {
    const cfg = uiConfig({ uiLocale: 'fa', calendarSystem: 'persian', numeralSystem: 'arabext' });
    expect(cfg).toEqual({
      locale: 'fa',
      direction: 'rtl',
      numberingSystem: 'arabext',
      calendarSystem: 'persian',
    });
  });

  it('uiConfig defaults gracefully', () => {
    expect(uiConfig({})).toEqual({
      locale: 'en',
      direction: 'ltr',
      numberingSystem: 'latn',
      calendarSystem: 'gregory',
    });
  });

  it('uiConfig never reads content_locale', () => {
    const cfg = uiConfig({ contentLocale: 'fa' } as never);
    expect(cfg.locale).toBe('en');
  });

  it('contentConfig is driven by channel.content_locale', () => {
    const cfg = contentConfig({ contentLocale: 'fa' });
    expect(cfg).toEqual({ locale: 'fa', voicePackLocale: 'fa', isRtl: true });
  });

  it('contentConfig defaults gracefully', () => {
    expect(contentConfig({})).toEqual({ locale: 'en', voicePackLocale: 'en', isRtl: false });
  });
});
