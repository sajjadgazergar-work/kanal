import type { Brief, VoicePack } from '@kanal/contracts';

/**
 * Structural compliance (plan §15.2): length within ±25% of the brief target;
 * paragraphs ≤ voice `max_paragraphs`.
 */

export interface StructuralResult {
  score: number;
  lengthRatio: number;
  paragraphCount: number;
  hard: string[];
  soft: string[];
}

export function countParagraphs(bodyMd: string): number {
  const paras = bodyMd
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return paras.length;
}

/** Visual length: strips markdown blockquote markers and inline markup. */
export function visualLength(bodyMd: string): number {
  const cleaned = bodyMd
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/[*_`#>~]/g, '')
    .replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '$1');
  return cleaned.length;
}

export function evaluateStructure(
  bodyMd: string,
  brief: Brief,
  voice: VoicePack,
): StructuralResult {
  const length = visualLength(bodyMd);
  const target = brief.targetLength;
  const min = Math.floor(target * 0.75);
  const max = Math.ceil(target * 1.25);
  const ratio = length / target;

  const maxParas = voice.spec.structure.maxParagraphs;
  const paras = countParagraphs(bodyMd);

  const hard: string[] = [];
  const soft: string[] = [];
  let score = 1;

  if (length < min) {
    hard.push(`length ${length} below ±25% window (min ${min})`);
    score = Math.max(0, score - 0.5);
  } else if (length > max) {
    hard.push(`length ${length} above ±25% window (max ${max})`);
    score = Math.max(0, score - 0.5);
  } else if (ratio < 0.85 || ratio > 1.15) {
    soft.push(`length ${length} is ${ratio.toFixed(2)}x target ${target}`);
    score = Math.max(0, score - 0.15);
  }

  if (paras > maxParas) {
    hard.push(`${paras} paragraphs exceed max ${maxParas}`);
    score = Math.max(0, score - 0.5);
  } else if (paras > Math.ceil(maxParas / 2)) {
    soft.push(`${paras} paragraphs approach the max ${maxParas}`);
    score = Math.max(0, score - 0.05);
  }

  return { score, lengthRatio: ratio, paragraphCount: paras, hard, soft };
}

/** Deterministic score: 0 when any hard structural fail is present. */
export function structuralScore(result: StructuralResult): number {
  return result.hard.length > 0 ? 0 : result.score;
}
