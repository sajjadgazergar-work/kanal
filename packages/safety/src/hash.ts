import { createHash } from 'node:crypto';

/**
 * Deterministic hashing helpers (plan §15.7, §16.1).
 *
 * - `sha256Hex` is the workhorse for the audit hash chain and PII detection.
 * - `canonicalJson` produces stable JSON (sorted keys, no whitespace) so the
 *   audit chain hash is reproducible across serializers.
 */

/** Hex SHA-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Stable JSON serialization: sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value === 'object') {
    if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
