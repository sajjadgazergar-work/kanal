import { describe, expect, it } from 'vitest';
import { loadEgress, checkEgress, egressAllows, type EgressState } from '../egress.js';

describe('egress guard (plan §11.8 air-gapped mode)', () => {
  it('allow mode (no KANAL_EGRESS=deny) permits everything', () => {
    const state = loadEgress({});
    expect(state.mode).toBe('allow');
    expect(checkEgress(state, 'https://api.openai.com/v1/models')).toBe(true);
    expect(checkEgress(state, 'http://10.0.0.5')).toBe(true);
  });

  it('deny mode blocks hosts outside the allow-list before a socket opens', () => {
    const state = loadEgress({ KANAL_EGRESS: 'deny', KANAL_EGRESS_ALLOW: 'localhost,10.0.0.0/8' });
    expect(state.mode).toBe('deny');
    // Invoking the guard directly — this is what runs before a socket opens.
    expect(checkEgress(state, 'https://api.openai.com/v1/models')).toBe(false);
    expect(checkEgress(state, 'http://localhost:11434/api/tags')).toBe(true);
    expect(checkEgress(state, 'http://10.0.0.9/api/tags')).toBe(true);
    expect(checkEgress(state, 'http://11.0.0.9')).toBe(false);
  });

  it('allow-list permits by hostname and by CIDR, blocks others', () => {
    const state = loadEgress({ KANAL_EGRESS: 'deny', KANAL_EGRESS_ALLOW: 'ollama,192.168.1.0/24,example.com' });
    expect(egressAllows(state, { host: 'ollama' })).toBe(true);
    expect(egressAllows(state, { host: 'example.com' })).toBe(true);
    expect(egressAllows(state, { host: 'example.org' })).toBe(false);
    expect(egressAllows(state, { ip: '192.168.1.55' })).toBe(true);
    expect(egressAllows(state, { ip: '192.168.2.55' })).toBe(false);
  });

  it('egress guard runs before a socket opens — direct invocation test', () => {
    const state: EgressState = loadEgress({
      KANAL_EGRESS: 'deny',
      KANAL_EGRESS_ALLOW: 'localhost',
    });
    // This is the exact call the transport makes before fetch().
    expect(checkEgress(state, 'http://localhost:11434/api/tags')).toBe(true);
    expect(checkEgress(state, 'https://openrouter.ai/api/v1/models')).toBe(false);
  });

  it('empty allow-list in deny mode blocks everything', () => {
    const state = loadEgress({ KANAL_EGRESS: 'deny', KANAL_EGRESS_ALLOW: '' });
    expect(state.allow).toHaveLength(0);
    expect(checkEgress(state, 'https://api.openai.com/v1/models')).toBe(false);
    expect(checkEgress(state, 'http://localhost')).toBe(false);
  });

  it('handles trailing-dot hostnames', () => {
    const state = loadEgress({ KANAL_EGRESS: 'deny', KANAL_EGRESS_ALLOW: 'ollama' });
    expect(checkEgress(state, 'http://ollama./api/tags')).toBe(true);
  });

  it('parses a /32 CIDR as an exact IP', () => {
    const state = loadEgress({ KANAL_EGRESS: 'deny', KANAL_EGRESS_ALLOW: '10.1.2.3/32' });
    expect(checkEgress(state, 'http://10.1.2.3/x')).toBe(true);
    expect(checkEgress(state, 'http://10.1.2.4/x')).toBe(false);
  });

  it('matches IP-literal base URLs against CIDR entries', () => {
    const state = loadEgress({ KANAL_EGRESS: 'deny', KANAL_EGRESS_ALLOW: '10.0.0.0/8' });
    expect(checkEgress(state, 'http://10.0.0.5:8000/v1/models')).toBe(true);
  });
});
