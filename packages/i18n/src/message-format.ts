/**
 * Minimal ICU MessageFormat engine.
 *
 * Supports the subset KANAL's catalogues need:
 *   - `{name}`                        simple substitution
 *   - `{name, plural, ...}`           CLDR plural categories (one/other, ...)
 *   - `{name, select, ...}`           literal selection
 *   - `#`                             the plural/select value inside a pattern
 *
 * Pluralization uses CLDR categories via `Intl.PluralRules` — NOT `n === 1`.
 * Persian uses `one`/`other` (it is not the Arabic six-form system).
 *
 * Every interpolated value is wrapped in U+2068 FSI / U+2069 PDI by the
 * formatter itself (plan §14.8) — callers never wrap by hand.
 */

import { FSI, PDI, fsi } from './bidi.js';

export type MessageArgs = Record<string, string | number>;

export { FSI, PDI, fsi, pdi } from './bidi.js';

/** Wrap a value in FSI/PDI isolates (re-exported for callers that pre-format). */
export function wrapIsolate(value: string | number): string {
  return `${FSI}${String(value)}${PDI}`;
}

export interface ParsedArgument {
  value: string;
  nextIndex: number;
}

/**
 * Format an ICU-ish message template for `locale` with `args`.
 * Throws on unknown arguments or malformed syntax.
 */
export function formatMessage(template: string, locale: string, args: MessageArgs = {}): string {
  return formatPattern(template, locale, args);
}

/** Format a pattern, resolving `{...}` arguments. `#` is only meaningful inside plural patterns. */
function formatPattern(template: string, locale: string, args: MessageArgs): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const c = template[i]!;
    if (c === '{') {
      const parsed = parseArgument(template, i, locale, args);
      out += parsed.value;
      i = parsed.nextIndex;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function parseArgument(
  template: string,
  start: number,
  locale: string,
  args: MessageArgs,
): ParsedArgument {
  // template[start] === '{'
  let i = start + 1;
  const name = readWhile(template, i, (c) => c !== ',' && c !== '}');
  i = name.nextIndex;

  if (template[i] === '}') {
    return { value: fsi(resolveArg(name.value.trim(), args)), nextIndex: i + 1 };
  }

  // template[i] === ',' — skip it, then read the argument type
  i += 1;
  const type = readWhile(template, i, (c) => c !== ',' && c !== '}');
  i = type.nextIndex;
  const argType = type.value.trim();

  if (argType === 'plural' || argType === 'select') {
    return parseOptionList(template, i, locale, args, argType, name.value.trim());
  }

  throw new Error(
    `Unsupported message argument type "${argType}" at offset ${start} in: ${template}`,
  );
}

function parseOptionList(
  template: string,
  startIndex: number,
  locale: string,
  args: MessageArgs,
  argType: 'plural' | 'select',
  argName: string,
): ParsedArgument {
  let i = startIndex;
  const options = new Map<string, string>();

  while (i < template.length && template[i] !== '}') {
    // skip separators
    while (i < template.length && (template[i] === ',' || template[i] === ' ' || template[i] === '\n' || template[i] === '\t')) {
      i += 1;
    }
    if (template[i] === '}') break;

    const keyword = readWhile(template, i, (c) => c !== '{' && c !== ',' && c !== '}');
    i = keyword.nextIndex;
    while (i < template.length && template[i] === ' ') i += 1;
    if (template[i] !== '{') {
      throw new Error(`Expected "{" after option keyword in: ${template.slice(startIndex)}`);
    }
    i += 1;
    let depth = 1;
    const subStart = i;
    while (i < template.length && depth > 0) {
      if (template[i] === '{') depth += 1;
      else if (template[i] === '}') depth -= 1;
      i += 1;
    }
    if (depth !== 0) {
      throw new Error(`Unbalanced braces in option list: ${template.slice(startIndex)}`);
    }
    options.set(keyword.value.trim(), template.slice(subStart, i - 1));
  }

  if (i >= template.length || template[i] !== '}') {
    throw new Error(`Unterminated option list in: ${template.slice(startIndex)}`);
  }

  const raw = resolveArg(argName, args);
  let selected: string | undefined;
  if (argType === 'plural') {
    const num = typeof raw === 'number' ? raw : Number(raw);
    const category = new Intl.PluralRules(locale).select(num);
    selected = options.get(category) ?? options.get('other');
  } else {
    selected = options.get(String(raw)) ?? options.get('other');
  }
  if (selected === undefined) {
    throw new Error(
      `No matching option and no "other" for argument "${argName}" in: ${template.slice(startIndex)}`,
    );
  }

  return {
    value: formatPluralPattern(selected, raw, locale, args),
    nextIndex: i + 1,
  };
}

/** Format a plural/select sub-pattern, honouring `#` and nested `{...}`. */
function formatPluralPattern(
  pattern: string,
  value: string | number,
  locale: string,
  args: MessageArgs,
): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '#') {
      const num = typeof value === 'number' ? value : Number(value);
      // Displayed counts use the locale's default numeral system (Persian
      // digits for fa). Monetary/identifier values are passed pre-formatted.
      out += fsi(new Intl.NumberFormat(locale).format(num));
      i += 1;
    } else if (c === '{') {
      const parsed = parseArgument(pattern, i, locale, args);
      out += parsed.value;
      i = parsed.nextIndex;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function resolveArg(name: string, args: MessageArgs): string | number {
  if (Object.prototype.hasOwnProperty.call(args, name)) {
    return args[name] as string | number;
  }
  throw new Error(`Missing message argument: ${name}`);
}

interface ReadResult {
  value: string;
  nextIndex: number;
}

function readWhile(template: string, start: number, predicate: (c: string) => boolean): ReadResult {
  let value = '';
  let i = start;
  while (i < template.length && predicate(template[i]!)) {
    value += template[i];
    i += 1;
  }
  return { value, nextIndex: i };
}
