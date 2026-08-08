import { NotImplementedAdapter } from '@kanal/adapters-core';
import { X_DESCRIPTOR } from './descriptor.js';

export { X_DESCRIPTOR } from './descriptor.js';

/**
 * The X stub adapter (plan §10.8). Every method returns
 * `{ kind: 'rejected', code: 'not_implemented' }`. Compile-checked, not shipped.
 */
export const xAdapter = new NotImplementedAdapter('x', X_DESCRIPTOR);
