import { describe, expect, it } from 'vitest';
import {
  org, channel, source, sourceItem, run, runStep, post, postRevision,
  approval, publishAttempt, claim, provider, model, costLedger,
} from '../schema.js';
import { ENABLE_RLS_SQL, RLS_POLICY_SQL } from '../rls.js';
import { DEFAULT_PRICES } from '../seed.js';

describe('schema', () => {
  it('every non-root core table carries org_id for RLS', () => {
    const tables = [channel, source, sourceItem, run, runStep, post, postRevision, approval, publishAttempt];
    for (const t of tables) {
      expect(t).toHaveProperty('orgId');
    }
    // the org table is the root — it is keyed by its own id
    expect(org).toHaveProperty('id');
    expect(org).not.toHaveProperty('orgId');
  });

  it('approval has payload_hash for the anti-TOCTOU control (plan §4.3)', () => {
    expect(approval).toHaveProperty('payloadHash');
  });

  it('run_step has an idempotency key for memoization (plan §12.1)', () => {
    expect(runStep).toHaveProperty('idempotencyKey');
  });

  it('publish_attempt is per-target (plan §6.4 platform #5)', () => {
    expect(publishAttempt).toHaveProperty('platform');
    expect(publishAttempt).toHaveProperty('idempotencyKey');
  });

  it('source_item carries injection_flags (plan §16.1 advisory detector)', () => {
    expect(sourceItem).toHaveProperty('injectionFlags');
  });

  it('cost ledger is append-only per model call (plan §7.8)', () => {
    expect(costLedger).toHaveProperty('pricingConfidence');
    expect(costLedger).toHaveProperty('costUsd');
  });

  it('post_revision carries content_sha256 that approvals bind to', () => {
    expect(postRevision).toHaveProperty('contentSha256');
  });
});

describe('RLS', () => {
  it('emits an ENABLE ROW LEVEL SECURITY per table', () => {
    expect(ENABLE_RLS_SQL.split('ALTER TABLE').length).toBeGreaterThan(20);
  });

  it('emits org_isolation policies scoped to current_setting', () => {
    expect(RLS_POLICY_SQL).toContain('kanal.org_id');
    expect(RLS_POLICY_SQL).toContain('current_setting');
  });
});

describe('seed prices', () => {
  it('covers all five tier bands', () => {
    const refs = DEFAULT_PRICES.map((p) => p.modelRef);
    expect(refs).toContain('tier:S');
    expect(refs).toContain('tier:M');
    expect(refs).toContain('tier:L');
    expect(refs).toContain('tier:V');
    expect(refs).toContain('tier:local');
  });

  it('local tier is zero marginal cost', () => {
    const local = DEFAULT_PRICES.find((p) => p.modelRef === 'tier:local');
    expect(local?.inputUsdPerMtok).toBe('0.00');
    expect(local?.outputUsdPerMtok).toBe('0.00');
  });
});

// Reference tables exist for schema validation
void provider;
void model;
void claim;
