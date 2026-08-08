import type { Capability, CapabilityDescriptor, PlatformAdapter } from './types.js';

/**
 * Conformance test kit (plan §10.8).
 *
 * A set of pure checks that assert a `CapabilityDescriptor` and the adapter
 * behind it are internally consistent. The load-bearing rule: a capability
 * present in the descriptor implies the corresponding method is defined on the
 * adapter, and vice versa — a method defined for a capability absent from the
 * descriptor is dead code and a mismatch the UI would trust incorrectly.
 *
 * Every adapter package's `*.conformance.test.ts` calls `checkAdapter` and
 * expects `[]`.
 */

/** Which capabilities drive optional adapter methods, and which method each drives. */
export const CAPABILITY_METHOD_MAP: ReadonlyArray<{
  capability: Capability;
  method: keyof PlatformAdapter;
}> = [
  { capability: 'post.edit_text', method: 'editText' },
  { capability: 'post.edit_caption', method: 'editCaption' },
  { capability: 'post.delete', method: 'delete' },
  { capability: 'read.member_count', method: 'readMemberCount' },
  { capability: 'read.post_views', method: 'readPostMetrics' },
  { capability: 'read.growth_series', method: 'readGrowthSeries' },
];

/**
 * Capabilities every V1 platform must declare. The universal minimum is the
 * ability to post text (post.text) and at least one markup mode (checked
 * separately by `no-markup`, since a platform may offer html, markdown_v2,
 * entities, or none — Telegram does not declare markup.none). Update streams
 * are NOT required — Eitaa is write-mostly with no `update.*` at all (§10.8),
 * and the UI must hide analytics there.
 */
export const REQUIRED_CAPABILITIES: readonly Capability[] = ['post.text'];

/** A violation of descriptor/method or descriptor/limits consistency. */
export interface ConformanceIssue {
  code: string;
  message: string;
}

/** Validate a descriptor on its own. Returns an empty array when consistent. */
export function checkDescriptor(d: CapabilityDescriptor): ConformanceIssue[] {
  const issues: ConformanceIssue[] = [];

  // Required capabilities for a V1 platform.
  for (const cap of REQUIRED_CAPABILITIES) {
    if (!d.capabilities.has(cap)) {
      issues.push({
        code: 'missing-required-capability',
        message: `descriptor for platform '${d.platform}' is missing required capability '${cap}'`,
      });
    }
  }

  // Limits sanity — numeric, finite, non-negative where a count is expected.
  const l = d.limits;
  const numericLimits: ReadonlyArray<[string, number | null]> = [
    ['textMaxChars', l.textMaxChars],
    ['captionMaxChars', l.captionMaxChars],
    ['mediaGroupMax', l.mediaGroupMax],
    ['globalSendPerSecond', l.globalSendPerSecond],
    ['perChatSendPerSecond', l.perChatSendPerSecond],
    ['perGroupSendPerMinute', l.perGroupSendPerMinute],
    ['nativeScheduledMax', l.nativeScheduledMax],
  ];
  for (const [name, value] of numericLimits) {
    if (value === null) continue;
    if (!Number.isFinite(value) || value < 0) {
      issues.push({
        code: 'invalid-limit',
        message: `limit '${name}' must be null or a finite non-negative number, got ${value}`,
      });
    }
  }
  if (l.textMaxChars < 1) {
    issues.push({ code: 'invalid-limit', message: `textMaxChars must be >= 1, got ${l.textMaxChars}` });
  }
  // captionMaxChars: 0 means the platform has NO caption concept (X, Reddit);
  // positive is a real limit. Only a negative value is invalid (already caught
  // by the finite/non-negative scan above, kept here for a precise message).
  if (l.captionMaxChars < 0) {
    issues.push({ code: 'invalid-limit', message: `captionMaxChars must be 0 (no caption) or >= 1, got ${l.captionMaxChars}` });
  }

  // Window semantics: -1 means unlimited, null means never, positive means a window.
  for (const name of ['deleteWindowSeconds', 'editWindowSeconds'] as const) {
    const v = l[name];
    if (v !== null && v !== -1 && v <= 0) {
      issues.push({
        code: 'invalid-window',
        message: `${name} must be -1 (unlimited), null (never), or a positive second count; got ${v}`,
      });
    }
  }

  // Markup: at least one markup capability must be present.
  const markupCaps: Capability[] = ['markup.html', 'markup.markdown_v2', 'markup.entities', 'markup.none'];
  if (!markupCaps.some((c) => d.capabilities.has(c))) {
    issues.push({
      code: 'no-markup',
      message: `descriptor for platform '${d.platform}' declares no markup capability`,
    });
  }

  // Editing implies posting.
  if (d.capabilities.has('post.edit_text') && !d.capabilities.has('post.text')) {
    issues.push({
      code: 'edit-without-post',
      message: `platform '${d.platform}' declares post.edit_text but not post.text`,
    });
  }
  if (d.capabilities.has('post.edit_caption') && !d.capabilities.has('post.media_single')) {
    issues.push({
      code: 'caption-without-media',
      message: `platform '${d.platform}' declares post.edit_caption but not post.media_single`,
    });
  }

  return issues;
}

/**
 * Validate an adapter against its descriptor: descriptor/method consistency
 * plus the static `checkDescriptor` rules. Returns an empty array when the
 * adapter conforms. This is the check each adapter package's conformance test
 * runs.
 */
export function checkAdapter(
  adapter: PlatformAdapter,
  descriptor: CapabilityDescriptor,
): ConformanceIssue[] {
  const issues = checkDescriptor(descriptor);

  for (const { capability, method } of CAPABILITY_METHOD_MAP) {
    const present = descriptor.capabilities.has(capability);
    const defined = typeof adapter[method] === 'function';
    if (present && !defined) {
      issues.push({
        code: 'capability-without-method',
        message: `descriptor declares '${capability}' but adapter does not implement '${String(method)}'`,
      });
    }
    if (defined && !present) {
      issues.push({
        code: 'method-without-capability',
        message: `adapter implements '${String(method)}' but descriptor does not declare '${capability}'`,
      });
    }
  }

  if (adapter.kind !== descriptor.platform) {
    issues.push({
      code: 'kind-mismatch',
      message: `adapter.kind '${adapter.kind}' does not match descriptor.platform '${descriptor.platform}'`,
    });
  }

  return issues;
}

/** True when the adapter conforms to the descriptor. */
export function adapterIsConformant(
  adapter: PlatformAdapter,
  descriptor: CapabilityDescriptor,
): boolean {
  return checkAdapter(adapter, descriptor).length === 0;
}
