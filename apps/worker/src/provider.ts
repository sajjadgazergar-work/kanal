import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ModelClient, FetchTransport } from '@kanal/providers';
import type { ProviderConfig } from '@kanal/providers';
import type { ModelRequest, ModelResponse } from '@kanal/core';
import type { ProviderClient } from './pipeline.js';

/**
 * The worker's model client (plan §11). Dials the first healthy configured
 * provider from the `provider` table, wraps `@kanal/providers`' `ModelClient`
 * into the `ProviderClient` shape the pipeline expects, and reads prices from
 * the `model_price` table (prices live in the DB, never in code — plan A8).
 */

export interface ProviderDbRow {
  id: string;
  label: string;
  dialect: 'openai_compatible' | 'anthropic' | 'ollama';
  base_url: string;
  auth_kind: string;
  custom_header_name: string | null;
  key_ciphertext: string | null;
  proxy_url: string | null;
  dns_mode: string;
  doh_url: string | null;
  tls_insecure: boolean;
  timeout_ms: number;
  max_concurrent: number;
  health_state: string;
}

/** Load the first healthy provider (fallback: any provider). */
export async function loadProviderConfig(db: NodePgDatabase): Promise<ProviderConfig | null> {
  const rows = await db.execute(sql`
    SELECT * FROM provider
    WHERE health_state = 'healthy'
    ORDER BY label LIMIT 1;
  `);
  let row = rows.rows[0] as unknown as ProviderDbRow | undefined;
  if (!row) {
    const any = await db.execute(sql`SELECT * FROM provider ORDER BY label LIMIT 1`);
    row = any.rows[0] as unknown as ProviderDbRow | undefined;
  }
  if (!row) return null;

  return {
    id: row.id,
    label: row.label,
    dialect: row.dialect,
    baseUrl: row.base_url,
    authKind: row.auth_kind as 'bearer' | 'x_api_key' | 'none' | 'custom_header',
    customHeaderName: row.custom_header_name ?? undefined,
    keyCiphertext: row.key_ciphertext ?? undefined,
    proxyUrl: row.proxy_url ?? undefined,
    dnsMode: row.dns_mode as 'system' | 'doh',
    dohUrl: row.doh_url ?? undefined,
    tlsInsecure: row.tls_insecure,
    timeoutMs: row.timeout_ms,
    maxConcurrent: row.max_concurrent,
    // The DB row carries the health state; the worker inherits it. This is a
    // live process, so a stale "healthy" claim is re-probed by the discovery
    // runner elsewhere (plan §11.4) — the worker just reads what's there.
    healthState: row.health_state as ProviderConfig['healthState'],
  };
}

export interface PriceRow {
  model_ref: string;
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  cached_input_usd_per_mtok: number | null;
}

/** Load all prices for the org (the price table is the source of truth, A8). */
export async function loadPrices(db: NodePgDatabase): Promise<Map<string, PriceRow>> {
  const rows = await db.execute(sql`
    SELECT model_ref, input_usd_per_mtok, output_usd_per_mtok, cached_input_usd_per_mtok
    FROM model_price;
  `);
  const map = new Map<string, PriceRow>();
  for (const r of rows.rows as unknown as PriceRow[]) {
    map.set(r.model_ref, r);
  }
  return map;
}

/** Build the pipeline's `ProviderClient` from a provider config + prices. */
export function createProviderClient(
  cfg: ProviderConfig,
  prices: Map<string, PriceRow>,
  opts: { decryptKey?: () => string | undefined } = {},
): ProviderClient {
  // The transport carries the SSRF + egress guards (§16.2 #6 #7). Proxy/DNS
  // wiring for a production provider is configured at the deploy layer; the
  // worker transport keeps the default system resolver and no egress allow-list.
  const transport = new FetchTransport();
  const client = new ModelClient(cfg, transport, opts.decryptKey ?? (() => undefined));

  return {
    async chat(req: ModelRequest): Promise<ModelResponse> {
      // The probe client's message type has no 'tool' role; tool results are
      // folded in as assistant-turn text, which every dialect accepts.
      const messages = req.messages.map((m) => ({
        role: m.role === 'tool' ? 'assistant' : m.role,
        content: m.content,
      }));
      const res = await client.complete({
        model: req.modelRef ?? 'tier:M',
        messages,
        temperature: req.temperature,
        maxTokens: req.maxTokens ?? 4096,
        responseFormat: req.structuredOutputSchema
          ? { type: 'json_object', schema: req.structuredOutputSchema }
          : undefined,
      });
      if (!res.ok) {
        throw new Error(`provider error: ${res.error?.type}: ${res.error?.message}`);
      }
      const text = res.text ?? '';
      const usage = res.usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      return {
        text,
        modelRef: res.model ?? req.modelRef ?? 'tier:M',
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cachedTokens: usage.cachedInputTokens ?? 0,
        },
        finishReason: 'stop',
      };
    },
    priceOf(modelRef: string) {
      const p = prices.get(modelRef);
      if (!p) return null;
      return {
        inputUsdPerMtok: p.input_usd_per_mtok,
        outputUsdPerMtok: p.output_usd_per_mtok,
        cachedInputUsdPerMtok: p.cached_input_usd_per_mtok ?? undefined,
      };
    },
  };
}
