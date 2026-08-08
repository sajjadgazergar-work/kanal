import { NotImplementedAdapter } from '@kanal/adapters-core';
import { BALE_DESCRIPTOR } from './descriptor.js';

export { BALE_DESCRIPTOR } from './descriptor.js';

/**
 * The Bale stub adapter (plan §10.8). Every method returns
 * `{ kind: 'rejected', code: 'not_implemented' }`. Compile-checked, not shipped.
 */
export const baleAdapter = new NotImplementedAdapter('bale', BALE_DESCRIPTOR);
