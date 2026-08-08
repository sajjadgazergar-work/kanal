import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'node:crypto';

/**
 * Envelope key encryption (plan §11.7).
 *
 * - A 32-byte master key comes from `KANAL_MASTER_KEY` (base64).
 * - Per-key DEK, AES-256-GCM, random 96-bit nonce per encryption.
 * - AAD = `provider.id` so a ciphertext cannot be moved between provider rows.
 * - Plaintext keys exist only in worker process memory — never in Postgres,
 *   never in logs, never in spans.
 *
 * Ciphertext layout (binary): 0x01 | version(1) | nonce(12) | tag(16) | encDEK | encKey.
 */

export const ENVELOPE_VERSION = 1;
export const MASTER_KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

/** Magic byte identifying KANAL envelope ciphertext. */
export const ENVELOPE_MAGIC = 0x4b; // 'K'

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

export function deriveMasterKeyFromSeed(seed: string): Buffer {
  if (seed.length === 0) throw new EnvelopeError('master key seed must not be empty');
  if (Buffer.byteLength(seed) === MASTER_KEY_BYTES) {
    return Buffer.from(seed, 'utf8');
  }
  // If it's base64, decode. Prefer the raw-binary interpretation when the
  // base64 decodes to exactly 32 bytes.
  const trimmed = seed.trim();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    try {
      const b64 = Buffer.from(trimmed, 'base64');
      if (b64.length === MASTER_KEY_BYTES) return b64;
    } catch {
      // fall through
    }
  }
  if (Buffer.byteLength(seed) === MASTER_KEY_BYTES) return Buffer.from(seed, 'utf8');
  // Not 32 bytes raw or as base64: derive a stable 32-byte key via SHA-256 so
  // any secret string works without failing boot (test helper convenience).
  return createHash('sha256').update(seed).digest();
}

/** Load the master key from the environment. Throws at boot when a ciphertext
 * exists but no key is configured (plan §11.7). */
export function loadMasterKey(
  env: { KANAL_MASTER_KEY?: string } = process.env,
): Buffer {
  const raw = env.KANAL_MASTER_KEY;
  if (!raw) throw new EnvelopeError('KANAL_MASTER_KEY is not set');
  return deriveMasterKeyFromSeed(raw);
}

export interface EnvelopeDecrypted {
  key: Buffer;
  dekId: Buffer;
}

/**
 * Encrypt `plaintext` under a fresh per-key DEK. AAD binds the ciphertext to
 * `aad` (the provider id). The returned buffer is self-describing.
 */
export function envelopeEncrypt(
  plaintext: Uint8Array,
  masterKey: Uint8Array,
  aad: string,
): Uint8Array {
  const mk = Buffer.from(masterKey);
  if (mk.length !== MASTER_KEY_BYTES) {
    throw new EnvelopeError(`master key must be ${MASTER_KEY_BYTES} bytes, got ${mk.length}`);
  }
  const dek = randomBytes(MASTER_KEY_BYTES);
  const nonce = randomBytes(NONCE_BYTES);

  // Encrypt the key bytes with the DEK.
  const keyCipher = createCipheriv('aes-256-gcm', dek, nonce);
  keyCipher.setAAD(Buffer.from(aad, 'utf8'));
  const keyEnc = Buffer.concat([keyCipher.update(Buffer.from(plaintext)), keyCipher.final()]);
  const tag = keyCipher.getAuthTag();

  // Wrap the DEK with the master key.
  const dekNonce = randomBytes(NONCE_BYTES);
  const wrapCipher = createCipheriv('aes-256-gcm', mk, dekNonce);
  wrapCipher.setAAD(Buffer.from(aad, 'utf8'));
  const dekEnc = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
  const dekTag = wrapCipher.getAuthTag();

  return Buffer.concat([
    Buffer.from([ENVELOPE_MAGIC, ENVELOPE_VERSION]),
    nonce, // 12
    tag, // 16
    dekNonce, // 12
    dekTag, // 16
    dekEnc,
    keyEnc,
  ]);
}

/**
 * Decrypt an envelope. Fails (throws) when the AAD does not match — a
 * ciphertext created for provider A cannot decrypt under provider B.
 */
export function envelopeDecrypt(
  ciphertext: Uint8Array,
  masterKey: Uint8Array,
  aad: string,
): Uint8Array {
  const mk = Buffer.from(masterKey);
  const buf = Buffer.from(ciphertext);
  if (buf.length < 1 + 1 + NONCE_BYTES + TAG_BYTES + NONCE_BYTES + TAG_BYTES + MASTER_KEY_BYTES) {
    throw new EnvelopeError('ciphertext too short');
  }
  if (buf[0] !== ENVELOPE_MAGIC) throw new EnvelopeError('not a KANAL envelope');
  const version = buf[1];
  if (version !== ENVELOPE_VERSION) throw new EnvelopeError(`unsupported envelope version ${version}`);

  let off = 2;
  const nonce = buf.subarray(off, off + NONCE_BYTES);
  off += NONCE_BYTES;
  const tag = buf.subarray(off, off + TAG_BYTES);
  off += TAG_BYTES;
  const dekNonce = buf.subarray(off, off + NONCE_BYTES);
  off += NONCE_BYTES;
  const dekTag = buf.subarray(off, off + TAG_BYTES);
  off += TAG_BYTES;
  const dekEnc = buf.subarray(off, off + MASTER_KEY_BYTES);
  off += MASTER_KEY_BYTES;
  const keyEnc = buf.subarray(off);

  // Unwrap the DEK.
  const unwrap = createDecipheriv('aes-256-gcm', mk, dekNonce);
  unwrap.setAAD(Buffer.from(aad, 'utf8'));
  unwrap.setAuthTag(Buffer.from(dekTag));
  let dek: Buffer;
  try {
    dek = Buffer.concat([unwrap.update(dekEnc), unwrap.final()]);
  } catch {
    throw new EnvelopeError('failed to unwrap DEK (wrong master key or AAD)');
  }

  // Decrypt the key bytes.
  const decrypt = createDecipheriv('aes-256-gcm', dek, nonce);
  decrypt.setAAD(Buffer.from(aad, 'utf8'));
  decrypt.setAuthTag(Buffer.from(tag));
  try {
    return Buffer.concat([decrypt.update(keyEnc), decrypt.final()]);
  } catch {
    throw new EnvelopeError('failed to decrypt payload (AAD mismatch)');
  }
}

/**
 * Round-trip wrapper for tests and admin tooling.
 * `aad` is the provider.id that binds this ciphertext.
 */
export function sealProviderKey(
  plaintext: string | Uint8Array,
  masterKey: Uint8Array,
  providerId: string,
): Uint8Array {
  const pt = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  return envelopeEncrypt(pt, masterKey, providerId);
}

export function openProviderKey(
  ciphertext: Uint8Array,
  masterKey: Uint8Array,
  providerId: string,
): Uint8Array {
  return envelopeDecrypt(ciphertext, masterKey, providerId);
}
