// Fix invisible-char regexes in text.ts to use \u escapes (lint-clean source).
// The char class intentionally contains format/combining codepoints, so the
// `no-misleading-character-class` rule is suppressed on the one line.
import { readFileSync, writeFileSync } from 'node:fs';

const p = 'packages/sources/src/text.ts';
let src = readFileSync(p, 'utf8');

// --- INVISIBLE_PATTERN (zero-width + direction control) ---
const HEX = '200b 200c 200d 2060 feff 00ad 200e 200f 202a 202b 202c 202d 202e';
const ESCAPED = HEX.split(' ').map((h) => '\\u' + h).join('');
const patternLine =
  '// eslint-disable-next-line no-misleading-character-class\n' +
  'const INVISIBLE_PATTERN = /[' + ESCAPED + ']/g;';

const start = src.indexOf('const INVISIBLE_PATTERN');
if (start < 0) {
  console.error('INVISIBLE_PATTERN not found');
  process.exit(1);
}
// Find the end of the whole assignment statement (the ";" after the regex).
const from = src.indexOf(';', start);
src = src.slice(0, start) + patternLine + src.slice(from + 1);

// --- whitespace-collapse class: NBSP, narrow NBSP, thin space ---
if (src.includes(' ') || src.includes(' ') || src.includes(' ')) {
  src = src.replace(/\[ \\t\\n\\r\\f\\v   \]/g, '[ \\t\\n\\r\\f\\v\\u00a0\\u202f\\u2009]');
}

writeFileSync(p, src);
console.log('done');