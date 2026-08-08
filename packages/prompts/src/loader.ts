/**
 * Prompt pack loader (plan §7.4, §7.6, §16.2 #14).
 *
 * Resolves a pack from a local path or a Git URL pinned by commit SHA,
 * loads `pack.yaml`, validates the `core_api` range against
 * `CORE_API_VERSION` via `satisfiesCoreApi`, and reads the locale-scoped
 * templates plus `vars.schema.json` into an in-memory {@link PromptPack}.
 *
 * Security notes:
 *   - Git URLs are only parsed and format-validated; no network is touched.
 *   - The loader is responsible for feeding the renderer an in-memory map of
 *     templates; the renderer has no filesystem access of its own.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { satisfiesCoreApi } from '@kanal/contracts';
import type { PromptPack, TemplateRef } from './pack.js';
import { createTemplateEnv, validateTemplate, type VarsSchema } from './renderer.js';
import { PackLoadError, PackTemplateError, PackLocaleError } from './errors.js';

/** A pack source: either a local directory path or a git URL pinned by SHA. */
export type PackSource =
  | { kind: 'local'; dir: string }
  | { kind: 'git'; url: string; sha: string };

/** Parses a Git URL, returning the SHA pin and the URL with the fragment removed. */
export interface GitUrlParts {
  url: string;
  sha: string;
}

const GIT_URL_RE =
  /^(?:https?|git|ssh):\/\/[^\s#]+(?:\.git)?#([0-9a-fA-F]{40}|\d+\.\d+\.\d+)$/;

/**
 * Parses a Git URL pinned by commit SHA (40 hex chars) or a tag/semver pin.
 * Returns the base URL and the pin. Format-validates only; no network.
 *
 * @throws PackLoadError when the URL is not a valid pinned git URL.
 */
export function parseGitUrl(raw: string): GitUrlParts {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new PackLoadError('git pack source must be a URL string');
  }
  const m = raw.match(GIT_URL_RE);
  if (!m) {
    throw new PackLoadError(
      `invalid git pack URL '${raw}': expected <scheme>://<host>/<path>[.git]#<40-hex-sha-or-semver>`,
    );
  }
  const sha = m[1]!;
  if (!/^[0-9a-fA-F]{40}$/.test(sha) && !/^\d+\.\d+\.\d+$/.test(sha)) {
    throw new PackLoadError(`invalid git pin '${sha}'`);
  }
  const url = raw.slice(0, raw.lastIndexOf('#'));
  return { url, sha };
}

/** True when the string looks like a git URL (scheme present). */
export function isGitSource(raw: string): boolean {
  return /^(?:https?|git|ssh):\/\//.test(raw);
}

/** Parses a {@link PackSource} from a raw string (local path or git URL). */
export function parsePackSource(raw: string): PackSource {
  if (isGitSource(raw)) {
    const { url, sha } = parseGitUrl(raw);
    return { kind: 'git', url, sha };
  }
  return { kind: 'local', dir: raw };
}

interface PackYaml {
  id?: string;
  semver?: string;
  core_api?: string;
  locales?: string[];
  signature?: string;
}

/**
 * Loads a prompt pack.
 *
 * @param source raw string — a local directory path or a git URL pinned by SHA.
 * @param opts
 *   - `overrides` optionally pins the locale set / template set for tests.
 *   - `resolveFromGit` is the callback that would clone+checkout a git pack;
 *     it is NOT called in this package (no network in tests). A git URL is
 *     parsed and format-validated; if a `resolveFromGit` callback is provided
 *     and returns a directory, that directory is loaded as a local pack.
 *
 * @throws PackLoadError when the pack cannot be read or its metadata is
 *   invalid; `PackTemplateError` when a requested template is missing.
 */
