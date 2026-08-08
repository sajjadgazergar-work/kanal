import { describe, expect, it } from 'vitest';
import {
  t,
  getCatalogue,
  enCatalog,
  faCatalog,
  enKeys,
  faKeys,
  catalogueParity,
} from '../catalogue.js';
import { formatMessage, FSI, PDI } from '../message-format.js';

describe('catalogue keys', () => {
  it('has at least 40 keys', () => {
    expect(enKeys.length).toBeGreaterThanOrEqual(40);
  });

  it('en and fa share every key', () => {
    const { missingInFa, missingInEn } = catalogueParity();
    expect(missingInFa).toEqual([]);
    expect(missingInEn).toEqual([]);
    expect(enKeys).toEqual(faKeys);
  });

  it('every catalogue value is non-empty', () => {
    for (const k of enKeys) expect(enCatalog[k]).toBeTruthy();
    for (const k of faKeys) expect(faCatalog[k]).toBeTruthy();
  });
});

describe('required keys present', () => {
  const required = [
    'nav.today',
    'nav.queue',
    'nav.channels',
    'nav.ops',
    'nav.cost',
    'nav.settings',
    'action.approve',
    'action.edit',
    'action.reject',
    'action.requestChanges',
    'action.openTrace',
    'state.pending',
    'state.granted',
    'state.denied',
    'state.expired',
  ];
  it.each(required)('%s exists in both catalogues', (key) => {
    expect(enCatalog[key as keyof typeof enCatalog]).toBeTruthy();
    expect(faCatalog[key as keyof typeof faCatalog]).toBeTruthy();
  });
});

describe('pluralization (ICU categories, not n === 1)', () => {
  it('en: 1 → one, 2 → other', () => {
    // The # value is FSI/PDI-isolated by the formatter.
    expect(t('en', 'queue.pendingCount', { n: 1 })).toBe(`${FSI}1${PDI} run awaiting approval`);
    expect(t('en', 'queue.pendingCount', { n: 2 })).toBe(`${FSI}2${PDI} runs awaiting approval`);
  });

  it('en: 0 → other', () => {
    // CLDR: English "0" is `other` — the plural category is not n === 1.
    expect(t('en', 'queue.pendingCount', { n: 0 })).toBe(`${FSI}0${PDI} runs awaiting approval`);
  });

  it('fa: 0 and 1 → one, 2 → other', () => {
    // Persian: 0 is `one`, 1 is `one`, 2 is `other` (not Arabic six-form).
    const faOne = t('fa', 'queue.pendingCount', { n: 1 });
    const faZero = t('fa', 'queue.pendingCount', { n: 0 });
    const faTwo = t('fa', 'queue.pendingCount', { n: 2 });
    expect(faOne).toBe(`${FSI}۱${PDI} اجرا در انتظار تأیید`);
    expect(faZero).toBe(`${FSI}۰${PDI} اجرا در انتظار تأیید`);
    expect(faTwo).toBe(`${FSI}۲${PDI} اجرا در انتظار تأیید`);
  });

  it('formats the # with the locale numeral system inside the plural', () => {
    // fa digits inside the plural string.
    const fa = t('fa', 'channels.activeCount', { n: 5 });
    expect(fa).toBe(`${FSI}۵${PDI} کانال فعال`);
    const en = t('en', 'channels.activeCount', { n: 5 });
    expect(en).toBe(`${FSI}5${PDI} active channels`);
  });

  it('time.hoursAgo pluralizes', () => {
    expect(t('en', 'time.hoursAgo', { n: 1 })).toBe(`${FSI}1${PDI} hour ago`);
    expect(t('en', 'time.hoursAgo', { n: 3 })).toBe(`${FSI}3${PDI} hours ago`);
  });
});

describe('interpolated values are FSI/PDI-isolated', () => {
  it('wraps simple arguments', () => {
    const msg = t('en', 'error.unknownState', { state: 'blocked_policy' });
    expect(msg).toBe(`Unknown run state: ${FSI}blocked_policy${PDI}`);
  });

  it('wraps # plural values', () => {
    const msg = t('en', 'queue.pendingCount', { n: 3 });
    expect(msg).toBe(`${FSI}3${PDI} runs awaiting approval`);
  });

  it('wraps arguments inside fa messages too', () => {
    const msg = t('fa', 'error.unknownState', { state: 'blocked_policy' });
    expect(msg).toBe(`وضعیت ناشناخته اجرا: ${FSI}blocked_policy${PDI}`);
  });
});

describe('formatMessage edge cases', () => {
  it('select chooses the literal branch', () => {
    // Branch content is static template text — only interpolated values get
    // FSI/PDI-isolated, so the branch text itself is unwrapped.
    const out = formatMessage(
      '{kind, select, news {📰 News} tech {💻 Tech} other {Generic}}',
      'en',
      { kind: 'tech' },
    );
    expect(out).toBe('💻 Tech');
  });

  it('select falls back to other', () => {
    const out = formatMessage('{kind, select, a {A} other {Z}}', 'en', { kind: 'zzz' });
    expect(out).toBe('Z');
  });

  it('throws on missing arguments', () => {
    expect(() => formatMessage('{nope}', 'en', {})).toThrow(/Missing message argument/);
  });

  it('supports nested arguments in plural options', () => {
    const out = formatMessage(
      '{n, plural, one {One item for {owner}} other {# items for {owner}}}',
      'en',
      { n: 1, owner: 'ana' },
    );
    expect(out).toBe(`One item for ${FSI}ana${PDI}`);
  });
});

describe('catalogue accessors', () => {
  it('getCatalogue returns the locale catalogue', () => {
    expect(getCatalogue('en')).toBe(enCatalog);
    expect(getCatalogue('fa')).toBe(faCatalog);
  });

  it('t dispatches by locale', () => {
    expect(t('en', 'nav.today')).toBe('Today');
    expect(t('fa', 'nav.today')).toBe('امروز');
  });
});
