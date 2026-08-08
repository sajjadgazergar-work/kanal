import { NotImplementedAdapter } from '@kanal/adapters-core';
import { RUBIKA_DESCRIPTOR } from './descriptor.js';

export { RUBIKA_DESCRIPTOR } from './descriptor.js';

/**
 * The Rubika stub adapter (plan §10.8). Every method returns
 * `{ kind: 'rejected', code: 'not_implemented' }`. Compile-checked, not shipped.
 */
export const rubikaAdapter = new NotImplementedAdapter('rubika', RUBIKA_DESCRIPTOR);
