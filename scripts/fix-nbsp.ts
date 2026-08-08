// Replace the raw NBSP (U+00A0) inside the feeds test string literal with a
// source-level   escape so eslint's no-irregular-whitespace stays quiet.
import { readFileSync, writeFileSync } from 'node:fs';

const p = 'packages/sources/src/__tests__/feeds.test.ts';
const src = readFileSync(p, 'utf8');
const NBSP = String.fromCharCode(0xa0);

if (!src.includes(NBSP)) {
  console.error('no NBSP present — nothing to do');
  process.exit(0);
}

// Target: the string literal "  Hello<NBSP>world\n\n\t  again  " inside
// expect(normalizeText(...)). Swap the raw char for a backslash-u escape.
const literal = `  Hello${NBSP}world\\n\\n\\t  again  `;
const escaped = `  Hello\\u00a0world\\n\\n\\t  again  `;
if (!src.includes(literal)) {
  console.error('expected literal not found — refusing to touch file');
  console.error('have:', JSON.stringify(literal));
  process.exit(1);
}
const out = src.split(literal).join(escaped);
writeFileSync(p, out);
console.log('done');