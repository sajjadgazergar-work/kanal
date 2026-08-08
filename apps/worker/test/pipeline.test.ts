import { describe, it, expect } from 'vitest';
import { sha256Hex, stepIdemKey } from '../src/pipeline.js';

describe('sha256Hex', () => {
  it('produces a 64-char hex digest', () => {
    expect(sha256Hex('hello')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(sha256Hex('same input')).toBe(sha256Hex('same input'));
  });

  it('differs for different inputs', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });
});

describe('stepIdemKey (plan §5.4)', () => {
  it('is a deterministic function of run|stage|attempt', () => {
    const a = stepIdemKey('run-1', 'editorial.draft', 1);
    const b = stepIdemKey('run-1', 'editorial.draft', 1);
    const c = stepIdemKey('run-1', 'editorial.draft', 2);
    const d = stepIdemKey('run-2', 'editorial.draft', 1);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});
