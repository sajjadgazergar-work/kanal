/**
 * Jalali (Persian) calendar conversion (plan §14.8).
 *
 * The algorithm is the well-known astronomical algorithm by B. Khorsandi,
 * as published in jalaali-js (BSD-2-Clause). Verified against ICU's
 * `Intl.DateTimeFormat('...-u-ca-persian...')` across 1970–2035 in the unit
 * tests.
 *
 * Storage is always UTC ISO-8601 (`toISOString`). Display uses
 * `Intl.DateTimeFormat('fa-IR-u-ca-persian')` — we only implement the
 * Gregorian↔Jalali arithmetic ourselves, per the task constraint (no heavy
 * date library).
 */

export interface JalaliDate {
  jy: number;
  jm: number; // 1..12
  jd: number; // 1..31
}

function div(a: number, b: number): number {
  return ~~(a / b);
}

function mod(a: number, b: number): number {
  return a - ~~(a / b) * b;
}

/**
 * Jalali calendar breaks — the 33-year cycle leap points. This exact table is
 * what makes the algorithm agree with the astronomical Persian calendar used
 * by ICU.
 */
const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

interface JalCalResult {
  leap: number; // 0..4 (position in 33-year cycle; 4 == leap)
  gy: number; // Gregorian year of Nowruz
  march: number; // day of March on which Nowruz falls
}

function jalCal(jy: number): JalCalResult {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0] as number;
  let jm = 0;
  let jump = 0;
  let i = 1;
  for (; i < bl; i += 1) {
    jm = BREAKS[i] as number;
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;

  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;

  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;

  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;

  return { leap, gy, march };
}

/** Julian Day Number for a Gregorian date (noon-based, per the algorithm). */
function g2d(gy: number, gm: number, gd: number): number {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

/** Gregorian date for a Julian Day Number. */
function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

/** Jalali date for a Julian Day Number (exact jalaali-js algorithm). */
function d2j(jdn: number): JalaliDate {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) {
      return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

/** Julian Day Number for a Jalali date. */
function j2d(jy: number, jm: number, jd: number): number {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

/** Gregorian (y, m, d) for a Jalali date. */
export function j2g(jy: number, jm: number, jd: number): { gy: number; gm: number; gd: number } {
  return d2g(j2d(jy, jm, jd));
}

/** Jalali date for a Gregorian (y, m, d). */
export function g2j(gy: number, gm: number, gd: number): JalaliDate {
  return d2j(g2d(gy, gm, gd));
}

/** Convert a UTC Date to a Jalali date. */
export function toJalali(date: Date): JalaliDate {
  return g2j(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Convert a Jalali date to a UTC Date at 00:00:00Z. */
export function fromJalali(jy: number, jm: number, jd: number): Date {
  const { gy, gm, gd } = j2g(jy, jm, jd);
  return new Date(Date.UTC(gy, gm - 1, gd));
}

/** Is a Jalali year a leap year? (jalaali-js: leap === 0 within the 33-year cycle.) */
export function isJalaliLeapYear(jy: number): boolean {
  return jalCal(jy).leap === 0;
}

/** Days in a Jalali month (1..12). Esfand is 29 normally, 30 in leap years. */
export function jalaliMonthLength(jy: number, jm: number): number {
  if (jm >= 1 && jm <= 6) return 31;
  if (jm >= 7 && jm <= 11) return 30;
  return isJalaliLeapYear(jy) ? 30 : 29;
}

/** Total days in a Jalali year (365 or 366). */
export function jalaliYearLength(jy: number): number {
  return isJalaliLeapYear(jy) ? 366 : 365;
}

/** Validate a Jalali date tuple. */
export function isValidJalali(jy: number, jm: number, jd: number): boolean {
  if (!Number.isInteger(jy) || !Number.isInteger(jm) || !Number.isInteger(jd)) return false;
  if (jm < 1 || jm > 12) return false;
  return jd >= 1 && jd <= jalaliMonthLength(jy, jm);
}

/** UTC ISO-8601 string for a Jalali date. */
export function jalaliToISO(jy: number, jm: number, jd: number): string {
  if (!isValidJalali(jy, jm, jd)) {
    throw new RangeError(`Invalid Jalali date ${jy}-${jm}-${jd}`);
  }
  return fromJalali(jy, jm, jd).toISOString();
}

/**
 * Display formatting. Uses `Intl.DateTimeFormat('fa-IR-u-ca-persian')` for the
 * Persian calendar on screen (plan §14.8); storage is always UTC ISO-8601.
 * Set `numberingSystem: 'latn'` for terminal-copyable output.
 */
export function formatJalali(
  date: Date,
  options: {
    locale?: string;
    numberingSystem?: 'latn' | 'arabext';
    month?: 'long' | 'short' | 'numeric';
  } = {},
): string {
  const { locale = 'fa', numberingSystem = 'arabext', month = 'long' } = options;
  return new Intl.DateTimeFormat(`${locale}-u-ca-persian`, {
    timeZone: 'UTC',
    numberingSystem,
    year: 'numeric',
    month,
    day: 'numeric',
  }).format(date);
}
