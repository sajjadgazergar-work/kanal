import { NotImplementedAdapter } from '@kanal/adapters-core';
import { REDDIT_DESCRIPTOR } from './descriptor.js';

export { REDDIT_DESCRIPTOR } from './descriptor.js';

/**
 * The Reddit stub adapter (plan §10.8). Every method returns
 * `{ kind: 'rejected', code: 'not_implemented' }`. Compile-checked, not shipped.
 */
export const redditAdapter = new NotImplementedAdapter('reddit', REDDIT_DESCRIPTOR);
