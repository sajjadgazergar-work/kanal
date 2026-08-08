import { describe, it, expect } from 'vitest';
import { canonicalJson, sha256, typedDeepMerge, resolveManifestSet } from '../src/overrides.js';
import type { AgentManifest } from '@kanal/contracts';

describe('canonicalJson (RFC 8785 subset)', () => {
  it('sorts object keys deterministically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ x: NaN })).toThrow();
  });

  it('serializes nested structures', () => {
    expect(canonicalJson({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
  });
});

describe('sha256', () => {
  it('produces a stable hex digest', () => {
    expect(sha256('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('typedDeepMerge', () => {
  it('null resets a key to the layer below', () => {
    const base = { a: { x: 1, y: 2 } };
    const out = typedDeepMerge(base, { a: { x: null } });
    expect(out).toEqual({ a: { y: 2 } });
  });

  it('arrays are replaced wholesale', () => {
    const out = typedDeepMerge({ list: [1, 2] }, { list: [9] });
    expect(out).toEqual({ list: [9] });
  });

  it('nested objects merge recursively', () => {
    const out = typedDeepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3 } });
    expect(out).toEqual({ a: { x: 1, y: 3 } });
  });
});

describe('resolveManifestSet (§7.7)', () => {
  const core = {
    editor: {
      metadata: { id: 'editor', coreApi: '1.0.0' },
      spec: { zone: 'trusted', stageBinding: 'editorial', tools: ['draft.write', 'voice.read_pack'] },
    } as unknown as AgentManifest,
  };

  it('merges org then channel overrides and hashes the result', () => {
    const { manifests, hash } = resolveManifestSet(
      core,
      { editor: { metadata: { id: 'editor', coreApi: '1.0.0' }, spec: { zone: 'trusted', stageBinding: 'editorial', tools: ['draft.write'] } } },
      { editor: { metadata: { id: 'editor', coreApi: '1.0.0' }, spec: { zone: 'trusted', stageBinding: 'editorial', tools: ['draft.write', 'media.generate_image'] } } },
    );
    expect(manifests.editor.spec.tools).toEqual(['draft.write', 'media.generate_image']);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same hash for the same input', () => {
    const a = resolveManifestSet(core, {});
    const b = resolveManifestSet(core, {});
    expect(a.hash).toBe(b.hash);
  });
});
