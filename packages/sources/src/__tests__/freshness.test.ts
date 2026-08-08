import { describe, it, expect } from 'vitest';
import { freshnessOf, TAU_NEWS_HOURS, TAU_EVERGREEN_HOURS } from '../freshness.js';
import { NOW } from './helpers.js';

const HOUR = 3600000;

describe('freshness — exp(-Δt/τ)', () => {
  it('is 1 at Δt=0', () => {
    const r = freshnessOf({ publishedAt: NOW, firstSeenAt: NOW, now: NOW }, TAU_NEWS_HOURS);
    expect(r.score).toBeCloseTo(1, 6);
    expect(r.confidence).toBe('high');
    expect(r.basis).toBe('published_at');
  });

  it('decays per the time constant', () => {
    const r = freshnessOf(
      { publishedAt: new Date(NOW.getTime() - TAU_NEWS_HOURS * HOUR), firstSeenAt: NOW, now: NOW },
      TAU_NEWS_HOURS,
    );
    expect(r.score).toBeCloseTo(Math.exp(-1), 5);
  });

  it('excludes items older than 4τ from AUTO', () => {
    const r = freshnessOf(
      { publishedAt: new Date(NOW.getTime() - 5 * TAU_NEWS_HOURS * HOUR), firstSeenAt: NOW, now: NOW },
      TAU_NEWS_HOURS,
    );
    expect(r.excludedFromAuto).toBe(true);
    expect(r.score).toBeLessThan(Math.exp(-4));
  });

  it('does not exclude items younger than 4τ', () => {
    const r = freshnessOf(
      { publishedAt: new Date(NOW.getTime() - 3 * TAU_NEWS_HOURS * HOUR), firstSeenAt: NOW, now: NOW },
      TAU_NEWS_HOURS,
    );
    expect(r.excludedFromAuto).toBe(false);
  });

  it('falls back to first_seen_at with low confidence when published_at is absent', () => {
    const r = freshnessOf({ firstSeenAt: new Date(NOW.getTime() - 2 * HOUR), now: NOW }, TAU_NEWS_HOURS);
    expect(r.basis).toBe('first_seen_at');
    expect(r.confidence).toBe('low');
  });

  it('falls back to first_seen_at with low confidence when published_at is in the future', () => {
    const r = freshnessOf(
      { publishedAt: new Date(NOW.getTime() + 2 * HOUR), firstSeenAt: new Date(NOW.getTime() - 1 * HOUR), now: NOW },
      TAU_NEWS_HOURS,
    );
    expect(r.basis).toBe('first_seen_at');
    expect(r.confidence).toBe('low');
  });

  it('evergreen uses a 30-day constant', () => {
    const r = freshnessOf(
      { publishedAt: new Date(NOW.getTime() - 15 * 24 * HOUR), firstSeenAt: NOW, now: NOW },
      TAU_EVERGREEN_HOURS,
    );
    expect(r.score).toBeCloseTo(Math.exp(-0.5), 5);
    expect(r.excludedFromAuto).toBe(false);
  });
});
