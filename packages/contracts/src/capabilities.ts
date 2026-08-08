import { z } from 'zod';
import { type Zone } from './domain.js';

/**
 * The capability registry (plan §7.2). Core-owned, never user-extendable.
 * The load-bearing fact: there is no `platform.*` capability in V1, so no
 * agent can request one, so no prompt can talk an agent into publishing.
 */

export const riskClassSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type RiskClass = z.infer<typeof riskClassSchema>;

export interface CapabilityDef {
  id: string;
  risk: RiskClass;
  allowedZones: Zone[];
  /** JSON Schema 7 (as a plain object) — validated before invocation. */
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  costHint: 'free' | 'metered';
  maxCallsPerStep: number;
  /** capabilities with side effects write to these tables only. */
  writes?: string[];
}

export const zoneMaxRisk: Record<Zone, RiskClass> = {
  quarantine: 2, // reads only per plan §16.1
  trusted: 1,
  deterministic: 0,
};

export const CAPABILITY_IDS = [
  'source.read_snapshot',
  'source.search_index',
  'channel.read_recent',
  'metrics.read_summary',
  'voice.read_pack',
  'draft.write',
  'draft.annotate',
  'schedule.propose',
  'approval.request',
  'media.generate_image',
  'web.fetch_allowlisted',
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export const capabilityIdSchema = z.enum(CAPABILITY_IDS);

const emptySchema = { type: 'object', additionalProperties: true };

/**
 * The single source of truth (plan §7.2). Adding a tool here requires a code
 * change and a migration; users select from it, never extend it.
 */
export const REGISTRY: Record<CapabilityId, CapabilityDef> = {
  'source.read_snapshot': {
    id: 'source.read_snapshot',
    risk: 0,
    allowedZones: ['quarantine'],
    inputSchema: { type: 'object', properties: { clusterIds: { type: 'array', items: { type: 'string' } } } },
    outputSchema: emptySchema,
    costHint: 'free',
    maxCallsPerStep: 40,
  },
  'source.search_index': {
    id: 'source.search_index',
    risk: 0,
    allowedZones: ['quarantine', 'trusted'],
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' } } },
    outputSchema: emptySchema,
    costHint: 'free',
    maxCallsPerStep: 8,
  },
  'channel.read_recent': {
    id: 'channel.read_recent',
    risk: 0,
    allowedZones: ['trusted'],
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
    outputSchema: emptySchema,
    costHint: 'free',
    maxCallsPerStep: 4,
  },
  'metrics.read_summary': {
    id: 'metrics.read_summary',
    risk: 0,
    allowedZones: ['trusted'],
    inputSchema: { type: 'object', properties: { windowDays: { type: 'integer' } } },
    outputSchema: emptySchema,
    costHint: 'free',
    maxCallsPerStep: 4,
  },
  'voice.read_pack': {
    id: 'voice.read_pack',
    risk: 0,
    allowedZones: ['trusted'],
    inputSchema: { type: 'object' },
    outputSchema: emptySchema,
    costHint: 'free',
    maxCallsPerStep: 2,
  },
  'draft.write': {
    id: 'draft.write',
    risk: 1,
    allowedZones: ['trusted'],
    inputSchema: { type: 'object', properties: { bodyMd: { type: 'string' }, claimMap: { type: 'object' } } },
    outputSchema: emptySchema,
    costHint: 'free',
    maxCallsPerStep: 1,
    writes: ['post_revision'],
  },
  'draft.annotate': {
    id: 'draft.annotate',
    risk: 1,
    allowedZones: ['trusted'],
    inputSchema: { type: 'object', properties: { annotation: { type: 'string' } } },
    outputSchema: emptySchema,
    costHint: 'free',
    maxCallsPerStep: 12,
    writes: ['post_revision'],
  },
  'schedule.propose': {
    id: 'schedule.propose',
    risk: 1,
    allowedZones: ['trusted'],
    inputSchema: { type: 'object', properties: { scheduledFor: { type: 'string' } } },
    outputSchema: emptySchema,
    costHint: 'free',
    maxCallsPerStep: 1,
    writes: ['post'],
  },
  'approval.request': {
    id: 'approval.request',
    risk: 1,
    allowedZones: ['trusted'],
    inputSchema: { type: 'object', properties: { gate: { type: 'string' } } },
    outputSchema: emptySchema,
    costHint: 'free',
    maxCallsPerStep: 2,
    writes: ['approval'],
  },
  'media.generate_image': {
    id: 'media.generate_image',
    risk: 1,
    allowedZones: ['trusted'],
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
    outputSchema: emptySchema,
    costHint: 'metered',
    maxCallsPerStep: 1,
    writes: ['post_revision'],
  },
  'web.fetch_allowlisted': {
    id: 'web.fetch_allowlisted',
    risk: 2,
    allowedZones: ['quarantine'],
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
    outputSchema: emptySchema,
    costHint: 'free',
    maxCallsPerStep: 6,
  },
};

/** Loader enforcement (plan §7.2): manifest.tools ⊆ REGISTRY, zone in allowedZones, max(risk) ≤ zoneMaxRisk[zone]. */
export function validateManifestCapabilities(tools: string[], zone: Zone): string[] {
  const errors: string[] = [];
  for (const t of tools) {
    const def = REGISTRY[t as CapabilityId];
    if (!def) {
      errors.push(`tool '${t}' is not in the capability registry`);
      continue;
    }
    if (!def.allowedZones.includes(zone)) {
      errors.push(`tool '${t}' is not allowed in zone '${zone}' (allowed: ${def.allowedZones.join(', ')})`);
    }
    if (def.risk > zoneMaxRisk[zone]) {
      errors.push(`tool '${t}' has risk ${def.risk}, exceeding zone max ${zoneMaxRisk[zone]}`);
    }
  }
  return errors;
}
