import { type ProviderDialect } from './config.js';

/**
 * Model discovery per dialect (plan §11.1):
 *   - openai_compatible → GET {baseUrl}/v1/models with `Authorization: Bearer <key>`
 *   - anthropic        → GET {baseUrl}/v1/models with `x-api-key: <key>` and
 *                        `anthropic-version: 2023-06-01`, paginated with
 *                        `after_id` / `before_id` until the cursor is
 *                        exhausted (hard cap 20 pages).
 *   - ollama           → GET {baseUrl}/api/tags
 */

/** Anthropic pagination cap per §11.1. */
export const MAX_ANTHROPIC_PAGES = 20;

export interface ModelEntry {
  id: string;
  /** Owned/deprecated markers if the provider reports them. */
  ownedBy?: string;
  deprecated?: boolean;
}

export function openaiModelsUrl(baseUrl: string): string {
  return `${trimSlash(baseUrl)}/v1/models`;
}

export function anthropicModelsUrl(baseUrl: string): string {
  return `${trimSlash(baseUrl)}/v1/models`;
}

export function ollamaModelsUrl(baseUrl: string): string {
  return `${trimSlash(baseUrl)}/api/tags`;
}

/** Build per-dialect headers from the config. Keys are transport-level; the
 * key material is already decrypted by the caller. */
export function discoveryHeaders(
  dialect: ProviderDialect,
  key: string | undefined,
  customHeaderName: string | undefined,
  extraHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { ...extraHeaders };
  switch (dialect) {
    case 'openai_compatible':
      if (key !== undefined && key !== '') headers.Authorization = `Bearer ${key}`;
      break;
    case 'anthropic':
      if (key !== undefined && key !== '') headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      break;
    case 'ollama':
      // Ollama has no auth by default; keys are not sent.
      break;
  }
  if (dialect === 'openai_compatible' && customHeaderName !== undefined) {
    if (key !== undefined && key !== '') headers[customHeaderName] = key;
  }
  return headers;
}

/** Extract model ids from a dialect-shaped response body. */
export function parseModelList(body: unknown, dialect: ProviderDialect): ModelEntry[] {
  if (body === null || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;

  if (dialect === 'ollama') {
    // { models: [{ name: 'llama3:latest', model: 'llama3:latest', ... }] }
    const list = b.models;
    if (!Array.isArray(list)) return [];
    const out: ModelEntry[] = [];
    for (const row of list) {
      if (row === null || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const name = typeof r.name === 'string' ? r.name : typeof r.model === 'string' ? r.model : undefined;
      if (name) out.push({ id: name });
    }
    return out;
  }

  // openai_compatible & anthropic: { data: [{ id, ... }] } — anthropic also
  // supports `models` (the current list response).
  const list = Array.isArray(b.data) ? b.data : Array.isArray(b.models) ? b.models : undefined;
  if (!list) return [];
  const out: ModelEntry[] = [];
  for (const row of list) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== 'string') continue;
    out.push({
      id: r.id,
      ownedBy: typeof r.owned_by === 'string' ? r.owned_by : typeof r.ownedBy === 'string' ? r.ownedBy : undefined,
      deprecated: typeof r.deprecated === 'boolean' ? r.deprecated : undefined,
    });
  }
  return out;
}

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
