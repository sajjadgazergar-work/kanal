import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPromptPack, templateKey } from '../loader.js';
import { renderTemplate } from '../renderer.js';
import type { PromptPack } from '../pack.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Path to the shipped default pack. Tests run from `packages/prompts`, so the
 * repo-root `packs/` directory is three levels up.
 */
function repoRoot(): string {
  return join(here, '..', '..', '..', '..');
}

const PACK_DIR = join(repoRoot(), 'packs', 'default-editorial', '3.2.1');

const BRIEF = {
  angle: 'Persian tech ecosystem picks up speed',
  audience: 'Persian-speaking engineers and startup founders',
  riskClass: 0,
  targetLength: 1200,
  mustCover: ['funding amount', 'lead investor', 'what the round funds'],
  mustAvoid: ['price speculation', 'unverified numbers'],
};

const CLAIMS = [
  {
    id: 'c1',
    sourceItemId: 'si1',
    text: 'An Iranian fintech startup closed a $12 million Series A round led by a European VC firm.',
    charSpan: { start: 0, end: 80 },
    confidence: 0.92,
    isQuote: false,
    sourceUrl: 'https://technews.example/fintech-round',
    sourceName: 'TechNews',
  },
  {
    id: 'c2',
    sourceItemId: 'si1',
    text: 'The round will fund hiring and expansion into two new regional markets.',
    charSpan: { start: 81, end: 150 },
    confidence: 0.88,
    isQuote: false,
    sourceUrl: 'https://technews.example/fintech-round',
    sourceName: 'TechNews',
  },
  {
    id: 'c3',
    sourceItemId: 'si2',
    text: 'The company expects to triple its engineering team within 18 months.',
    charSpan: { start: 0, end: 70 },
    confidence: 0.85,
    isQuote: false,
    sourceName: 'Company blog',
  },
];

/** Normalizes line endings so the golden comparison works on Windows. */
function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

function renderWriter(pack: PromptPack): string {
  const source = pack.templates[templateKey({ locale: 'en', name: 'writer.main' })];
  if (!source) throw new Error('writer.main.tmpl missing');
  return renderTemplate({
    source,
    context: {
      brief: BRIEF,
      claims: CLAIMS,
      voice: { register: 'reporter', formality: 0.6, emojiPolicy: 'sparse' },
      recentPosts: ['A thread on the local dev scene', 'Interview with a founder'],
    },
    varsSchema: pack.vars,
  }).output;
}

describe('golden writer.main', () => {
  it('renders the shipped pack to the committed snapshot', async () => {
    const pack = await loadPromptPack(PACK_DIR);
    const output = normalize(renderWriter(pack));
    const snapshotPath = join(here, '__snapshots__', 'writer.main.golden.txt');
    const committed = readFileSync(snapshotPath, 'utf8');
    expect(output).toBe(normalize(committed));
  });

  it('renders the fa writer template without load errors', async () => {
    const pack = await loadPromptPack(PACK_DIR);
    const source = pack.templates[templateKey({ locale: 'fa', name: 'writer.main' })];
    if (!source) throw new Error('fa/writer.main.tmpl missing');
    const out = renderTemplate({
      source,
      context: {
        brief: BRIEF,
        claims: CLAIMS,
        voice: { register: 'reporter' },
      },
      varsSchema: pack.vars,
    }).output;
    expect(out).toContain('شما نویسنده');
  });
});
