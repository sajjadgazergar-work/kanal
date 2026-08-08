import { describe, expect, it } from 'vitest';
import {
  envelopeEncrypt,
  envelopeDecrypt,
  deriveMasterKeyFromSeed,
  sealProviderKey,
  openProviderKey,
  EnvelopeError,
} from '../envelope.js';

const mk = deriveMasterKeyFromSeed('test-master-key-0123456789abcdef');
const mk2 = deriveMasterKeyFromSeed('another-master-key-9876543210fedcba');

describe('envelope key encryption (plan §11.7)', () => {
  it('round-trips a key under the same provider id', () => {
    const key = 'sk-ant-0123456789abcdef';
    const ct = envelopeEncrypt(Buffer.from(key, 'utf8'), mk, 'provider-a');
    const dec = envelopeDecrypt(ct, mk, 'provider-a');
    expect(Buffer.from(dec).toString('utf8')).toBe(key);
  });

  it('sealProviderKey / openProviderKey round-trip', () => {
    const ct = sealProviderKey('sk-12345', mk, 'prov-1');
    expect(Buffer.from(openProviderKey(ct, mk, 'prov-1')).toString('utf8')).toBe('sk-12345');
  });

  it('AAD binding: ciphertext from provider A fails to decrypt under provider B', () => {
    const ct = envelopeEncrypt(Buffer.from('sk-for-a', 'utf8'), mk, 'provider-a');
    expect(() => envelopeDecrypt(ct, mk, 'provider-b')).toThrow(EnvelopeError);
    expect(() => envelopeDecrypt(ct, mk, 'provider-a')).not.toThrow();
  });

  it('ciphertext fails under a different master key', () => {
    const ct = envelopeEncrypt(Buffer.from('sk-1', 'utf8'), mk, 'prov-x');
    expect(() => envelopeDecrypt(ct, mk2, 'prov-x')).toThrow(EnvelopeError);
  });

  it('produces different ciphertext each call (random nonce per encryption)', () => {
    const a = envelopeEncrypt(Buffer.from('same', 'utf8'), mk, 'prov');
    const b = envelopeEncrypt(Buffer.from('same', 'utf8'), mk, 'prov');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('rejects a wrong master key length', () => {
    expect(() => envelopeEncrypt(Buffer.from('x'), Buffer.alloc(16), 'prov')).toThrow(/master key must be 32 bytes/);
  });

  it('rejects a garbage ciphertext', () => {
    expect(() => envelopeDecrypt(Buffer.from('garbage'), mk, 'prov')).toThrow();
  });

  it('derives a 32-byte master key from any seed', () => {
    expect(deriveMasterKeyFromSeed('any-string-seed').length).toBe(32);
  });

  it('plaintext keys exist only in memory — no plaintext in ciphertext', () => {
    const key = 'sk-super-secret-abc';
    const ct = envelopeEncrypt(Buffer.from(key, 'utf8'), mk, 'prov');
    const ctStr = Buffer.from(ct).toString('utf8');
    expect(ctStr.includes(key)).toBe(false);
  });
});
