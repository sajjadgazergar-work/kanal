import { createHash } from 'node:crypto';
import type { AgentManifest } from '@kanal/contracts';
import { satisfiesCoreApi } from '@kanal/contracts';
import { ROLE_DEFAULTS, validateManifestCapabilities } from '@kanal/contracts';

/**
 * Override resolution (plan §7.7). Four layers, merged deterministically at
 * run start, hashed into `run.manifest_set_hash`:
 *
 *   core defaults  ←  org overrides  ←  channel overrides  ←  run overrides (CO-PILOT only)
 *
 * Merge is a typed deep-merge with `null` meaning "reset to the layer below"
 * and arrays replaced wholesale. The resolved set is serialized canonically
 * (JCS, RFC 8785) and hashed with SHA-256.
 */

type Json = Record<string, unknown>;

/** Deterministic canonical serialization (RFC 8785 subset). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('canonical JSON forbids non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Json;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Deep-merge with `null` = reset-to-layer-below, arrays replaced wholesale. */
export function typedDeepMerge<T extends Json>(base: T, override: Partial<T> | null | undefined): T {
  if (!override) return base;
  const out: Json = { ...(base as Json) };
  for (const [k, v] of Object.entries(override)) {
    if (v === null) {
      delete out[k]; // reset to the layer below — key absent at this layer
      continue;
    }
    if (Array.isArray(v)) {
      out[k] = v; // arrays replaced wholesale
      continue;
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const baseV = (base as Json)[k];
      out[k] =
        baseV !== null && typeof baseV === 'object' && !Array.isArray(baseV)
          ? typedDeepMerge(baseV as Json, v as Json)
          : v;
      continue;
    }
    out[k] = v;
  }
  return out as T;
}

/** Merge order: core defaults ← org ← channel ← run. */
export function resolveManifestSet(
  coreDefaults: Record<string, AgentManifest>,
  orgOverrides: Record<string, Partial<AgentManifest>>,
  channelOverrides: Record<string, Partial<AgentManifest>> = {},
  runOverrides: Record<string, Partial<AgentManifest>> = {},
): { manifests: Record<string, AgentManifest>; hash: string } {
  const merged: Record<string, AgentManifest> = {};
  for (const [id, core] of Object.entries(coreDefaults)) {
    const layer1 = typedDeepMerge(core as unknown as Json, orgOverrides[id] as unknown as Json) as unknown as AgentManifest;
    const layer2 = typedDeepMerge(layer1 as unknown as Json, channelOverrides[id] as unknown as Json) as unknown as AgentManifest;
    const layer3 = typedDeepMerge(layer2 as unknown as Json, runOverrides[id] as unknown as Json) as unknown as AgentManifest;
    merged[id] = layer3;
  }
  const hash = sha256(canonicalJson(merged));
  return { manifests: merged, hash };
}

/** Manifest loader enforcement (plan §7.2, §7.3, §7.6). Returns errors, empty when it loads. */
export function validateManifest(
  manifest: AgentManifest,
  roleDefaults = ROLE_DEFAULTS,
): string[] {
  const errors: string[] = [];
  if (!satisfiesCoreApi(manifest.coreApi)) {
    errors.push(`core_api '${manifest.coreApi}' not satisfied by core ${'^1.2'}`);
  }
  const role = roleDefaults[manifest.metadata.id];
  if (!role) {
    errors.push(`role '${manifest.metadata.id}' is not a known core role`);
    return errors;
  }
  // zone cannot be raised beyond role default
  const roleZone = role.zone;
  const zoneRank = { quarantine: 0, trusted: 1, deterministic: 2 };
  if (zoneRank[manifest.spec.zone] > zoneRank[roleZone]) {
    errors.push(`zone '${manifest.spec.zone}' exceeds the role default '${roleZone}'`);
  }
  if (manifest.spec.stageBinding !== role.stage) {
    errors.push(`stage_binding '${manifest.spec.stageBinding}' does not match the role's stage '${role.stage}'`);
  }
  // tools ⊆ role's allowed set (the role default is the ceiling)
  for (const t of manifest.spec.tools) {
    if (!role.allowedTools.includes(t)) {
      errors.push(`tool '${t}' is not in role '${manifest.metadata.id}' allowed set`);
    }
  }
  const capErrors = validateManifestCapabilities(manifest.spec.tools, manifest.spec.zone);
  errors.push(...capErrors);
  // a manifest that fails any check does not load
  return errors;
}
