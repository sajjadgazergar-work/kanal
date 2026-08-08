/**
 * 64-bit simhash (plan §8.3 near-exact dedup layer).
 *
 * Implemented from scratch per the plan: tokenize → per-token 64-bit hash →
 * accumulate a 64-bit bitsum (+1 for set bits, −1 for clear bits) → the sign of
 * each bit is the output. Two documents whose simhashing distance (Hamming) is
 * ≤ 3 are treated as near-duplicates within a 30-day window.
 */

import { tokenize } from './text.js';

const MASK64 = 0xffffffffffffffffn;

// FNV-1a, 64-bit — deterministic across runs/processes.
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

export function hash64(input: string): bigint {
  let h = FNV_OFFSET;
  const bytes = Buffer.from(input, 'utf8');
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/**
 * Compute the 64-bit simhash of a body of text.
 */
export function simhash(text: string, minTokenLength = 3): bigint {
  const tokens = tokenize(text, minTokenLength);
  if (tokens.length === 0) return 0n;
  const bits = new Float64Array(64);
  for (const t of tokens) {
    const h = hash64(t);
    for (let i = 0; i < 64; i++) {
      const bit = (h >> BigInt(i)) & 1n;
      bits[i]! += bit === 1n ? 1 : -1;
    }
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) {
    if (bits[i]! > 0) out |= 1n << BigInt(i);
  }
  return out;
}

/**
 * Hamming distance between two 64-bit simhashes.
 */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = (a ^ b) & MASK64;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}

/**
 * Are two hashes near-duplicates under the ≤ 3 threshold?
 */
export function isNearDuplicate(a: bigint, b: bigint, threshold = 3): boolean {
  return hammingDistance(a, b) <= threshold;
}

/**
 * Convert a 64-bit simhash to a signed bigint string for storage in a Postgres
 * `bigint` column (drizzle `bigint('simhash', { mode: 'number' })` uses a JS
 * number — but 64-bit does not fit a double exactly, so the harvester stores it
 * as a string; the schema type is mode 'number' which mirrors a signed 64-bit
 * integer).
 */
export function simhashToString(h: bigint): string {
  // interpret as signed 64-bit
  let value = h & MASK64;
  if (value >= 0x8000000000000000n) value -= 0x10000000000000000n;
  return value.toString();
}

export function stringToSimhash(s: string): bigint {
  const n = BigInt(s);
  // normalize into 64-bit unsigned
  return (BigInt.asUintN(64, n));
}
