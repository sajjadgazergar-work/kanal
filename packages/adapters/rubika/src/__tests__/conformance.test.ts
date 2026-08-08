import { describe, expect, it } from 'vitest';
import { checkAdapter, checkDescriptor } from '@kanal/adapters-core';
import { RUBIKA_DESCRIPTOR } from '../descriptor.js';
import { rubikaAdapter } from '../index.js';

describe('Rubika stub conformance (plan §10.8)', () => {
  it('descriptor is internally consistent', () => {
    expect(checkDescriptor(RUBIKA_DESCRIPTOR)).toEqual([]);
  });

  it('adapter conforms to the descriptor', () => {
    expect(checkAdapter(rubikaAdapter, RUBIKA_DESCRIPTOR)).toEqual([]);
  });

  it('publish returns not_implemented', async () => {
    const out = await rubikaAdapter.publish({
      channel: { platformChannelId: 'x', contentLocale: 'en', numeralSystem: 'latn' },
      rendered: { body: 'hi', markupMode: 'none', parts: [], media: [], linkPreview: 'auto', silent: false, protectContent: false },
      idempotencyKey: 'abc',
    });
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.code).toBe('not_implemented');
  });
});
