import { describe, expect, it } from 'vitest';
import {
  detectPii,
  redactPii,
  hasPii,
  luhnValid,
  iranNationalIdValid,
} from '../pii.js';

describe('PII detection', () => {
  it('detects an email address', () => {
    const hits = detectPii('Reach out to support@kanal.dev for details.');
    expect(hits.some((h) => h.type === 'email' && h.value === 'support@kanal.dev')).toBe(true);
  });

  it('detects an E.164 phone', () => {
    const hits = detectPii('Call +1 415 555 0132 any time.');
    expect(hits.some((h) => h.type === 'phone_e164')).toBe(true);
  });

  it('detects an Iranian mobile number', () => {
    const hits = detectPii('تماس بگیرید: 0912 345 6789');
    expect(hits.some((h) => h.type === 'phone_ir')).toBe(true);
  });

  it('detects an IBAN', () => {
    const hits = detectPii('Account IR12 3456 7890 1234 5678 9012 34');
    expect(hits.some((h) => h.type === 'iban')).toBe(true);
  });

  it('detects an Iranian national ID with a valid check digit', () => {
    // 0001000004 → valid per the standard check digit.
    const hits = detectPii('کد ملی 0001000004 ثبت شد.');
    expect(hits.some((h) => h.type === 'national_id_ir')).toBe(true);
  });

  it('detects a Luhn-valid credit card', () => {
    // 4111 1111 1111 1111 passes Luhn.
    const hits = detectPii('Pay with 4111 1111 1111 1111 now.');
    expect(hits.some((h) => h.type === 'credit_card')).toBe(true);
  });

  it('does not flag a non-Luhn card-like number', () => {
    const hits = detectPii('Order id 1234 5678 9012 3456 was shipped.');
    expect(hits.some((h) => h.type === 'credit_card')).toBe(false);
  });

  it('detects a person name co-occurring with a workplace', () => {
    const hits = detectPii('Sarah Connor works at Cyberdyne Systems as an engineer.');
    expect(hits.some((h) => h.type === 'person_name_near_workplace')).toBe(true);
  });

  it('detects a person name co-occurring with an address', () => {
    const hits = detectPii('John Smith lives on Maple Avenue 42, Springfield.');
    expect(hits.some((h) => h.type === 'person_name_near_address')).toBe(true);
  });

  it('redacts PII deterministically', () => {
    const text = 'Contact support@kanal.dev or 0912 345 6789 today.';
    const redacted = redactPii(text);
    expect(redacted).not.toContain('support@kanal.dev');
    expect(redacted).not.toContain('0912 345 6789');
    expect(hasPii(redacted)).toBe(false);
  });

  it('ingest moderation flags pii_redacted', () => {
    // Covered via the moderation module test; here assert hasPii flips.
    expect(hasPii('no pii here')).toBe(false);
    expect(hasPii('mail me at a@b.com')).toBe(true);
  });

  it('luhnValid is a pure check', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
  });

  it('iranNationalIdValid checks the check digit', () => {
    expect(iranNationalIdValid('0001000004')).toBe(true);
    expect(iranNationalIdValid('0001000005')).toBe(false);
  });
});