export async function loadPromptPack(
  source: string,
  opts: {
    resolveFromGit?: (url: string, sha: string) => Promise<string>;
  } = {},
): Promise<PromptPack> {
  const parsed = parsePackSource(source);
  let dir: string;
  let sourceDesc: string;
  if (parsed.kind === 'local') {
    dir = parsed.dir;
    sourceDesc = `local:${parsed.dir}`;
  } else {
    if (!opts.resolveFromGit) {
      // Format-validated only — no network in this package.
      throw new PackLoadError(
        `git pack source requires a resolver; none configured for '${parsed.url}#${parsed.sha}'`,
      );
    }
    dir = await opts.resolveFromGit(parsed.url, parsed.sha);
    sourceDesc = `git:${parsed.url}#${parsed.sha}`;
  }

  const packYaml = loadPackYaml(dir);
  if (!packYaml.id || !packYaml.semver || !packYaml.core_api) {
    throw new PackLoadError(
      `pack.yaml in '${dir}' must declare id, semver and core_api`,
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(packYaml.semver)) {
    throw new PackLoadError(`pack '${packYaml.id}' has invalid semver '${packYaml.semver}'`);
  }
  if (!satisfiesCoreApi(packYaml.core_api)) {
    throw new PackLoadError(
      `pack '${packYaml.id}' declares core_api '${packYaml.core_api}' which is not satisfied by the current core`,
    );
  }

  const locales = packYaml.locales ?? [];
  if (locales.length === 0) {
    throw new PackLoadError(`pack '${packYaml.id}' declares no locales`);
  }

  const vars = loadVarsSchema(dir);
  // Validate the schema eagerly so a broken declaration fails at load time.
  createTemplateEnv(vars);

  const templates: Record<string, string> = {};
  for (const locale of locales) {
    const localeDir = join(dir, locale);
    let files: string[];
    try {
      files = readdirSync(localeDir)
        .filter((f) => f.endsWith('.tmpl'))
        .sort();
    } catch {
      throw new PackLocaleError(
        `pack '${packYaml.id}' locale '${locale}' directory missing in '${dir}'`,
      );
    }
    for (const file of files) {
      const key = `${locale}/${file}`;
      templates[key] = readFileSync(join(localeDir, file), 'utf8');
    }
    if (files.length === 0) {
      throw new PackLoadError(`pack '${packYaml.id}' locale '${locale}' has no .tmpl files`);
    }
  }

  // Load-time validation: every template must compile against the vars schema
  // so a pack with an undeclared variable is rejected on install, not at render.
  for (const key of Object.keys(templates)) {
    validateTemplate(templates[key]!, vars);
  }

  // Deterministic key order regardless of filesystem readdir order.
  const orderedTemplates: Record<string, string> = {};
  for (const key of Object.keys(templates).sort()) {
    orderedTemplates[key] = templates[key]!;
  }

  return {
    id: packYaml.id,
    semver: packYaml.semver,
    coreApi: packYaml.core_api,
    locales,
    signature: packYaml.signature,
    vars,
    templates: orderedTemplates,
    source: sourceDesc,
  };
}

function loadPackYaml(dir: string): PackYaml {
  const path = join(dir, 'pack.yaml');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new PackLoadError(`pack.yaml not found in '${dir}'`);
  }
  const parsed = parseYamlSubset(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PackLoadError(`pack.yaml in '${dir}' must be a mapping`);
  }
  const record = parsed as Record<string, unknown>;
  const id = record['id'];
  const semver = record['semver'];
  const core_api = record['core_api'];
  const signature = record['signature'];
  const locales = record['locales'];
  if (typeof id !== 'string') {
    throw new PackLoadError(`pack.yaml id must be a string`);
  }
  if (typeof semver !== 'string') {
    throw new PackLoadError(`pack.yaml semver must be a string`);
  }
  if (typeof core_api !== 'string') {
    throw new PackLoadError(`pack.yaml core_api must be a string`);
  }
  if (signature !== undefined && typeof signature !== 'string') {
    throw new PackLoadError(`pack.yaml signature must be a string`);
  }
  if (locales !== undefined) {
    if (!Array.isArray(locales) || locales.some((l) => typeof l !== 'string')) {
      throw new PackLoadError(`pack.yaml locales must be a list of strings`);
    }
  }
  return {
    id,
    semver,
    core_api,
    locales: Array.isArray(locales) ? (locales as string[]) : undefined,
    signature,
  };
}

function loadVarsSchema(dir: string): VarsSchema {
  const path = join(dir, 'vars.schema.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new PackLoadError(`vars.schema.json not found in '${dir}'`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new PackLoadError(`vars.schema.json in '${dir}' is not valid JSON: ${String(e)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PackLoadError(`vars.schema.json in '${dir}' must be an object`);
  }
  return parsed as VarsSchema;
}

/** Parses the small YAML subset used by pack.yaml. */
export function parseYamlSubset(source: string): unknown {
  const lines = source.split(/\r?\n/);
  const root: Record<string, unknown> = {};
  // top-level only: "key: value", "key: [a, b]", or block lists "- item".
  let listKey: string | null = null;
  const listItems: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#') || line === '---') continue;
    const listMatch = line.match(/^-\s+(.+)$/);
    if (listMatch) {
      if (listKey === null) {
        throw new PackLoadError('unexpected top-level list item in pack.yaml');
      }
      listItems.push(parseScalar(listMatch[1]!));
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) {
      throw new PackLoadError(`unsupported pack.yaml line: '${line}'`);
    }
    const key = m[1]!;
    const value = m[2]!.trim();
    if (listKey !== null) {
      root[listKey] = listItems;
      listKey = null;
    }
    if (value.length === 0) {
      listKey = key;
      listItems.length = 0;
      continue;
    }
    root[key] = parseScalar(value);
  }
  if (listKey !== null) root[listKey] = listItems;
  return root;
}

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1);
    if (inner.trim().length === 0) return [];
    return inner
      .split(',')
      .map((s) => parseScalar(s.trim()))
      .filter((s) => s !== '');
  }
  // Inline maps and block scalars are outside the pack.yaml subset.
  if (v.startsWith('{') || v.startsWith('|') || v.startsWith('>')) {
    throw new PackLoadError(`unsupported scalar in pack.yaml: '${v}'`);
  }
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/** Returns the canonical template key for a template ref, e.g. `en/writer.main.tmpl`. */
export function templateKey(ref: TemplateRef): string {
  const ext = ref.name.endsWith('.tmpl') ? '' : '.tmpl';
  return `${ref.locale}/${ref.name}${ext}`;
}

/** Reads a single template source out of a loaded pack. */
export function getTemplate(pack: PromptPack, ref: TemplateRef): string {
  const key = templateKey(ref);
  const source = pack.templates[key];
  if (source === undefined) {
    throw new PackTemplateError(
      `template '${ref.name}' for locale '${ref.locale}' not found in pack '${pack.id}@${pack.semver}' ` +
        `(available: ${Object.keys(pack.templates).join(', ') || 'none'})`,
    );
  }
  return source;
}
