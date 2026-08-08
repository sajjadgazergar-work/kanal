import { sha256Hex } from './hash.js';

/**
 * Kill switch (plan §15.6 #5, §4.2).
 *
 * Three scopes, all a single durable field checked in the publisher's final
 * gate **immediately before the HTTP call** — not a scheduling-time check, so
 * a post already in flight through the queue still stops.
 *
 *   | Scope    | Field                     | Who can set                         |
 *   |----------|---------------------------|-------------------------------------|
 *   | Channel  | channel.publish_halted_at | Human, or the anomaly detector      |
 *   | Org      | org.global_halt_at        | Human only                          |
 *   | Process  | KANAL_PUBLISH=off env     | Operator at the shell               |
 *
 * Un-halting is always human-only and always audited.
 */

export interface ChannelHaltState {
  publishHaltedAt: string | null;
  haltReason?: string | null;
}

export interface OrgHaltState {
  globalHaltAt: string | null;
}

export interface KillSwitchCheckInput {
  channel: ChannelHaltState;
  org: OrgHaltState;
  processEnv: Record<string, string | undefined>;
  /** Set when the check runs after an un-halt action — the audit trail. */
  nowIso?: string;
}

export type KillSwitchVerdict =
  | { kind: 'allow' }
  | { kind: 'halt'; scope: 'channel' | 'org' | 'process'; reason: string; at: string };

export const KANAL_PUBLISH_ENV = 'KANAL_PUBLISH';

/**
 * The final gate. Runs the instant before the socket write. Returns `halt`
 * with the blocking scope; a halted scope is a hard block, and the caller
 * must not proceed to the platform call.
 */
export function checkKillSwitch(input: KillSwitchCheckInput): KillSwitchVerdict {
  const now = input.nowIso ?? new Date().toISOString();

  if (input.processEnv[KANAL_PUBLISH_ENV] === 'off') {
    return { kind: 'halt', scope: 'process', at: now, reason: `process kill switch (${KANAL_PUBLISH_ENV}=off)` };
  }
  if (input.org.globalHaltAt !== null && input.org.globalHaltAt !== undefined) {
    return { kind: 'halt', scope: 'org', at: now, reason: `org-wide halt since ${input.org.globalHaltAt}` };
  }
  if (input.channel.publishHaltedAt !== null && input.channel.publishHaltedAt !== undefined) {
    return {
      kind: 'halt',
      scope: 'channel',
      at: now,
      reason: `channel halt since ${input.channel.publishHaltedAt}${input.channel.haltReason ? ` (${input.channel.haltReason})` : ''}`,
    };
  }
  return { kind: 'allow' };
}

export interface UnhaltRecord {
  actor: string;
  scope: 'channel' | 'org';
  at: string;
  objectRef: string;
  /** The audit hash-chain link this un-halt would append (see audit-chain.ts). */
  auditTrail: string;
}

/**
 * Un-halting is human-only. Produces the audit row payload (the caller appends
 * it to the audit chain). Returns the record for the audit log.
 */
export function recordUnhalt(opts: {
  actor: string;
  scope: 'channel' | 'org';
  objectRef: string;
  at?: string;
}): UnhaltRecord {
  const at = opts.at ?? new Date().toISOString();
  return {
    actor: opts.actor,
    scope: opts.scope,
    at,
    objectRef: opts.objectRef,
    auditTrail: sha256Hex(`unhalt:${opts.actor}:${opts.scope}:${opts.objectRef}:${at}`),
  };
}

/** Convenience: halt a channel (used by the anomaly detector and humans). */
export function haltChannel(channel: ChannelHaltState, at: string, reason: string): ChannelHaltState {
  return { publishHaltedAt: at, haltReason: reason };
}
