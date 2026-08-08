import { evaluate } from './evaluate.js';
import { loadGoldenSet } from './golden.js';
import { voiceForLocale } from './voice/index.js';
import type { EvalInput } from './types.js';
import type { VoicePack, Brief, PostDraft, ClaimCoverage } from '@kanal/contracts';

/**
 * Regression runner (plan §15.2): `pnpm eval:run` executes the fixed golden
 * briefs through the deterministic scorers and reports the composite
 * distribution. A drop of ≥ 0.05 in the mean composite blocks the run.
 */

export interface RegressionItem {
  id: string;
  locale: string;
  label: 'good' | 'flawed';
  brief: Brief;
  voice: VoicePack;
  post: PostDraft;
  coverage?: ClaimCoverage;
  sources: { sourceItemId: string; bodyText: string }[];
  html?: string;
}

export function regressionItems(): RegressionItem[] {
  const items: RegressionItem[] = [];
  for (const locale of ['en', 'fa']) {
    const set = loadGoldenSet(locale);
    const voice = voiceForLocale(locale);
    for (const g of set.items) {
      items.push({
        id: g.id,
        locale,
        label: g.label,
        brief: g.brief,
        voice,
        post: {
          bodyMd: g.post.bodyMd,
          claimMap: g.post.claimMap,
          allowedUrls: g.post.allowedUrls,
          media: (g.post.media ?? []).map((m) => ({ kind: m.kind })),
        },
        coverage: g.coverage,
        sources: g.sources,
        html: g.html,
      });
    }
  }
  return items;
}

export interface RegressionRunOptions {
  /** When provided, only the given item ids are run. */
  filter?: string[];
  /** Override the baseline mean; default is the committed baseline. */
  baseline?: number;
}

export interface RegressionReport {
  runId: string;
  items: RegressionItemResult[];
  distribution: { mean: number; min: number; max: number; median: number; n: number };
  baseline: number;
  pass: boolean;
  drop: number;
}

export interface RegressionItemResult {
  id: string;
  locale: string;
  label: 'good' | 'flawed';
  composite: number;
  deterministicComposite: number;
  scores: Record<string, number>;
  issues: { dimension: string; severity: string; message: string }[];
  quoteBudgetOk: boolean;
}

/**
 * The committed baseline: the mean deterministic composite of the golden sets
 * as measured when the baseline was captured. `pnpm eval:run` fails when the
 * measured mean drops ≥ 0.05 below this (plan §15.2).
 */
export const REGRESSION_BASELINE = 0.85;

export async function runRegression(opts: RegressionRunOptions = {}): Promise<RegressionReport> {
  const items = regressionItems().filter((i) => !opts.filter || opts.filter.includes(i.id));
  const results: RegressionItemResult[] = [];

  for (const item of items) {
    const input: EvalInput = {
      post: item.post,
      brief: item.brief,
      voice: item.voice,
      coverage: item.coverage,
      sources: item.sources,
      renderedHtml: item.html,
      meta: { goldenId: item.id },
    };
    const r = await evaluate(input);
    results.push({
      id: item.id,
      locale: item.locale,
      label: item.label,
      composite: r.composite,
      deterministicComposite: r.deterministic.composite,
      scores: Object.fromEntries(
        Object.entries(r.scores).map(([k, v]) => [k, typeof v === 'number' ? v : 0]),
      ),
      issues: r.issues.map((i) => ({ dimension: i.dimension, severity: i.severity, message: i.message })),
      quoteBudgetOk: r.deterministic.quoteBudget.ok,
    });
  }

  const composites = results.map((r) => r.composite);
  const mean = composites.reduce((a, b) => a + b, 0) / (composites.length || 1);
  const sorted = [...composites].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;

  const baseline = opts.baseline ?? REGRESSION_BASELINE;
  const drop = baseline - mean;
  const pass = drop < 0.05;

  return {
    runId: new Date().toISOString(),
    items: results,
    distribution: {
      mean,
      min: sorted[0] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
      median,
      n: results.length,
    },
    baseline,
    pass,
    drop,
  };
}

export function formatRegressionReport(report: RegressionReport): string {
  const lines: string[] = [];
  lines.push(`eval:run — ${report.runId}`);
  lines.push(`  items: ${report.distribution.n}`);
  lines.push(`  composite mean: ${report.distribution.mean.toFixed(4)} (baseline ${report.baseline.toFixed(4)}, drop ${report.drop.toFixed(4)})`);
  lines.push(`  min ${report.distribution.min.toFixed(4)}  max ${report.distribution.max.toFixed(4)}  median ${report.distribution.median.toFixed(4)}`);
  lines.push(`  ${report.pass ? 'PASS' : 'FAIL'} (drop < 0.05 required)`);
  for (const item of report.items) {
    const dims = Object.entries(item.scores)
      .map(([k, v]) => `${k}:${v.toFixed(2)}`)
      .join(' ');
    const flag = item.label === 'good' ? 'ok ' : 'flaw';
    lines.push(`  [${flag}] ${item.id.padEnd(14)} comp=${item.composite.toFixed(3)} qb=${item.quoteBudgetOk ? 'ok' : 'FAIL'} ${dims}`);
  }
  return lines.join('\n');
}
