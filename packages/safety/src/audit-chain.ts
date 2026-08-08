import { canonicalJson, sha256Hex } from './hash.js';

/**
 * Audit log hash chain (plan §15.7).
 *
 * Append-only; every row carries `prev_hash = sha256(canonical JSON of the
 * previous row)`. `kanal audit verify` walks the chain and reports the first
 * break — the tamper point, so the log is exportable as JSONL and a broken
 * link is attributable.
 *
 * A row has at least: `id`, `orgId`, `actor`, `verb`, `objectRef`, `before`,
 * `after`, `at`, and `prevHash`. `traceId` is optional and participates in the
 * hash when present.
 */

export interface AuditRow {
  id: string;
  orgId: string;
  prevHash: string | null; // null for the genesis row
  actor: string;
  verb: string;
  objectRef: string;
  before?: unknown;
  after?: unknown;
  at: string; // ISO 8601
  traceId?: string;
}

export interface AuditChainBreak {
  /** Index of the first broken row (0-based). */
  index: number;
  /** id of the broken row. */
  id: string;
  /** kind of break: `genesis` — the first row has a non-null prevHash. */
  kind: 'genesis' | 'prev_mismatch';
  expected: string | null;
  actual: string | null;
  message: string;
}

/**
 * Hash of a row's content — the row's canonical JSON *including* its own
 * `prevHash` field, per plan §15.7 (`prev_hash = sha256(previous row canonical
 * JSON)`). The chain is transitive: tampering with any field of any row breaks
 * the link to the next row.
 */
export function hashChainRow(row: AuditRow): string {
  return sha256Hex(canonicalJson(row));
}

/**
 * Walk the chain and report the first break. Returns null when the chain is
 * intact. The genesis row (index 0) must have `prevHash === null`.
 */
export function verifyChain(rows: AuditRow[]): AuditChainBreak | null {
  if (rows.length === 0) return null;
  const first = rows[0]!;
  if (first.prevHash !== null) {
    return {
      index: 0,
      id: first.id,
      kind: 'genesis',
      expected: null,
      actual: first.prevHash,
      message: `genesis row ${first.id} must have prevHash null, got ${first.prevHash}`,
    };
  }
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!;
    const row = rows[i]!;
    if (row.prevHash === null) {
      return {
        index: i,
        id: row.id,
        kind: 'prev_mismatch',
        expected: hashChainRow(prev),
        actual: null,
        message: `row ${row.id} at index ${i} is missing prevHash (expected link to ${prev.id})`,
      };
    }
    const expected = hashChainRow(prev);
    if (row.prevHash !== expected) {
      return {
        index: i,
        id: row.id,
        kind: 'prev_mismatch',
        expected,
        actual: row.prevHash,
        message: `row ${row.id} at index ${i} breaks the chain: prevHash does not match row ${prev.id}`,
      };
    }
  }
  return null;
}

/** Append-only: computes the prevHash for a new row given the current tail. */
export function appendToChain(tail: AuditRow | null, row: Omit<AuditRow, 'prevHash'>): AuditRow {
  return { ...row, prevHash: tail ? hashChainRow(tail) : null };
}
