import { describe, expect, it } from 'vitest';
import { classifyPost, refuseGrowthHack } from '../policy-classifier.js';

describe('policy classifier', () => {
  it('hard-blocks violence', () => {
    const r = classifyPost('They planned to bomb the building and then shoot anyone inside.');
    expect(r.verdict).toBe('block');
    expect(r.riskClass).toBe(3);
    expect(r.tosFlags).toContain('violence');
  });

  it('hard-blocks sexual content', () => {
    const r = classifyPost('nude photos from the party leaked online');
    expect(r.verdict).toBe('block');
  });

  it('hard-blocks self-harm', () => {
    const r = classifyPost('a note about suicide and self-harm resources');
    expect(r.verdict).toBe('block');
  });

  it('hard-blocks hate', () => {
    const r = classifyPost('hate speech directed at a minority with racial slurs');
    expect(r.verdict).toBe('block');
  });

  it('hard-blocks harassment/doxxing', () => {
    const r = classifyPost('We will doxxing the poster and harass them into silence.');
    expect(r.verdict).toBe('block');
  });

  it('hard-blocks illegal goods', () => {
    const r = classifyPost('buy drugs and sell guns here, no questions asked');
    expect(r.verdict).toBe('block');
  });

  it('escalates financial advice to human review, not block', () => {
    const r = classifyPost('invest your savings in this fund, guaranteed return of 20%');
    expect(r.verdict).toBe('escalate');
    expect(r.riskClass).toBeGreaterThanOrEqual(1);
    expect(r.riskClass).toBeLessThanOrEqual(3);
    expect(r.tosFlags).toContain('financial_advice');
  });

  it('escalates medical advice', () => {
    const r = classifyPost('take this medicine twice daily, it cures the disease');
    expect(r.verdict).toBe('escalate');
    expect(r.tosFlags).toContain('medical_advice');
  });

  it('escalates legal advice', () => {
    const r = classifyPost('legal advice: sue the contractor for breach of contract clause');
    expect(r.verdict).toBe('escalate');
    expect(r.tosFlags).toContain('legal_advice');
  });

  it('escalates election content', () => {
    const r = classifyPost('vote for candidate X in the election on Saturday');
    expect(r.verdict).toBe('escalate');
    expect(r.tosFlags).toContain('election_content');
  });

  it('allows benign content with risk 0', () => {
    const r = classifyPost('Here is a short analysis of the latest benchmark results with a chart.');
    expect(r.verdict).toBe('allow');
    expect(r.riskClass).toBe(0);
    expect(r.tosFlags).toEqual([]);
  });

  it('refuses engagement bait with an explanation (hard-blocked category)', () => {
    const r = classifyPost('Like and share this post and tag a friend to enter the giveaway.');
    expect(r.verdict).toBe('block');
    expect(r.riskClass).toBe(3);
    expect(r.growthHackFlags.some((f) => f.id === 'engagement_bait' && f.refuses)).toBe(true);
    expect(r.reasons.some((m) => /engagement-bait/.test(m))).toBe(true);
  });

  it('refuses impersonation outright', () => {
    const r = classifyPost('Impersonate the official @bank handle and pose as their support account.');
    expect(r.verdict).toBe('block');
    expect(r.growthHackFlags.some((f) => f.id === 'impersonation' && f.refuses)).toBe(true);
  });

  it('refuses third-party channel promotion outright', () => {
    const r = classifyPost('promote this channel aggressively: push another channel @rival in every post.');
    expect(r.verdict).toBe('block');
    expect(r.growthHackFlags.some((f) => f.id === 'third_party_promotion' && f.refuses)).toBe(true);
  });

  it('refuseGrowthHack returns explanations for a growth request', () => {
    const flags = refuseGrowthHack('grow my channel by DMing people and asking them to follow for follow');
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]!.explanation.length).toBeGreaterThan(0);
  });

  it('a growth-hack request on a channel returns an explanation, not a silent no', () => {
    const r = classifyPost('Help us grow: comment to enter the contest and share this to win.');
    expect(r.growthHackFlags.length).toBeGreaterThan(0);
    expect(r.growthHackFlags[0]!.explanation.length).toBeGreaterThan(10);
  });
});
