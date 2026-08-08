import { describe, expect, it } from 'vitest';
import { satisfiesCoreApi, satisfiesRange, CORE_API_VERSION } from '../version.js';

describe('satisfiesCoreApi', () => {
  it('accepts caret range within major', () => {
    expect(satisfiesRange('^1.2', '1.2.0')).toBe(true);
    expect(satisfiesRange('^1.2', '1.5.3')).toBe(true);
    expect(satisfiesRange('^1.2', '2.0.0')).toBe(false);
  });

  it('accepts exact version', () => {
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true);
    expect(satisfiesRange('1.2.3', '1.2.4')).toBe(false);
  });

  it('handles comparison operators', () => {
    expect(satisfiesRange('>=1.0.0', '1.2.0')).toBe(true);
    expect(satisfiesRange('<2.0.0', '1.2.0')).toBe(true);
    expect(satisfiesRange('>=1.0.0 <2.0.0', '1.5.0')).toBe(true);
  });

  it('handles OR lists', () => {
    expect(satisfiesRange('^0.1.0 || ^1.2.0', '1.2.0')).toBe(true);
    expect(satisfiesRange('^0.1.0 || ^1.2.0', '0.1.5')).toBe(true);
    expect(satisfiesRange('^0.1.0 || ^1.2.0', '2.0.0')).toBe(false);
  });

  it('handles tilde', () => {
    expect(satisfiesRange('~1.2.3', '1.2.9')).toBe(true);
    expect(satisfiesRange('~1.2.3', '1.3.0')).toBe(false);
  });

  it('handles zero-major caret', () => {
    expect(satisfiesRange('^0.2.0', '0.2.5')).toBe(true);
    expect(satisfiesRange('^0.2.0', '0.3.0')).toBe(false);
  });

  it('current core version satisfies the shipped contract range', () => {
    expect(satisfiesCoreApi('^1.2')).toBe(true);
    expect(satisfiesCoreApi('^1.0')).toBe(true);
    expect(CORE_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('rejects garbage', () => {
    expect(satisfiesRange('not-a-range', '1.2.0')).toBe(false);
    expect(satisfiesRange('^1.2', 'banana')).toBe(false);
  });
});
