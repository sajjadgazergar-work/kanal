import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_METHOD_MAP,
  checkAdapter,
  checkDescriptor,
  type CapabilityDescriptor,
} from '../index.js';

/**
 * Conformance kit self-tests (plan §10.2/§10.8). These assert the kit itself
 * behaves: descriptor/method consistency is caught in both directions, and a
 * well-formed descriptor passes.
 */

function makeDescriptor(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    platform: 'telegram',
    provenance: 'static',
    capabilities: new Set(['post.text', 'markup.html', 'markup.none', 'update.long_poll', 'update.webhook']),
    limits: {
      textMaxChars: 4096,
      captionMaxChars: 1024,
      mediaGroupMax: 10,
      deleteWindowSeconds: 48 * 3600,
      editWindowSeconds: -1,
      globalSendPerSecond: 30,
      perChatSendPerSecond: 1,
      perGroupSendPerMinute: 20,
      nativeScheduledMax: null,
    },
    notes: {},
    ...overrides,
  };
}

describe('checkDescriptor', () => {
  it('accepts a well-formed descriptor', () => {
    expect(checkDescriptor(makeDescriptor())).toEqual([]);
  });

  it('flags no markup capability', () => {
    const d = makeDescriptor({ capabilities: new Set(['post.text', 'update.long_poll', 'update.webhook']) });
    expect(checkDescriptor(d).some((i) => i.code === 'no-markup')).toBe(true);
  });

  it('flags a missing required capability (post.text)', () => {
    const d = makeDescriptor({ capabilities: new Set(['markup.html']) });
    const issues = checkDescriptor(d);
    expect(issues.some((i) => i.code === 'missing-required-capability' && i.message.includes('post.text'))).toBe(true);
  });

  it('flags an invalid limit', () => {
    const d = makeDescriptor();
    d.limits.globalSendPerSecond = -5;
    expect(checkDescriptor(d).some((i) => i.code === 'invalid-limit')).toBe(true);
  });

  it('accepts -1 and null window semantics', () => {
    const d = makeDescriptor({
      limits: {
        textMaxChars: 4096,
        captionMaxChars: 1024,
        mediaGroupMax: 10,
        deleteWindowSeconds: null,
        editWindowSeconds: -1,
        globalSendPerSecond: 30,
        perChatSendPerSecond: 1,
        perGroupSendPerMinute: null,
        nativeScheduledMax: null,
      },
    });
    expect(checkDescriptor(d)).toEqual([]);
  });

  it('flags edit_text without post.text', () => {
    const d = makeDescriptor({
      capabilities: new Set(['post.edit_text', 'post.media_single', 'markup.html', 'update.long_poll', 'update.webhook']),
    });
    expect(checkDescriptor(d).some((i) => i.code === 'edit-without-post')).toBe(true);
  });
});

describe('checkAdapter', () => {
  // A conforming adapter: every capability in the BASE descriptor has its
  // method, and no method is defined for a capability the base lacks.
  const conforming = {
    kind: 'telegram' as const,
    describe: async () => makeDescriptor(),
    verifyCredentials: async () => ({ kind: 'invalid' as const, reason: 'not implemented' }),
    render: () => {
      throw new Error('unused');
    },
    publish: async () => ({ kind: 'rejected' as const, code: 'not_implemented', description: 'x', permanent: true }),
    limiter: {
      allow: async () => ({ allowed: true, retryAfterMs: 0 }),
      noteBackoff: () => undefined,
      noteSuccess: () => undefined,
    },
  };

  it('accepts a conforming adapter', () => {
    const d = makeDescriptor();
    expect(checkAdapter(conforming, d)).toEqual([]);
  });

  it('flags a capability present but its method absent', () => {
    const d = makeDescriptor({
      capabilities: new Set(['post.text', 'post.edit_text', 'markup.html', 'update.long_poll', 'update.webhook']),
    });
    // conforming has no editText; descriptor declares post.edit_text.
    const issues = checkAdapter(conforming, d);
    expect(issues.some((i) => i.code === 'capability-without-method' && i.message.includes('post.edit_text'))).toBe(true);
  });

  it('flags a method present but its capability absent', () => {
    const d = makeDescriptor(); // no post.edit_text
    const issues = checkAdapter(
      { ...conforming, editText: async () => ({ kind: 'not_modified' as const }) },
      d,
    );
    expect(issues.some((i) => i.code === 'method-without-capability' && i.message.includes('editText'))).toBe(true);
  });

  it('flags a kind/platform mismatch', () => {
    const d = makeDescriptor({ platform: 'bale' });
    expect(checkAdapter(conforming, d).some((i) => i.code === 'kind-mismatch')).toBe(true);
  });

  it('the method map covers every optional adapter method', () => {
    const methods = CAPABILITY_METHOD_MAP.map((m) => m.method).sort();
    expect(methods).toEqual(['delete', 'editCaption', 'editText', 'readGrowthSeries', 'readMemberCount', 'readPostMetrics']);
  });
});
