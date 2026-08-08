import { describe, expect, it } from 'vitest';
import {
  wrapBidi,
  fsi,
  pdi,
  isRtlLocale,
  localeDirection,
  DIRECTIONAL_ICON_CSS,
  isDirectionalIcon,
  iconClass,
  FSI,
  PDI,
} from '../bidi.js';
import { uiConfig, contentConfig } from '../locale.js';

describe('wrapBidi', () => {
  it('wraps user content in <bdi>', () => {
    expect(wrapBidi('گروه فناوری')).toBe('<bdi>گروه فناوری</bdi>');
  });
});

describe('FSI/PDI helpers', () => {
  it('fsi wraps a value in FIRST STRONG ISOLATE / POP DIRECTIONAL ISOLATE', () => {
    expect(fsi('a')).toBe(`${FSI}a${PDI}`);
    expect(fsi(42)).toBe(`${FSI}42${PDI}`);
  });

  it('pdi is symmetric', () => {
    expect(pdi('x')).toBe(`${FSI}x${PDI}`);
  });
});

describe('direction', () => {
  it('fa is RTL, en is LTR', () => {
    expect(isRtlLocale('fa')).toBe(true);
    expect(isRtlLocale('en')).toBe(false);
    expect(localeDirection('fa')).toBe('rtl');
    expect(localeDirection('en')).toBe('ltr');
  });
});

describe('directional icon mirroring', () => {
  it('provides the RTL mirror CSS', () => {
    expect(DIRECTIONAL_ICON_CSS).toBe('[dir=rtl] .icon-directional { transform: scaleX(-1) }');
  });

  it('classifies direction-implicit icons as directional', () => {
    for (const icon of ['back', 'next', 'send', 'chevron-right', 'forward', 'undo', 'share']) {
      expect(isDirectionalIcon(icon)).toBe(true);
    }
  });

  it('exempts neutral icons', () => {
    for (const icon of ['clock', 'check', 'play', 'gear', 'search', 'edit']) {
      expect(isDirectionalIcon(icon)).toBe(false);
    }
  });

  it('emits the icon-directional class only for directional icons', () => {
    expect(iconClass('back')).toContain('icon-directional');
    expect(iconClass('clock')).not.toContain('icon-directional');
  });
});

describe('locale/content separation', () => {
  it('uiConfig reads only org.ui_locale', () => {
    const org = {
      uiLocale: 'fa',
      calendarSystem: 'persian',
      numeralSystem: 'arabext',
      // contentLocale must NOT be readable here
    } as never;
    const cfg = uiConfig(org as never);
    expect(cfg.locale).toBe('fa');
    expect(cfg.direction).toBe('rtl');
    expect(cfg.numberingSystem).toBe('arabext');
    expect(cfg.calendarSystem).toBe('persian');
  });

  it('uiConfig does not read content_locale', () => {
    // If uiConfig read channel.content_locale it would see 'fa', but it must
    // see the org's ui_locale ('en').
    const org = { contentLocale: 'fa' } as never;
    expect(uiConfig(org as never).locale).toBe('en');
  });

  it('contentConfig reads only channel.content_locale', () => {
    const channel = { contentLocale: 'fa' };
    const cfg = contentConfig(channel);
    expect(cfg.locale).toBe('fa');
    expect(cfg.voicePackLocale).toBe('fa');
    expect(cfg.isRtl).toBe(true);
  });

  it('contentConfig ignores org.ui_locale', () => {
    const channel = { contentLocale: 'en' };
    const cfg = contentConfig(channel);
    expect(cfg.locale).toBe('en');
    expect(cfg.isRtl).toBe(false);
  });
});
