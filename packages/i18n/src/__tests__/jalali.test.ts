import { describe, expect, it } from 'vitest';
import {
  g2j,
  j2g,
  toJalali,
  fromJalali,
  isJalaliLeapYear,
  jalaliMonthLength,
  jalaliYearLength,
  isValidJalali,
  formatJalali,
  jalaliToISO,
  type JalaliDate,
} from '../jalali.js';

/**
 * The 20-date fixture, cross-checked against ICU's authoritative Persian
 * calendar (Intl.DateTimeFormat 'en-u-ca-persian-nu-latn', UTC) at authoring
 * time. Every entry: [ISO date, expected Jalali y-m-d].
 *
 * Includes the 2026-03-20/21 Nowruz boundary, the 1403 leap year and its
 * 1404/1405 successors, month ends (31-day first-half, 30-day second-half,
 * leap Esfand), and the epoch-ish 1979 Islamic-Revolution date.
 */
const FIXTURE_20: Array<[string, JalaliDate]> = [
  ['2024-03-19', { jy: 1402, jm: 12, jd: 29 }], // last day of non-leap 1402
  ['2024-03-20', { jy: 1403, jm: 1, jd: 1 }], // Nowruz 1403
  ['2024-03-21', { jy: 1403, jm: 1, jd: 2 }],
  ['2024-12-20', { jy: 1403, jm: 9, jd: 30 }], // 30-day month end (Azar)
  ['2024-12-21', { jy: 1403, jm: 10, jd: 1 }], // Dey 1
  ['2025-03-19', { jy: 1403, jm: 12, jd: 29 }],
  ['2025-03-20', { jy: 1403, jm: 12, jd: 30 }], // Esfand 30 — 1403 IS a leap year
  ['2025-03-21', { jy: 1404, jm: 1, jd: 1 }], // Nowruz 1404
  ['2025-12-21', { jy: 1404, jm: 9, jd: 30 }],
  ['2025-12-22', { jy: 1404, jm: 10, jd: 1 }],
  ['2026-03-20', { jy: 1404, jm: 12, jd: 29 }], // 1404 is NOT a leap year
  ['2026-03-21', { jy: 1405, jm: 1, jd: 1 }], // Nowruz 1405
  ['2026-06-30', { jy: 1405, jm: 4, jd: 9 }],
  ['2026-07-01', { jy: 1405, jm: 4, jd: 10 }],
  ['2026-12-22', { jy: 1405, jm: 10, jd: 1 }],
  ['2027-03-20', { jy: 1405, jm: 12, jd: 29 }],
  ['2027-03-21', { jy: 1406, jm: 1, jd: 1 }],
  ['2028-03-20', { jy: 1407, jm: 1, jd: 1 }], // 1407 leap year, Nowruz on 03-20
  ['1979-02-11', { jy: 1357, jm: 11, jd: 22 }], // 22 Bahman 1357
  ['2022-03-21', { jy: 1401, jm: 1, jd: 1 }], // Nowruz 1401
];

describe('g2j (Gregorian → Jalali)', () => {
  it.each(FIXTURE_20)('converts %s', (iso, expected) => {
    const [y, m, d] = iso.split('-').map((x) => Number(x)) as [number, number, number];
    expect(g2j(y, m, d)).toEqual(expected);
  });
});

describe('j2g (Jalali → Gregorian)', () => {
  it.each(FIXTURE_20)('inverts %s', (iso, j) => {
    const [gy, gm, gd] = iso.split('-').map((x) => Number(x)) as [number, number, number];
    expect(j2g(j.jy, j.jm, j.jd)).toEqual({ gy, gm, gd });
  });
});

describe('round-trip', () => {
  it('round-trips every fixture through Date', () => {
    for (const [iso, j] of FIXTURE_20) {
      expect(toJalali(new Date(`${iso}T00:00:00Z`))).toEqual(j);
      expect(fromJalali(j.jy, j.jm, j.jd).toISOString().slice(0, 10)).toBe(iso);
    }
  });
});

describe('leap years', () => {
  it('1403 is a leap year; 1402/1404/1405 are not', () => {
    expect(isJalaliLeapYear(1402)).toBe(false);
    expect(isJalaliLeapYear(1403)).toBe(true);
    expect(isJalaliLeapYear(1404)).toBe(false);
    expect(isJalaliLeapYear(1405)).toBe(false);
  });

  it('1408 is a leap year; 1407 is not', () => {
    // The leap cycle continues: 1403, 1407... no — 1407 is the 1406/1411-adjacent
    // non-leap; the next leap after 1403 is 1408.
    expect(isJalaliLeapYear(1407)).toBe(false);
    expect(isJalaliLeapYear(1408)).toBe(true);
  });

  it('leap years have 366 days and a 30-day Esfand', () => {
    expect(jalaliYearLength(1403)).toBe(366);
    expect(jalaliYearLength(1404)).toBe(365);
    expect(jalaliMonthLength(1403, 12)).toBe(30); // Esfand leap
    expect(jalaliMonthLength(1404, 12)).toBe(29);
  });

  it('month lengths: 31 first half, 30 second half', () => {
    for (let m = 1; m <= 6; m += 1) expect(jalaliMonthLength(1404, m)).toBe(31);
    for (let m = 7; m <= 11; m += 1) expect(jalaliMonthLength(1404, m)).toBe(30);
  });
});

describe('validation', () => {
  it('accepts a valid leap-day Esfand and rejects Esfand 30 in a non-leap year', () => {
    expect(isValidJalali(1403, 12, 30)).toBe(true);
    expect(isValidJalali(1404, 12, 30)).toBe(false);
    expect(isValidJalali(1404, 12, 29)).toBe(true);
  });

  it('rejects out-of-range months/days and non-integers', () => {
    expect(isValidJalali(1404, 0, 1)).toBe(false);
    expect(isValidJalali(1404, 13, 1)).toBe(false);
    expect(isValidJalali(1404, 6, 32)).toBe(false);
    expect(isValidJalali(1404, 7, 31)).toBe(false); // 30-day month
    expect(isValidJalali(1404.5, 1, 1)).toBe(false);
  });

  it('jalaliToISO throws for invalid dates and emits UTC ISO-8601 otherwise', () => {
    expect(() => jalaliToISO(1404, 12, 30)).toThrow(RangeError);
    expect(jalaliToISO(1403, 12, 30)).toBe('2025-03-20T00:00:00.000Z');
    expect(jalaliToISO(1405, 1, 1)).toBe('2026-03-21T00:00:00.000Z');
  });
});

describe('display via Intl', () => {
  it('formats a UTC instant in the Persian calendar with Persian numerals by default', () => {
    expect(formatJalali(new Date('2026-03-21T00:00:00Z'))).toBe('۱ فروردین ۱۴۰۵');
  });

  it('supports Latin numerals for terminal-copyable output', () => {
    expect(formatJalali(new Date('2026-03-21T00:00:00Z'), { numberingSystem: 'latn' })).toBe(
      '1 فروردین 1405',
    );
  });
});
