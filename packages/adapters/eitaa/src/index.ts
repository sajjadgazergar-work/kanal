import { NotImplementedAdapter } from '@kanal/adapters-core';
import { EITAA_DESCRIPTOR } from './descriptor.js';

export { EITAA_DESCRIPTOR } from './descriptor.js';

/**
 * The Eitaa stub adapter (plan §10.8). Every method returns
 * `{ kind: 'rejected', code: 'not_implemented' }`. Compile-checked, not shipped.
 */
export const eitaaAdapter = new NotImplementedAdapter('eitaa', EITAA_DESCRIPTOR);
