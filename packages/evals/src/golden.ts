import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaimCoverage } from '@kanal/contracts';

/**
 * Golden set loader (plan §15.2): JSON files at
 * `packages/evals/golden/<locale>/golden.json`, each with 6 posts — 3 good, 3
 * flawed with labelled flaw types. Used to calibrate judges and to regression
 * test the deterministic scorers.
 */

export type FlawType =
  | 'banned_pattern'
  | 'structural'
  | 'formatting'
  | 'factual_grounding'
  | 'quote_budget';

export interface GoldenItem {
  id: string;
  label: 'good' | 'flawed';
  flawTypes?: FlawType[];
  post: {
    bodyMd: string;
    claimMap: Record<string, string[]>;
    allowedUrls: string[];
    media?: { kind: 'image' | 'video' | 'file' }[];
  };
  brief: {
    angle: string;
    audience: string;
    riskClass: number;
    targetLength: number;
    mustCover: string[];
    mustAvoid: string[];
  };
  coverage?: ClaimCoverage;
  sources: { sourceItemId: string; bodyText: string }[];
  html?: string;
}

export interface GoldenSet {
  locale: string;
  description: string;
  items: GoldenItem[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export function goldenPath(locale: string): string {
  // Works from dist/golden.js and src/golden.ts: the golden/ dir sits at the
  // package root, one level above dist/ and src/.
  return join(__dirname, '..', 'golden', locale, 'golden.json');
}

export function loadGoldenSet(locale: string): GoldenSet {
  const raw = readFileSync(goldenPath(locale), 'utf8');
  return JSON.parse(raw) as GoldenSet;
}

export function listGoldenSets(): { locale: string; count: number }[] {
  return ['en', 'fa'].map((locale) => {
    const set = loadGoldenSet(locale);
    return { locale, count: set.items.length };
  });
}

/** Static helper to build a full ClaimCoverage for golden posts. */
export function fullCoverage(sentenceCount: number): ClaimCoverage {
  const sentences = Array.from({ length: sentenceCount }, (_, index) => ({
    index,
    claimIds: ['00000000-0000-0000-0000-000000000001'],
    needsCitation: true,
    hasCitation: true,
    contradiction: false,
  }));
  return { uncitedRatio: 0, sentences };
}

/** A partial coverage map: no sentence needs a citation (deterministic ground pass). */
export function emptyCoverage(sentenceCount: number): ClaimCoverage {
  const sentences = Array.from({ length: sentenceCount }, (_, index) => ({
    index,
    claimIds: [] as string[],
    needsCitation: false,
    hasCitation: false,
    contradiction: false,
  }));
  return { uncitedRatio: 0, sentences };
}
