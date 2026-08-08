import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadPromptPack } from '../loader.js';
import { assemblePrompt } from '../assemble.js';
import { TemplateLoadError } from '../errors.js';
import type { PromptPack } from '../pack.js';

const PACK_YAML = `id: default-editorial
semver: 3.2.1
core_api: "^1.2"
locales:
  - en
`;

const VARS = JSON.stringify({
  properties: { title: { type: 'string' }, items: { type: 'array' } },
});

const TEMPLATES = {
  'en/sys.tmpl': 'You are the system.',
  'en/user.tmpl': 'Title: {{ title }}',
  'en/list.tmpl': '{% for item in items %}{{ item }}{% endfor %}',
};

let dirs: string[] = [];

function makePack(extra?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kanal-assemble-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'en'), { recursive: true });
  writeFileSync(join(dir, 'pack.yaml'), PACK_YAML);
  writeFileSync(join(dir, 'vars.schema.json'), VARS);
  for (const [rel, content] of Object.entries({ ...TEMPLATES, ...(extra ?? {}) })) {
    writeFileSync(join(dir, rel), content);
  }
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

async function loadPack(): Promise<PromptPack> {
  return loadPromptPack(makePack());
}

describe('assemblePrompt', () => {
  it('renders steps into messages at their declared roles and order', async () => {
    const pack = await loadPack();
    const result = assemblePrompt({
      pack,
      steps: [
        { ref: { locale: 'en', name: 'sys' }, role: 'system', order: 0, context: {} },
        { ref: { locale: 'en', name: 'user' }, role: 'user', order: 1, context: { title: 'Hello' } },
      ],
    });
    expect(result.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(result.messages[0]!.content).toBe('You are the system.');
    expect(result.messages[1]!.content).toBe('Title: Hello');
  });

  it('rejects a system message after non-system content', async () => {
    const pack = await loadPack();
    expect(() =>
      assemblePrompt({
        pack,
        steps: [
          { ref: { locale: 'en', name: 'user' }, role: 'user', order: 0, context: { title: 'x' } },
          { ref: { locale: 'en', name: 'sys' }, role: 'system', order: 1, context: {} },
        ],
      }),
    ).toThrow(TemplateLoadError);
    expect(() =>
      assemblePrompt({
        pack,
        steps: [
          { ref: { locale: 'en', name: 'user' }, role: 'user', order: 0, context: { title: 'x' } },
          { ref: { locale: 'en', name: 'sys' }, role: 'system', order: 1, context: {} },
        ],
      }),
    ).toThrow(/system message at slot 'system:1'/);
  });

  it('rejects duplicate slots', async () => {
    const pack = await loadPack();
    expect(() =>
      assemblePrompt({
        pack,
        steps: [
          { ref: { locale: 'en', name: 'user' }, role: 'user', order: 0, context: { title: 'x' } },
          { ref: { locale: 'en', name: 'list' }, role: 'user', order: 0, context: { items: [] } },
        ],
      }),
    ).toThrow(/duplicate prompt slot/);
  });

  it('returns include resolution order', async () => {
    const pack = await loadPack();
    const result = assemblePrompt({
      pack,
      steps: [
        { ref: { locale: 'en', name: 'list' }, role: 'user', order: 0, context: { items: ['a', 'b'] } },
      ],
    });
    expect(result.messages[0]!.content).toBe('ab');
  });

  it('propagates undeclared-variable load errors', async () => {
    // The load-time validation in loadPromptPack rejects the pack before any
    // assemblePrompt call; a bad template surfaces at load, not at render.
    await expect(
      loadPromptPack(makePack({ 'en/bad.tmpl': '{{ undeclared_var }}' })),
    ).rejects.toThrow(TemplateLoadError);
  });
});
