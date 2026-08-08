import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY } from '../src/toolRegistry.js';
import type { RunCtx } from '@kanal/core';

/** A minimal RunCtx; the deterministic tools only read args, never ctx. */
function ctx(): RunCtx {
  return {
    run: {
      id: 'run-1', orgId: 'org-1', channelId: 'ch-1', lane: 'auto',
      state: 'review_pending', brief: {}, budgetCapUsd: 0.15, spentUsd: 0,
      cancelRequested: false,
    },
    model: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 }, modelRef: 'tier:M' }),
    tool: async () => ({}),
    memoized: async (_k, fn) => fn(),
    log: () => {},
  };
}

describe('policy.classify (plan §9.2 #11, §15.6)', () => {
  it('allows a clean post through', async () => {
    const out = await TOOL_REGISTRY['policy.classify']({ text: 'A normal post about a new feature.' }, ctx());
    expect(out).toMatchObject({ riskClass: 0, isPromotional: false, prohibited: [] });
  });

  it('blocks prohibited content deterministically', async () => {
    const out = await TOOL_REGISTRY['policy.classify'](
      { text: 'This is a hate speech post that should be blocked.' },
      ctx(),
    );
    expect(out.riskClass).toBe(3);
    expect(out.prohibited.length).toBeGreaterThan(0);
    expect(out.prohibited.join(' ')).toContain('hate');
  });

  it('escalates a financial-advice post without hard-blocking', async () => {
    const out = await TOOL_REGISTRY['policy.classify'](
      { text: 'Buy the dip now — double your money with guaranteed return.' },
      ctx(),
    );
    expect(out.riskClass).toBeGreaterThanOrEqual(1);
    expect(out.prohibited).toEqual([]);
  });
});

describe('platform.publish (plan §10.5)', () => {
  it('returns a deterministic dryrun id when no bot token is present', async () => {
    const out = await TOOL_REGISTRY['platform.publish'](
      {
        postId: 'post-1', revisionId: 'rev-1', channelId: 'ch-1', partIndex: 0,
        bodyRendered: '<b>hello</b>',
      },
      ctx(),
    );
    expect(typeof out.platformPostId).toBe('string');
    expect(out.platformPostId).toMatch(/^dryrun:/);
  });

  it('is idempotent across identical calls', async () => {
    const args = {
      postId: 'post-1', revisionId: 'rev-1', channelId: 'ch-1', partIndex: 0,
      bodyRendered: '<b>hello</b>',
    };
    const a = await TOOL_REGISTRY['platform.publish'](args, ctx());
    const b = await TOOL_REGISTRY['platform.publish'](args, ctx());
    expect(a.platformPostId).toBe(b.platformPostId);
  });
});

describe('measure.metrics (plan §9.2 #15, §17.2)', () => {
  it('returns degraded zeros when the sidecar is off', async () => {
    const out = await TOOL_REGISTRY['measure.metrics']({ platformPostId: 'msg-42' }, ctx());
    expect(out).toMatchObject({ views: 0, reactions: 0, comments: 0, platformPostId: 'msg-42', degraded: true });
  });
});

describe('registry integrity', () => {
  it('exposes exactly the three deterministic capabilities (plan §7.2)', () => {
    expect(Object.keys(TOOL_REGISTRY).sort()).toEqual(
      ['measure.metrics', 'platform.publish', 'policy.classify'].sort(),
    );
  });
});
