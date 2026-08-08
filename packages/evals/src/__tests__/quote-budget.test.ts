import { describe, expect, it } from 'vitest';
import {
  evaluateQuoteBudget,
  QUOTE_MAX_RUN,
  QUOTE_TOTAL_CAP,
  MIN_VERBATIM_RUN,
  quoteBudgetScore,
} from '../quote-budget.js';

const SID = '00000000-0000-0000-0000-000000000001';

describe('quote budget (plan §8.5)', () => {
  it('passes a body with no verbatim overlap', () => {
    const body = 'The board approved the project. The site is north of the city. Work starts next month.';
    const r = evaluateQuoteBudget(body, [{ sourceItemId: SID, bodyText: 'An unrelated source story about semiconductors.' }]);
    expect(r.ok).toBe(true);
    expect(r.verbatimChars).toBe(0);
  });

  it('a 95-char verbatim run without a blockquote fails', () => {
    const verbatim = 'The new electrolyte sustains 500 charge cycles at 45 degrees Celsius with capacity retention above 90 percent.'.slice(0, 95);
    const body = `The supplier says ${verbatim}. It is designed for grid storage.`;
    const r = evaluateQuoteBudget(body, [{ sourceItemId: SID, bodyText: verbatim }]);
    expect(verbatim.length).toBeGreaterThan(QUOTE_MAX_RUN);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === 'overlength_unquoted')).toBe(true);
  });

  it('a 95-char verbatim run inside an attributed blockquote passes the run rule', () => {
    const verbatim = 'The new electrolyte sustains 500 charge cycles at 45 degrees Celsius with capacity retention above 90 percent.';
    expect(verbatim.length).toBeGreaterThan(QUOTE_MAX_RUN);
    // A long post so the 25% total cap comfortably exceeds the 110-char quote.
    const filler = 'The material is meant for grid-scale storage and the results reproduce across repeated runs. The independent lab holds no stake in the chemistry.'.repeat(3);
    const body = `> ${verbatim}\n> — Volta Research (https://volta.example/research)\n\n${filler}`;
    const r = evaluateQuoteBudget(body, [{ sourceItemId: SID, bodyText: verbatim }]);
    const overlength = r.violations.some((v) => v.kind === 'overlength_unquoted');
    expect(overlength).toBe(false);
    expect(r.verbatimChars).toBeLessThanOrEqual(r.cap);
    expect(r.ok).toBe(true);
  });

  it('a blockquote without an attribution line does not protect the run', () => {
    const verbatim = 'The new electrolyte sustains 500 charge cycles at 45 degrees Celsius with capacity retention above 90 percent.';
    const body = `> ${verbatim}\n\nThis is quoted text with no attribution. Volta Research ran the test today.`;
    const r = evaluateQuote(body, [{ sourceItemId: SID, bodyText: verbatim }]);
    expect(r.violations.some((v) => v.kind === 'overlength_unquoted')).toBe(true);
  });

  it('total verbatim chars are capped at min(25% of post length, 400)', () => {
    // A single long attributed blockquote that itself exceeds the 25% cap.
    const verbatim = 'The new electrolyte sustains 500 charge cycles at 45 degrees Celsius with capacity retention above 90 percent and the supplier has never published retention data above that level for this product line.'.slice(0, 120);
    const body = `> ${verbatim}\n> — Volta Research (https://volta.example/research)\n\nA short follow-up sentence.`;
    const cap = Math.min(Math.floor(body.length * 0.25), QUOTE_TOTAL_CAP);
    const r = evaluateQuoteBudget(body, [{ sourceItemId: SID, bodyText: verbatim }]);
    expect(r.cap).toBe(cap);
    expect(r.verbatimChars).toBeGreaterThan(cap);
    // Attributed, so no overlength run violation — only the total cap is hit.
    expect(r.violations.some((v) => v.kind === 'overlength_unquoted')).toBe(false);
    expect(r.violations.some((v) => v.kind === 'total_cap_exceeded')).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('total cap never exceeds 400 even for very long posts', () => {
    const verbatim = 'The system reduces total cost of ownership by at least 30 percent while improving throughput by 40 percent through a new caching layer and a rewritten scheduler.';
    const pad = 'x'.repeat(3000);
    const body = `${verbatim}${pad}`;
    const r = evaluateQuote(body, [{ sourceItemId: SID, bodyText: verbatim }]);
    expect(r.cap).toBe(QUOTE_TOTAL_CAP);
    expect(r.verbatimChars).toBe(verbatim.length);
  });

  it('score is 1 when ok and 0 when violated', () => {
    expect(quoteBudgetScore({ ok: true } as never)).toBe(1);
    expect(quoteBudgetScore({ ok: false } as never)).toBe(0);
  });
});

function evaluateQuote(body: string, sources: { sourceItemId: string; bodyText: string }[]) {
  return evaluateQuoteBudget(body, sources);
}

describe('MIN_VERBATIM_RUN', () => {
  it('is below the 90-char long-run threshold', () => {
    expect(MIN_VERBATIM_RUN).toBeLessThan(QUOTE_MAX_RUN);
    expect(MIN_VERBATIM_RUN).toBeGreaterThan(16);
  });
});