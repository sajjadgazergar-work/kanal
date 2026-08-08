import { type ProviderConfig } from './config.js';
import { type Transport } from './transport.js';
import {
  type ModelEntry,
  discoveryHeaders,
  openaiModelsUrl,
  anthropicModelsUrl,
  ollamaModelsUrl,
  parseModelList,
  MAX_ANTHROPIC_PAGES,
} from './discovery.js';

/**
 * Per-dialect discovery (plan §11.1):
 *   - openai_compatible → GET {baseUrl}/v1/models (Bearer)
 *   - anthropic        → GET {baseUrl}/v1/models (x-api-key + anthropic-version),
 *                        paginated with after_id/before_id until the cursor is
 *                        exhausted (hard cap 20 pages)
 *   - ollama           → GET {baseUrl}/api/tags
 */

export interface DiscoveryResult {
  ok: boolean;
  status: number;
  models: ModelEntry[];
  /** The exact URL(s) attempted (for the http_404 one-click fix display). */
  url: string;
  pages: number;
  errorBody?: string;
  /** Body could not be parsed as JSON (plan §11.3 body_not_json). */
  parseFailed?: boolean;
  /** Body parsed but did not contain a data/models list (body_unexpected_shape). */
  shapeOk?: boolean;
}

export async function discoverModels(
  cfg: ProviderConfig,
  transport: Transport,
  decryptKey: () => string | undefined,
): Promise<DiscoveryResult> {
  const url = modelsUrl(cfg);
  const headers = discoveryHeaders(cfg.dialect, decryptKey(), cfg.customHeaderName, cfg.extraHeaders);

  const resp = await transport.request({ method: 'GET', url, headers, timeoutMs: cfg.timeoutMs });
  if (resp.status !== 200) {
    return { ok: false, status: resp.status, models: [], url, pages: 0, errorBody: resp.body };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(resp.body);
  } catch {
    return { ok: false, status: resp.status, models: [], url, pages: 0, errorBody: resp.body, parseFailed: true };
  }
  const shapeOk = hasModelListShape(parsed, cfg.dialect);
  const models = parseModelList(parsed, cfg.dialect);
  if (cfg.dialect === 'anthropic') {
    const paginated = await paginateAnthropic(cfg, transport, decryptKey, models);
    return { ok: true, status: 200, models: paginated.models, url, pages: paginated.pages, shapeOk };
  }
  return { ok: true, status: 200, models, url, pages: 1, shapeOk };
}

function hasModelListShape(parsed: unknown, dialect: string): boolean {
  if (parsed === null || typeof parsed !== 'object') return false;
  const b = parsed as Record<string, unknown>;
  if (dialect === 'ollama') return Array.isArray(b.models);
  return Array.isArray(b.data) || Array.isArray(b.models);
}

async function paginateAnthropic(
  cfg: ProviderConfig,
  transport: Transport,
  decryptKey: () => string | undefined,
  first: ModelEntry[],
): Promise<{ models: ModelEntry[]; pages: number }> {
  const all: ModelEntry[] = [...first];
  const headers = discoveryHeaders(cfg.dialect, decryptKey(), cfg.customHeaderName, cfg.extraHeaders);
  const base = anthropicModelsUrl(cfg.baseUrl);
  let after: string | undefined;
  let pages = 1;
  while (pages < MAX_ANTHROPIC_PAGES) {
    const url = after ? `${base}?after_id=${encodeURIComponent(after)}` : base;
    const resp = await transport.request({ method: 'GET', url, headers, timeoutMs: cfg.timeoutMs });
    if (resp.status !== 200) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(resp.body);
    } catch {
      break;
    }
    const next = parseModelList(parsed, cfg.dialect);
    all.push(...next);
    pages++;
    const hasMore = parsed && typeof parsed === 'object' && (parsed as { has_more?: boolean }).has_more === true;
    if (!hasMore) break;
    const last = next[next.length - 1];
    if (!last) break;
    after = last.id;
  }
  // Dedupe by id, preserving order.
  const seen = new Set<string>();
  const deduped: ModelEntry[] = [];
  for (const m of all) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      deduped.push(m);
    }
  }
  return { models: deduped, pages };
}

function modelsUrl(cfg: ProviderConfig): string {
  switch (cfg.dialect) {
    case 'anthropic':
      return anthropicModelsUrl(cfg.baseUrl);
    case 'ollama':
      return ollamaModelsUrl(cfg.baseUrl);
    default:
      return openaiModelsUrl(cfg.baseUrl);
  }
}
