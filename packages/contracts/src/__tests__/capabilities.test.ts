import { describe, expect, it } from 'vitest';
import { REGISTRY, validateManifestCapabilities } from '../capabilities.js';

describe('capability registry', () => {
  it('contains no platform.* capability in V1 (the load-bearing fact, plan §7.1/D2)', () => {
    const ids = Object.keys(REGISTRY);
    expect(ids.some((id) => id.startsWith('platform.'))).toBe(false);
    expect(ids.some((id) => id.startsWith('publish.'))).toBe(false);
  });

  it('risk-3 namespace is empty', () => {
    for (const def of Object.values(REGISTRY)) {
      expect(def.risk).toBeLessThanOrEqual(2);
    }
  });

  it('rejects a tool outside the registry', () => {
    expect(validateManifestCapabilities(['platform.send'], 'trusted').length).toBeGreaterThan(0);
  });

  it('rejects a trusted tool in quarantine zone', () => {
    expect(validateManifestCapabilities(['voice.read_pack'], 'quarantine').length).toBeGreaterThan(0);
  });

  it('accepts a valid manifest tool set', () => {
    expect(validateManifestCapabilities(['voice.read_pack', 'channel.read_recent', 'draft.write'], 'trusted')).toEqual([]);
  });

  it('quarantine zone allows read-only tools only', () => {
    // source.read_snapshot is risk 0 and allowed in quarantine
    expect(validateManifestCapabilities(['source.read_snapshot'], 'quarantine')).toEqual([]);
    // draft.write is risk 1 and not allowed in quarantine
    expect(validateManifestCapabilities(['draft.write'], 'quarantine').length).toBeGreaterThan(0);
  });
});
