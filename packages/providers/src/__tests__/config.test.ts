import { describe, expect, it } from 'vitest';
import { providerConfigSchema, authKindSchema, providerDialectSchema, healthStateSchema } from '../config.js';

describe('provider config schema (§11.1)', () => {
  it('parses a minimal config with defaults', () => {
    const cfg = providerConfigSchema.parse({
      id: 'openrouter',
      label: 'OpenRouter (via proxy)',
      dialect: 'openai_compatible',
      baseUrl: 'https://openrouter.ai/api',
      authKind: 'bearer',
    });
    expect(cfg.dnsMode).toBe('system');
    expect(cfg.tlsInsecure).toBe(false);
    expect(cfg.timeoutMs).toBe(60_000);
    expect(cfg.maxConcurrent).toBe(4);
    expect(cfg.healthState).toBe('unconfigured');
  });

  it('accepts all auth kinds and dialects', () => {
    for (const k of ['bearer', 'x_api_key', 'none', 'custom_header']) {
      expect(authKindSchema.parse(k)).toBe(k);
    }
    for (const d of ['openai_compatible', 'anthropic', 'ollama']) {
      expect(providerDialectSchema.parse(d)).toBe(d);
    }
  });

  it('accepts all health states', () => {
    for (const h of ['unconfigured', 'validating', 'healthy', 'degraded', 'unreachable', 'unauthorized']) {
      expect(healthStateSchema.parse(h)).toBe(h);
    }
  });

  it('requires a valid URL for baseUrl', () => {
    expect(() => providerConfigSchema.parse({ id: 'x', label: 'x', dialect: 'ollama', baseUrl: 'not-a-url', authKind: 'none' })).toThrow();
  });

  it('accepts custom headers and extraHeaders', () => {
    const cfg = providerConfigSchema.parse({
      id: 'or',
      label: 'OpenRouter',
      dialect: 'openai_compatible',
      baseUrl: 'https://openrouter.ai/api',
      authKind: 'custom_header',
      customHeaderName: 'x-custom',
      extraHeaders: { 'HTTP-Referer': 'https://example.com', 'X-Title': 'KANAL' },
    });
    expect(cfg.customHeaderName).toBe('x-custom');
    expect(cfg.extraHeaders?.['X-Title']).toBe('KANAL');
  });
});
