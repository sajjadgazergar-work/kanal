import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  loadPromptPack,
  parseGitUrl,
  parsePackSource,
  getTemplate,
  parseYamlSubset,
} from '../loader.js';
import { PackLoadError, PackTemplateError, PackLocaleError } from '../errors.js';

interface PackFiles {
  packYaml?: string;
  varsSchema?: string;
  templates?: Record<string, string>;
}

function writePack(dir: string, files: PackFiles): void {
  mkdirSync(dir, { recursive: true });
  if (files.packYaml !== undefined) writeFileSync(join(dir, 'pack.yaml'), files.packYaml);
  if (files.varsSchema !== undefined) {
    writeFileSync(join(dir, 'vars.schema.json'), files.varsSchema);
  }
  for (const [rel, content] of Object.entries(files.templates ?? {})) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
}

const GOOD_PACK = `
id: default-editorial
semver: 3.2.1
core_api: "^1.2"
locales:
  - en
  - fa
signature: "test-signature"
`;

const GOOD_VARS = JSON.stringify({
  properties: {
    title: { type: 'string' },
    items: { type: 'array' },
  },
});

const GOOD_TEMPLATES = {
  'en/writer.main.tmpl': 'EN: {{ title }}',
  'fa/writer.main.tmpl': 'FA: {{ title }}',
  'en/critic.rubric.tmpl': 'EN rubric',
  'fa/critic.rubric.tmpl': 'FA rubric',
};

let dirs: string[] = [];

function makePack(files: PackFiles): string {
  const dir = mkdtempSync(join(tmpdir(), 'kanal-pack-'));
  dirs.push(dir);
  writePack(dir, files);
  return dir;
}

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('loadPromptPack (local)', () => {
  it('loads a valid pack', async () => {
    const dir = makePack({
      packYaml: GOOD_PACK,
      varsSchema: GOOD_VARS,
      templates: GOOD_TEMPLATES,
    });
    const pack = await loadPromptPack(dir);
    expect(pack.id).toBe('default-editorial');
    expect(pack.semver).toBe('3.2.1');
    expect(pack.coreApi).toBe('^1.2');
    expect(pack.locales).toEqual(['en', 'fa']);
    expect(Object.keys(pack.templates)).toEqual([
      'en/critic.rubric.tmpl',
      'en/writer.main.tmpl',
      'fa/critic.rubric.tmpl',
      'fa/writer.main.tmpl',
    ]);
    expect(pack.templates['en/writer.main.tmpl']).toContain('{{ title }}');
  });

  it('accepts a pack whose core_api is satisfied by the current core', async () => {
    const dir = makePack({
      packYaml: GOOD_PACK,
      varsSchema: GOOD_VARS,
      templates: GOOD_TEMPLATES,
    });
    const pack = await loadPromptPack(dir);
    expect(pack.coreApi).toBe('^1.2');
  });

  it('rejects a pack whose core_api is not satisfied', async () => {
    const dir = makePack({
      packYaml: GOOD_PACK.replace('core_api: "^1.2"', 'core_api: "^2.0"'),
      varsSchema: GOOD_VARS,
      templates: GOOD_TEMPLATES,
    });
    await expect(loadPromptPack(dir)).rejects.toThrow(PackLoadError);
    await expect(loadPromptPack(dir)).rejects.toThrow(/core_api/);
  });

  it('rejects a pack with invalid semver', async () => {
    const dir = makePack({
      packYaml: GOOD_PACK.replace('semver: 3.2.1', 'semver: banana'),
      varsSchema: GOOD_VARS,
      templates: GOOD_TEMPLATES,
    });
    await expect(loadPromptPack(dir)).rejects.toThrow(PackLoadError);
  });

  it('rejects a missing locale directory', async () => {
    const dir = makePack({
      packYaml: GOOD_PACK,
      varsSchema: GOOD_VARS,
      templates: {
        'en/writer.main.tmpl': 'EN',
        'en/critic.rubric.tmpl': 'EN rubric',
      },
    });
    await expect(loadPromptPack(dir)).rejects.toThrow(PackLocaleError);
  });

  it('rejects a locale directory with no templates', async () => {
    const dir = makePack({
      packYaml: GOOD_PACK,
      varsSchema: GOOD_VARS,
      templates: { 'en/writer.main.tmpl': 'EN', 'en/critic.rubric.tmpl': 'EN rubric' },
    });
    mkdirSync(join(dir, 'fa'), { recursive: true });
    await expect(loadPromptPack(dir)).rejects.toThrow(PackLoadError);
  });

  it('rejects a pack whose template references an undeclared variable (load-time)', async () => {
    const dir = makePack({
      packYaml: GOOD_PACK,
      varsSchema: GOOD_VARS,
      templates: { ...GOOD_TEMPLATES, 'en/writer.main.tmpl': 'EN: {{ undeclared }}' },
    });
    await expect(loadPromptPack(dir)).rejects.toThrow(/undeclared variable/);
  });

  it('rejects a missing vars.schema.json', async () => {
    const dir = makePack({
      packYaml: GOOD_PACK,
      templates: GOOD_TEMPLATES,
    });
    await expect(loadPromptPack(dir)).rejects.toThrow(PackLoadError);
  });

  it('rejects a malformed vars.schema.json', async () => {
    const dir = makePack({
      packYaml: GOOD_PACK,
      varsSchema: 'not json',
      templates: GOOD_TEMPLATES,
    });
    await expect(loadPromptPack(dir)).rejects.toThrow(PackLoadError);
  });

  it('rejects missing pack.yaml', async () => {
    const dir = makePack({ varsSchema: GOOD_VARS, templates: GOOD_TEMPLATES });
    await expect(loadPromptPack(dir)).rejects.toThrow(PackLoadError);
  });
});

