import { describe, expect, it } from 'vitest';
import { moderateOutbound, moderateIngest } from '../moderation.js';

describe('moderation pipeline (plan §15.4)', () => {
  it('ingest hits are stored redacted with pii_redacted flag', () => {
    const r = moderateIngest('Contact support@kanal.dev or 0912 345 6789 about the draft.');
    expect(r.piiRedacted).toBe(true);
    expect(r.redactedBody).not.toContain('support@kanal.dev');
    expect(r.redactedBody).not.toContain('0912 345 6789');
  });

  it('benign ingest passes without redaction', () => {
    const r = moderateIngest('A plain analysis of the latest benchmark.');
    expect(r.piiRedacted).toBe(false);
    expect(r.redactedBody).toBe('A plain analysis of the latest benchmark.');
  });

  it('outbound PII blocks publish and requires an audited override', () => {
    const r = moderateOutbound('The contact is support@kanal.dev for more.');
    expect(r.blocked).toBe(true);
    expect(r.blockedReason).toContain('PII');
    expect(r.classification.verdict).toBe('allow'); // PII is a separate gate
  });

  it('outbound hard-block category blocks publish', () => {
    const r = moderateOutbound('We will bomb the building and shoot anyone inside.');
    expect(r.blocked).toBe(true);
    expect(r.blockedReason).toContain('policy block');
    expect(r.classification.verdict).toBe('block');
  });

  it('outbound escalation does not block, it forces review', () => {
    const r = moderateOutbound('invest your savings in this fund, guaranteed return');
    expect(r.blocked).toBe(false);
    expect(r.classification.verdict).toBe('escalate');
    expect(r.classification.riskClass).toBeGreaterThanOrEqual(1);
  });

  it('clean outbound passes', () => {
    const r = moderateOutbound('A short analysis of the latest model results with a chart.');
    expect(r.blocked).toBe(false);
    expect(r.classification.verdict).toBe('allow');
  });
});
