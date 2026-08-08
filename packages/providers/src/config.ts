import { z } from 'zod';

/**
 * Provider configuration schema (plan §11.1).
 *
 * Mirrors the `provider` table in `packages/db`. `keyCiphertext` is the
 * AES-256-GCM envelope ciphertext (§11.7) — plaintext keys never cross the API.
 */

export const authKindSchema = z.enum(['bearer', 'x_api_key', 'none', 'custom_header']);
export type AuthKind = z.infer<typeof authKindSchema>;

export const providerDialectSchema = z.enum(['openai_compatible', 'anthropic', 'ollama']);
export type ProviderDialect = z.infer<typeof providerDialectSchema>;

export const dnsModeSchema = z.enum(['system', 'doh']);
export type DnsMode = z.infer<typeof dnsModeSchema>;

export const healthStateSchema = z.enum([
  'unconfigured',
  'validating',
  'healthy',
  'degraded',
  'unreachable',
  'unauthorized',
]);
export type HealthState = z.infer<typeof healthStateSchema>;

export const providerErrorSchema = z.object({
  code: z.string(),
  detail: z.string(),
  at: z.string(),
});
export type ProviderError = z.infer<typeof providerErrorSchema>;

export const providerConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  dialect: providerDialectSchema,
  /** Full base URL, e.g. 'https://openrouter.ai/api'. */
  baseUrl: z.string().url(),
  authKind: authKindSchema,
  customHeaderName: z.string().optional(),
  /** AES-256-GCM envelope ciphertext — never returned by any API. */
  keyCiphertext: z.instanceof(Uint8Array).or(z.string()).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  proxyUrl: z.string().optional(),
  dnsMode: dnsModeSchema.default('system'),
  dohUrl: z.string().optional(),
  /** default false; requires a typed confirmation to enable (§11.1). */
  tlsInsecure: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(60_000),
  maxConcurrent: z.number().int().positive().default(4),
  healthState: healthStateSchema.default('unconfigured'),
  lastCheckedAt: z.string().optional(),
  lastError: providerErrorSchema.optional(),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const providerConfigInputSchema = providerConfigSchema.partial({
  extraHeaders: true,
  keyCiphertext: true,
});
export type ProviderConfigInput = z.infer<typeof providerConfigInputSchema>;
