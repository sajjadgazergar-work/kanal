/**
 * Deterministic PII detection (plan §15.4).
 *
 * The deterministic pass covers:
 *   - email addresses
 *   - phone numbers: E.164 (`+1 415 555 0132`) and Iranian mobile (`0912 345 6789`)
 *   - IBAN (both the international form `IR12 3456 ...` and the Iranian
 *     domestic `IR-` prefixed form)
 *   - Iranian national IDs (`0xxxxxxxxx`, 10 digits, with check digit)
 *   - credit-card numbers with the Luhn check digit pass
 *
 * A separate named-entity pass flags person names that co-occur with an
 * address or workplace keyword. That pass is deliberately conservative — it
 * matches `name-pattern + proximity address/workplace word` and is exercised
 * by the corpus tests. It is not a replacement for the deterministic regexes.
 *
 * Ingest hits are stored redacted with `pii_redacted: true`; outbound hits
 * block publish (see `moderation.ts` and the pipeline gate).
 */

export interface PiiFinding {
  type:
    | 'email'
    | 'phone_e164'
    | 'phone_ir'
    | 'iban'
    | 'national_id_ir'
    | 'credit_card'
    | 'person_name_near_address'
    | 'person_name_near_workplace';
  /** Literal match as it appears in the source text. */
  value: string;
  /** Redacted rendering — `***` by default, length-preserving for emails. */
  redacted: string;
  start: number;
  end: number;
}

export const PII_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const PII_PHONE_E164_RE = /(?<!\d)\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{2,4}[\s-]?\d{2,4}(?!\d)/g;
export const PII_PHONE_IR_RE = /(?<!\d)(?:0)?9\d{2}[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g;
export const PII_IBAN_RE =
  /\b[A-Z]{2}\d{2}[\s-]?[0-9A-Z]{4}[\s-]?[0-9A-Z]{4}[\s-]?[0-9A-Z]{4}[\s-]?[0-9A-Z]{4}[\s-]?[0-9A-Z]{1,4}\b/g;
export const PII_NATIONAL_ID_IR_RE = /(?<!\d)0?[0-9]{3}[\s-]?[0-9]{3}[\s-]?[0-9]{4}(?!\d)/g;
export const PII_CARD_RE = /(?<!\d)(?:\d{4}[\s-]?){3}\d{4}(?!\d)/g;

/** Word-boundary-safe person-name-ish pattern for the named-entity pass. */
const NAME_PATTERN = /(?:[A-Z][a-z]{2,}\s+){1,2}[A-Z][a-z]{2,}/g;

const ADDRESS_WORDS = [
  'avenue', 'street', 'road', 'boulevard', 'lane', 'drive', 'plaza', 'square',
  'district', 'province', 'city', 'village', 'alley', 'floor', 'unit',
  'خیابان', 'کوی', 'کوچه', 'بلوار', 'میدان', 'استان', 'شهر',
];
const WORKPLACE_WORDS = [
  'company', 'corp', 'inc', 'ltd', 'llc', 'factory', 'office', 'employer',
  'works at', 'works for', 'hire', 'headquarters',
  'شرکت', 'کارخانه', 'اداره', 'محل کار',
];

/** Luhn check — returns true when the digit string passes the checksum. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const c = digits.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
    let n = c - 0x30;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function redact(value: string): string {
  // Length-preserving redaction so spans and provenance stay usable.
  return value.replace(/[^\s]/g, '*');
}

/** Validate the Iranian national-id check digit (10-digit form). */
export function iranNationalIdValid(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (!/^[0-9]{10}$/.test(d)) return false;
  if (/^0{10}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(d[i]);
  const r = sum % 11;
  const check = r < 2 ? r : 11 - r;
  return check === Number(d[9]);
}

function ibanLengthValid(value: string): boolean {
  const body = value.replace(/[\s-]/g, '');
  if (!/^[A-Z]{2}[0-9]{2}[0-9A-Z]{11,30}$/.test(body)) return false;
  return true;
}

/** Deterministic PII detection. Never throws; returns findings sorted by start offset. */
export function detectPii(text: string): PiiFinding[] {
  const out: PiiFinding[] = [];
  const push = (type: PiiFinding['type'], value: string, start: number) => {
    out.push({ type, value, redacted: redact(value), start, end: start + value.length });
  };

  for (const m of text.matchAll(PII_EMAIL_RE)) {
    if (m.index === undefined) continue;
    push('email', m[0], m.index);
  }
  for (const m of text.matchAll(PII_PHONE_E164_RE)) {
    if (m.index === undefined) continue;
    push('phone_e164', m[0], m.index);
  }
  for (const m of text.matchAll(PII_PHONE_IR_RE)) {
    if (m.index === undefined) continue;
    push('phone_ir', m[0], m.index);
  }
  for (const m of text.matchAll(PII_IBAN_RE)) {
    if (m.index === undefined) continue;
    if (!ibanLengthValid(m[0])) continue;
    push('iban', m[0], m.index);
  }
  for (const m of text.matchAll(PII_NATIONAL_ID_IR_RE)) {
    if (m.index === undefined) continue;
    const digits = m[0].replace(/\D/g, '');
    if (!iranNationalIdValid(digits)) continue;
    push('national_id_ir', m[0], m.index);
  }
  for (const m of text.matchAll(PII_CARD_RE)) {
    if (m.index === undefined) continue;
    const digits = m[0].replace(/\D/g, '');
    if (!luhnValid(digits)) continue;
    push('credit_card', m[0], m.index);
  }

  // Named-entity pass: person names co-occurring with address/workplace.
  for (const m of text.matchAll(NAME_PATTERN)) {
    if (m.index === undefined) continue;
    const name = m[0];
    const nameStart = m.index;
    const nameEnd = nameStart + name.length;
    const around = text.slice(Math.max(0, nameStart - 200), nameEnd + 200);
    const lower = around.toLowerCase();
    const addressHit = ADDRESS_WORDS.some((w) => lower.includes(w.toLowerCase()));
    const workplaceHit = WORKPLACE_WORDS.some((w) => lower.includes(w.toLowerCase()));
    if (addressHit) push('person_name_near_address', name, nameStart);
    else if (workplaceHit) push('person_name_near_workplace', name, nameStart);
  }

  // De-duplicate overlapping spans (prefer the first/longest) and sort.
  const sorted = out.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: PiiFinding[] = [];
  for (const f of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && f.start < prev.end) {
      // Keep the wider finding.
      if (f.end > prev.end) {
        merged[merged.length - 1] = f;
      }
      continue;
    }
    merged.push(f);
  }
  return merged;
}

/** Replace every PII hit with its redaction. Deterministic; used at ingest. */
export function redactPii(text: string, findings?: PiiFinding[]): string {
  const hits = findings ?? detectPii(text);
  let result = text;
  // Apply from the end backwards so earlier offsets stay valid.
  for (const f of [...hits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, f.start) + f.redacted + result.slice(f.end);
  }
  return result;
}

/** True when the text contains at least one PII hit. */
export function hasPii(text: string): boolean {
  return detectPii(text).length > 0;
}
