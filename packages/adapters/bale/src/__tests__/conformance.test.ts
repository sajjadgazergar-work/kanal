import { describe, expect, it } from 'vitest';
import { checkAdapter, checkDescriptor } from '@kanal/adapters-core';
import { BALE_DESCRIPTOR } from '../descriptor.js';
import { baleAdapter } from '../index.js';

describe('Bale stub conformance (plan §10.8)', () => {
  it('descriptor is internally consistent', () => {
    expect(checkDescriptor(BALE_DESCRIPTOR)).toEqual([]);
  });

  it('adapter conforms to the descriptor', () => {
    expect(checkAdapter(baleAdapter, BALE_DESCRIPTOR)).toEqual([]);
  });

  it('publish returns not_implemented', async () => {
    const out = await baleAdapter.publish({
      channel: { platformChannelId: 'x', contentLocale: 'en', numeralSystem: 'latn' },
      rendered: { body: 'hi', markupMode: 'none', parts: [], media: [], linkPreview: 'auto', silent: false, protectContent: false },
      idempotencyKey: 'abc',
    });
    expect(out).toEqual({ kind: 'rejected', code: 'not_implemented', description: expect.any(String), permanent: true });
  });
});
