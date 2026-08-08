import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * API-key bearer auth (plan §16.2 #16, §20.1).
 *
 * No default credentials, no anonymous mode. The server refuses to boot without
 * `KANAL_API_KEY` (see index.ts). Requests must present it as
 * `Authorization: Bearer <key>` and we compare in constant time.
 */

/** Constant-time equality for ASCII/UTF-8 strings. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i]! ^ bufB[i]!;
  }
  return diff === 0;
}

export function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme === undefined || scheme.toLowerCase() !== 'bearer') return null;
  const token = rest.join('').trim();
  return token.length > 0 ? token : null;
}

/**
 * Pre-handler guard. `expected` is the configured `KANAL_API_KEY`; a missing
 * config value is treated as "no request is authenticated".
 */
export function requireApiKey(expected: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const presented = extractBearer(request);
    if (presented === null || !safeEqual(expected, presented)) {
      await reply.code(401).send({ error: 'unauthorized', message: 'invalid or missing API key' });
    }
  };
}
