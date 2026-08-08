import { describe, expect, it } from 'vitest';
import { formatNumber, formatCount } from '../numbers.js';

describe('formatNumber', () => {
  it('uses Latin digits by default', () => {
    expect(formatNumber(1234)).toBe('1,234');
  });

  it('formats Persian numerals for fa with arabext', () => {
    expect(formatNumber(1234, { locale: 'fa', numberingSystem: 'arabext' })).toBe('۱٬۲۳۴');
  });

  it('copyable forces Latin digits in every locale', () => {
    expect(formatNumber(1234, { locale: 'fa', numberingSystem: 'arabext', copyable: true })).toBe(
      '1,234',
    );
    expect(formatNumber(1234567, { locale: 'fa', numberingSystem: 'arabext', copyable: true })).toBe(
      '1,234,567',
    );
  });

  it('defaults fa to Persian digits when no system is given', () => {
    expect(formatNumber(2, { locale: 'fa' })).toBe('۲');
  });

  it('formats decimals with the locale separator', () => {
    expect(formatNumber(1234.5, { locale: 'en', numberingSystem: 'latn' })).toBe('1,234.5');
  });
});

describe('formatCount', () => {
  it('is Persian by default but honors copyable', () => {
    expect(formatCount(5)).toBe('۵');
    expect(formatCount(5, { copyable: true })).toBe('5');
  });
});