describe('getTemplate', () => {
  it('resolves a template ref and adds the .tmpl extension', async () => {
    const dir = makePack({
      packYaml: GOOD_PACK,
      varsSchema: GOOD_VARS,
      templates: GOOD_TEMPLATES,
    });
    const pack = await loadPromptPack(dir);
    expect(getTemplate(pack, { locale: 'en', name: 'writer.main' })).toContain('EN');
  });

  it('throws when the template is missing', async () => {
    const dir = makePack({
      packYaml: GOOD_PACK,
      varsSchema: GOOD_VARS,
      templates: GOOD_TEMPLATES,
    });
    const pack = await loadPromptPack(dir);
    expect(() => getTemplate(pack, { locale: 'en', name: 'nonexistent' })).toThrow(
      PackTemplateError,
    );
  });
});

describe('git sources', () => {
  it('parses a git URL pinned by 40-hex SHA', () => {
    const sha = 'a'.repeat(40);
    const { url, sha: pin } = parseGitUrl(`https://github.com/kanal/packs.git#${sha}`);
    expect(url).toBe('https://github.com/kanal/packs.git');
    expect(pin).toBe(sha);
  });

  it('parses a git URL pinned by semver', () => {
    const { url, sha } = parseGitUrl('ssh://git@example.com/org/pack.git#1.2.3');
    expect(url).toBe('ssh://git@example.com/org/pack.git');
    expect(sha).toBe('1.2.3');
  });

  it('rejects git URLs without a pin', () => {
    expect(() => parseGitUrl('https://github.com/kanal/packs.git')).toThrow(PackLoadError);
  });

  it('rejects git URLs with an unpinned branch ref', () => {
    expect(() => parseGitUrl('https://github.com/kanal/packs.git#main')).toThrow(
      PackLoadError,
    );
  });

  it('rejects malformed URLs', () => {
    expect(() => parseGitUrl('not a url')).toThrow(PackLoadError);
  });

  it('parsePackSource distinguishes git and local', () => {
    expect(parsePackSource('./packs/default-editorial/3.2.1').kind).toBe('local');
    const git = parsePackSource(`https://github.com/kanal/packs.git#${'a'.repeat(40)}`);
    expect(git.kind).toBe('git');
  });

  it('loadPromptPack on a git URL without a resolver throws (no network in tests)', async () => {
    await expect(
      loadPromptPack(`https://github.com/kanal/packs.git#${'a'.repeat(40)}`),
    ).rejects.toThrow(PackLoadError);
  });

  it('loadPromptPack uses the resolver when provided', async () => {
    const dir = makePack({
      packYaml: GOOD_PACK,
      varsSchema: GOOD_VARS,
      templates: GOOD_TEMPLATES,
    });
    const resolvedDir = dir;
    const pack = await loadPromptPack(`https://github.com/kanal/packs.git#${'a'.repeat(40)}`, {
      resolveFromGit: async () => resolvedDir,
    });
    expect(pack.id).toBe('default-editorial');
  });
});

describe('parseYamlSubset', () => {
  it('parses scalars, lists and comments', () => {
    const out = parseYamlSubset(`
# comment
id: default-editorial
core_api: "^1.2"
locales:
  - en
  - fa
semver: 3.2.1
`);
    expect(out).toEqual({
      id: 'default-editorial',
      core_api: '^1.2',
      locales: ['en', 'fa'],
      semver: '3.2.1',
    });
  });

  it('parses inline arrays', () => {
    expect(parseYamlSubset('locales: [en, fa]')).toEqual({ locales: ['en', 'fa'] });
  });

  it('parses a list following a key', () => {
    expect(parseYamlSubset('locales:\n  - en\n  - fa')).toEqual({
      locales: ['en', 'fa'],
    });
  });

  it('throws on unsupported lines', () => {
    expect(() => parseYamlSubset('nested: { inline: map }')).toThrow(PackLoadError);
    expect(() => parseYamlSubset('|literal')).toThrow(PackLoadError);
    expect(() => parseYamlSubset('key: |\n  block')).toThrow(PackLoadError);
  });
});
