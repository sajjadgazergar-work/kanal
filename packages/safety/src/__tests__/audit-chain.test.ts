import { describe, expect, it } from 'vitest';
import { appendToChain, hashChainRow, verifyChain, type AuditRow } from '../audit-chain.js';

const ORG = '6f0f5f43-1f4d-4a4f-9d7f-0000000000aa';

function row(id: string, overrides: Partial<AuditRow> = {}): Omit<AuditRow, 'prevHash'> & { prevHash: string | null } {
  return {
    id,
    orgId: ORG,
    prevHash: null,
    actor: 'human:u1',
    verb: 'update',
    objectRef: `channel:${id}`,
    before: { v: 1 },
    after: { v: 2 },
    at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildChain(n: number): AuditRow[] {
  const rows: AuditRow[] = [];
  let tail: AuditRow | null = null;
  for (let i = 0; i < n; i++) {
    const r = appendToChain(tail, { ...row(`row-${i}`), at: `2026-01-0${i + 1}T00:00:00.000Z` });
    rows.push(r);
    tail = r;
  }
  return rows;
}

describe('audit hash chain', () => {
  it('is append-only with linked hashes', () => {
    const rows = buildChain(5);
    expect(rows[0]!.prevHash).toBeNull();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prevHash).toBe(hashChainRow(rows[i - 1]!));
    }
  });

  it('verifyChain returns null for an intact chain', () => {
    expect(verifyChain(buildChain(5))).toBeNull();
  });

  it('verifyChain reports the first break when a row is tampered', () => {
    const rows = buildChain(5);
    // Tamper with row 2's after value.
    rows[2] = { ...rows[2]!, after: { v: 999 } };
    const break_ = verifyChain(rows);
    expect(break_).not.toBeNull();
    if (break_) {
      expect(break_.index).toBe(3); // the link to the tampered row breaks at the next row
      expect(break_.kind).toBe('prev_mismatch');
      expect(break_.id).toBe('row-3');
    }
  });

  it('verifyChain reports a genesis break when the first row has a prevHash', () => {
    const rows = buildChain(2);
    rows[0] = { ...rows[0]!, prevHash: 'deadbeef' };
    const break_ = verifyChain(rows);
    expect(break_).not.toBeNull();
    if (break_) expect(break_.kind).toBe('genesis');
  });

  it('verifyChain reports a missing prevHash link', () => {
    const rows = buildChain(3);
    rows[1] = { ...rows[1]!, prevHash: null };
    const break_ = verifyChain(rows);
    expect(break_).not.toBeNull();
    if (break_) {
      expect(break_.index).toBe(1);
      expect(break_.kind).toBe('prev_mismatch');
      expect(break_.actual).toBeNull();
    }
  });

  it('verifyChain returns null for an empty chain', () => {
    expect(verifyChain([])).toBeNull();
  });

  it('appendToChain links a new row to the tail', () => {
    const tail = appendToChain(null, row('a'));
    const next = appendToChain(tail, row('b'));
    expect(next.prevHash).toBe(hashChainRow(tail));
  });

  it('the hash depends on key-order-independent canonical JSON', () => {
    const a = appendToChain(null, { ...row('x'), after: { b: 1, a: 2 } });
    const b = appendToChain(null, { ...row('x'), after: { a: 2, b: 1 } });
    expect(hashChainRow(a)).toBe(hashChainRow(b));
  });
});
