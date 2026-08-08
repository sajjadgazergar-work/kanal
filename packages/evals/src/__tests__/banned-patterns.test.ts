import { describe, expect, it } from 'vitest';
import type { VoicePack } from '@kanal/contracts';
import {
  buildRegExp,
  densityPer100Words,
  evaluateBannedPatterns,
  bannedPatternScore,
} from '../banned-patterns.js';
import { EN_VOICE } from '../voice/en.js';

function packWith(patterns: VoicePack['spec']['bannedPatterns']): VoicePack {
  return {
    ...EN_VOICE,
    spec: {
      ...EN_VOICE.spec,
      bannedPatterns: patterns,
    },
  };
}

describe('banned-pattern evaluation (plan §15.1, §15.3)', () => {
  it('hard patterns block', () => {
    const vp = packWith([
      { id: 'not_x_but_y', pattern: "(?i)\\b(it'?s not|this isn'?t)\\s+\\w+[^.]{0,40}\\bit'?s\\b", kind: 'pattern', severity: 'hard' },
    ]);
    const r = evaluateBannedPatterns(vp, "It's not complicated, it's simple.");
    expect(r.hardCount).toBe(1);
    expect(bannedPatternScore(r)).toBe(0);
  });

  it('soft patterns score a penalty', () => {
    const vp = packWith([
      { id: 'tricolon_stack', pattern: '\\b[\\w-]+,\\s+[\\w-]+,\\s+(?:and\\s+)?[\\w-]+(?:[\\s&][\\w-]+)*\\.', kind: 'pattern', severity: 'soft' },
    ]);
    const r = evaluateBannedPatterns(vp, 'The engine is fast, scalable, and secure.');
    expect(r.hardCount).toBe(0);
    expect(r.hits.length).toBe(1);
    const score = bannedPatternScore(r);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('density rules trigger on token count per 100 words', () => {
    const vp = packWith([
      { id: 'em_dash_density', pattern: '—', kind: 'density', token: '—', maxPer100Words: 1.5, severity: 'soft' },
    ]);
    const body = 'A — B — C — D — E — F — G — H — I — J — K.';
    expect(densityPer100Words(body, '—')).toBeGreaterThan(1.5);
    const r = evaluateBannedPatterns(vp, body);
    expect(r.hits.some((h) => h.patternId === 'em_dash_density')).toBe(true);
  });

  it('density rules pass below the threshold', () => {
    const vp = packWith([
      { id: 'em_dash_density', pattern: '—', kind: 'density', token: '—', maxPer100Words: 1.5, severity: 'soft' },
    ]);
    // A single dash across 100+ words is below 1.5 per 100.
    const manyWords = ('word '.repeat(120) + '—').trim();
    expect(densityPer100Words(manyWords, '—')).toBeLessThan(1.5);
    const r = evaluateBannedPatterns(vp, manyWords);
    expect(r.hits.some((h) => h.patternId === 'em_dash_density')).toBe(false);
  });

  it('buildRegExp strips inline (?i) flags the way the plan authors them', () => {
    const re = buildRegExp("(?i)\\b(it'?s not|this isn'?t)\\s+\\w+[^.]{0,40}\\bit'?s\\b");
    expect(re.ignoreCase).toBe(true);
    expect(re.test("It's not complicated, it's simple.")).toBe(true);
  });

  it('no false positives on a clean post', () => {
    const r = evaluateBannedPatterns(EN_VOICE, 'The new controller sustains 1.2 TB/s memory bandwidth at 2 nanometers. Aurora ships in March.');
    expect(r.hits.length).toBe(0);
    expect(bannedPatternScore(r)).toBe(1);
  });
});