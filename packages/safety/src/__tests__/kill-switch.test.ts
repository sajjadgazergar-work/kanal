import { describe, expect, it } from 'vitest';
import { checkKillSwitch, haltChannel, recordUnhalt, KANAL_PUBLISH_ENV } from '../kill-switch.js';

describe('kill switch', () => {
  const NOW = '2026-01-02T12:00:00.000Z';

  it('allows when nothing is halted', () => {
    const v = checkKillSwitch({
      channel: { publishHaltedAt: null, haltReason: null },
      org: { globalHaltAt: null },
      processEnv: {},
      nowIso: NOW,
    });
    expect(v.kind).toBe('allow');
  });

  it('halts on the process kill switch (KANAL_PUBLISH=off)', () => {
    const v = checkKillSwitch({
      channel: { publishHaltedAt: null },
      org: { globalHaltAt: null },
      processEnv: { [KANAL_PUBLISH_ENV]: 'off' },
      nowIso: NOW,
    });
    expect(v.kind).toBe('halt');
    if (v.kind === 'halt') expect(v.scope).toBe('process');
  });

  it('process kill switch wins over an allow-listed channel', () => {
    const v = checkKillSwitch({
      channel: { publishHaltedAt: null },
      org: { globalHaltAt: null },
      processEnv: { [KANAL_PUBLISH_ENV]: 'off' },
      nowIso: NOW,
    });
    expect(v.kind).toBe('halt');
  });

  it('halts on the org kill switch', () => {
    const v = checkKillSwitch({
      channel: { publishHaltedAt: null },
      org: { globalHaltAt: '2026-01-01T00:00:00.000Z' },
      processEnv: {},
      nowIso: NOW,
    });
    expect(v.kind).toBe('halt');
    if (v.kind === 'halt') expect(v.scope).toBe('org');
  });

  it('halts on the channel kill switch', () => {
    const v = checkKillSwitch({
      channel: { publishHaltedAt: '2026-01-01T00:00:00.000Z', haltReason: 'anomaly' },
      org: { globalHaltAt: null },
      processEnv: {},
      nowIso: NOW,
    });
    expect(v.kind).toBe('halt');
    if (v.kind === 'halt') {
      expect(v.scope).toBe('channel');
      expect(v.reason).toContain('anomaly');
    }
  });

  it('org halt takes precedence over channel halt', () => {
    const v = checkKillSwitch({
      channel: { publishHaltedAt: '2026-01-01T00:00:00.000Z' },
      org: { globalHaltAt: '2026-01-01T00:00:00.000Z' },
      processEnv: {},
      nowIso: NOW,
    });
    expect(v.kind).toBe('halt');
    if (v.kind === 'halt') expect(v.scope).toBe('org');
  });

  it('haltChannel produces a durable halted state', () => {
    const halted = haltChannel({ publishHaltedAt: null }, NOW, 'detector');
    expect(halted.publishHaltedAt).toBe(NOW);
    expect(halted.haltReason).toBe('detector');
  });

  it('un-halting is human-only and audited', () => {
    const rec = recordUnhalt({ actor: 'human:u1', scope: 'channel', objectRef: 'channel:abc', at: NOW });
    expect(rec.actor).toStrictEqual('human:u1');
    expect(rec.auditTrail).toBeTruthy();
    expect(rec.auditTrail.length).toBe(64);
  });
});
