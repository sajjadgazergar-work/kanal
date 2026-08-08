import { describe, expect, it } from 'vitest';
import type { Brief } from '@kanal/contracts';
import { evaluateStructure, structuralScore, countParagraphs, visualLength } from '../structural.js';
import { EN_VOICE } from '../voice/en.js';

const brief: Brief = {
  angle: 'x',
  audience: 'y',
  riskClass: 1,
  targetLength: 200,
  mustCover: [],
  mustAvoid: [],
};

describe('structural compliance (plan §15.2)', () => {
  it('passes a post within ±25% of the target and paragraph budget', () => {
    // ~190 chars ≈ 0.95x of the 200-char target → inside ±25%.
    const body = 'A sentence of reasonable length for this brief. Another one follows it, and a third closes it.'.repeat(2);
    const r = evaluateStructure(body, brief, EN_VOICE);
    expect(r.hard.length).toBe(0);
    expect(structuralScore(r)).toBe(1);
  });

  it('fails when the post is more than 25% longer than the target', () => {
    const longBody = 'Word '.repeat(300);
    const r = evaluateStructure(longBody, brief, EN_VOICE);
    expect(r.hard.some((m) => m.includes('length'))).toBe(true);
    expect(structuralScore(r)).toBe(0);
  });

  it('fails when the post is more than 25% shorter than the target', () => {
    const shortBody = 'Tiny post.';
    const r = evaluateStructure(shortBody, brief, EN_VOICE);
    expect(r.hard.some((m) => m.includes('length'))).toBe(true);
    expect(structuralScore(r)).toBe(0);
  });

  it('fails when paragraphs exceed max_paragraphs', () => {
    const paras = Array.from({ length: 6 }, (_, i) => `Paragraph number ${i} of this post.`).join('\n\n');
    const r = evaluateStructure(paras, brief, EN_VOICE);
    expect(r.hard.some((m) => m.includes('paragraph'))).toBe(true);
    expect(structuralScore(r)).toBe(0);
  });

  it('counts paragraphs splitting on blank lines', () => {
    expect(countParagraphs('One. Two.\n\nThree. Four.\n\nFive.')).toBe(3);
    expect(countParagraphs('Single paragraph.')).toBe(1);
  });

  it('visualLength ignores blockquote markers and inline markup', () => {
    const body = '> Quoted line.\n> — Source (https://example.com)\n\nPlain **bold** and `code`.';
    const v = visualLength(body);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(body.length);
  });
});