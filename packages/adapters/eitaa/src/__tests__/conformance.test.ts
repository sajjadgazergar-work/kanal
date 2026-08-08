import { describe, expect, it } from 'vitest';
import { checkAdapter, checkDescriptor } from '@kanal/adapters-core';
import { EITAA_DESCRIPTOR } from '../descriptor.js';
import { eitaaAdapter } from '../index.js';

describe('Eitaa stub conformance (plan §10.8)', () => {
  it('descriptor is internally consistent', () => {
    expect(checkDescriptor(EITAA_DESCRIPTOR)).toEqual([]);
  });

  it('adapter conforms to the descriptor', () => {
    expect(checkAdapter(eitaaAdapter, EITAA_DESCRIPTOR)).toEqual([]);
  });

  it('publish returns not_implemented', async () => {
    const out = await eitaaAdapter.publish({
      channel: { platformChannelId: 'x', contentLocale: 'en', numeralSystem: 'latn' },
      rendered: { body: 'hi', markupMode: 'none', parts: [], media: [], linkPreview: 'auto', silent: false, protectContent: false },
      idempotencyKey: 'abc',
    });
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.code).toBe('not_implemented');
  });
});
