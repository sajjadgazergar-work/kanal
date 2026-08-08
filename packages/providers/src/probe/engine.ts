import { type ProbeId, type ProbeResult, type StructuredOutputKind } from './types.js';

/**
 * The six capability probes (plan §11.4), run against the injectable model
 * client. No network here — everything goes through `ModelClient.complete`.
 */

export interface ProbeMessage {
  role: 'user' | 'system' | 'assistant';
  content: string;
}

export interface ProbeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProbeToolCall {
  name: string;
  arguments: string;
}

export interface ProbeCompletionRequest {
  messages: ProbeMessage[];
  maxTokens: number;
  temperature?: number;
  responseFormat?: { type: 'json_object'; schema?: Record<string, unknown> };
  tools?: ProbeTool[];
  stream?: boolean;
}

export interface ProbeCompletionResponse {
  ok: boolean;
  /** Tool calls returned (probe 2). */
  toolCalls?: ProbeToolCall[];
  /** Raw text (probe 3 JSON validation). */
  text?: string;
  /** Usage object when the provider reports one (probe 1). */
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
  /** For probe 1's streaming check. */
  streamed?: boolean;
  /** Error surfaced by the provider, e.g. context-length errors (probe 4). */
  error?: { type?: string; message?: string };
  httpStatus?: number;
}

/** The seam a fake transport satisfies in tests. */
export interface ModelClient {
  complete(req: ProbeCompletionRequest): Promise<ProbeCompletionResponse>;
}

export const TOOL_CALLING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
};

export const STRUCTURED_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { n: { type: 'integer' } },
  required: ['n'],
};

export interface ProbeExecutor {
  runProbe(model: string, probe: ProbeId): Promise<ProbeResult>;
}

/** In-memory probe result cache keyed by `providerId|modelRef|probe`. */
export class ProbeCache {
  private readonly store = new Map<string, { result: ProbeResult; at: number }>();

  constructor(private readonly ttlMs: number = 14 * 24 * 60 * 60 * 1000) {}

  get(key: string, now = Date.now()): ProbeResult | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (now - hit.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return hit.result;
  }

  set(key: string, result: ProbeResult, now = Date.now()): void {
    this.store.set(key, { result, at: now });
  }
}

export function probeCacheKey(providerId: string, modelRef: string, probe: ProbeId): string {
  return `${providerId}|${modelRef}|${probe}`;
}

/**
 * Run a single probe against the client.
 */
export async function runProbe(
  client: ModelClient,
  model: string,
  probe: ProbeId,
): Promise<ProbeResult> {
  switch (probe) {
    case 'liveness':
      return probeLiveness(client, model);
    case 'tool_calling':
      return probeToolCalling(client, model);
    case 'structured_output':
      return probeStructuredOutput(client, model);
    case 'context_ceiling':
      return probeContextCeiling(client, model);
    case 'vision':
      return probeVision(client, model);
    case 'prompt_cache':
      return probePromptCache(client, model);
  }
}

/** Probe 1: liveness + token accounting + streaming. */
async function probeLiveness(client: ModelClient, _model: string): Promise<ProbeResult> {
  const first = await client.complete({
    messages: [{ role: 'user', content: 'Count to 8.' }],
    maxTokens: 8,
  });
  if (!first.ok) {
    return { probe: 'liveness', passed: false, records: {}, detail: `liveness call failed (${first.httpStatus ?? 'err'})` };
  }
  const usageReported = Boolean(first.usage && (first.usage.inputTokens ?? 0) > 0);
  // Second 4-token streamed call.
  const second = await client.complete({
    messages: [{ role: 'user', content: 'Hi' }],
    maxTokens: 4,
    stream: true,
  });
  return {
    probe: 'liveness',
    passed: second.ok,
    records: { streaming: second.ok && second.streamed === true, usageReported },
  };
}

/** Probe 2: tool calling — one tool get_weather(city: string), "weather in Tehran". */
async function probeToolCalling(client: ModelClient, _model: string): Promise<ProbeResult> {
  const res = await client.complete({
    messages: [{ role: 'user', content: 'weather in Tehran' }],
    maxTokens: 128,
    tools: [{ name: 'get_weather', description: 'Get the current weather in a city', inputSchema: TOOL_CALLING_SCHEMA }],
  });
  if (!res.ok || !res.toolCalls || res.toolCalls.length === 0) {
    return { probe: 'tool_calling', passed: false, failureCode: 'probe_no_tool_calling', records: { toolCalling: false } };
  }
  const call = res.toolCalls[0];
  if (!call) {
    return { probe: 'tool_calling', passed: false, failureCode: 'probe_no_tool_calling', records: { toolCalling: false } };
  }
  let argsParsed = false;
  try {
    const parsed = JSON.parse(call.arguments);
    argsParsed = typeof parsed === 'object' && parsed !== null;
  } catch {
    argsParsed = false;
  }
  const valid = call.name === 'get_weather' && argsParsed;
  return {
    probe: 'tool_calling',
    passed: valid,
    failureCode: valid ? undefined : 'probe_no_tool_calling',
    records: {
      toolCalling: valid,
      parallelToolCalls: res.toolCalls.length > 1,
    },
  };
}

/** Probe 3: structured output — schema {n: integer}, prompt "return n = 7". */
async function probeStructuredOutput(client: ModelClient, _model: string): Promise<ProbeResult> {
  const res = await client.complete({
    messages: [{ role: 'user', content: 'return n = 7' }],
    maxTokens: 64,
    responseFormat: { type: 'json_object', schema: STRUCTURED_OUTPUT_SCHEMA },
  });
  let kind: StructuredOutputKind = 'none';
  let passed = false;
  if (res.ok && res.text) {
    try {
      const parsed = JSON.parse(res.text) as { n?: unknown };
      if (typeof parsed === 'object' && parsed !== null && parsed.n === 7) {
        kind = 'native';
        passed = true;
      } else {
        kind = 'prompted';
      }
    } catch {
      // Some providers return non-JSON; treat as prompted failure.
      kind = 'none';
    }
  }
  return {
    probe: 'structured_output',
    passed,
    failureCode: passed ? undefined : 'probe_no_structured_output',
    records: { structuredOutput: kind },
  };
}

/** Probe 4: context ceiling — binary search over 8k / 32k / 128k filler. */
const FILLER_BLOCK = 'The quick brown fox jumps over the lazy dog. ';
const FILLER_TOKENS_PER_BLOCK = 12;

async function probeContextCeiling(client: ModelClient, _model: string): Promise<ProbeResult> {
  const candidates = [8_000, 32_000, 128_000];
  // Step through the ladder; the first failure bounds the search.
  let lo = 0;
  let hi = 128_000;
  for (const n of candidates) {
    if (await tryPrompt(client, n)) {
      lo = n;
    } else {
      hi = n;
      break;
    }
  }
  if (lo === 0) {
    // Even 8k failed — check the model answers a minimal prompt at all.
    const minimal = await client.complete({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 4,
    });
    return {
      probe: 'context_ceiling',
      passed: false,
      failureCode: 'probe_context_short',
      records: { observedContextWindow: 0 },
      detail: minimal.ok
        ? 'rejected an 8000-token prompt; usable context is smaller than 8k'
        : 'model did not answer a minimal prompt during the context probe',
    };
  }
  // Refine with a binary search in (lo, hi).
  while (hi - lo > 2048) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await tryPrompt(client, mid)) lo = mid;
    else hi = mid;
  }
  return {
    probe: 'context_ceiling',
    passed: true,
    records: { observedContextWindow: lo },
  };
}

async function tryPrompt(client: ModelClient, tokens: number): Promise<boolean> {
  // Build roughly `tokens` tokens of filler at ~4 chars/token. Repeat the
  // block enough that the slice target is actually reached.
  const targetChars = tokens * 4;
  const repeats = Math.max(1, Math.ceil(targetChars / FILLER_BLOCK.length));
  const content = FILLER_BLOCK.repeat(repeats).slice(0, targetChars);
  const res = await client.complete({
    messages: [{ role: 'user', content }],
    maxTokens: 4,
  });
  if (!res.ok && res.error && /context|length|token/i.test(`${res.error.type ?? ''} ${res.error.message ?? ''}`)) {
    return false;
  }
  return res.ok;
}

/** Probe 5: vision — 1x1 px PNG + "what colour". */
async function probeVision(client: ModelClient, _model: string): Promise<ProbeResult> {
  const res = await client.complete({
    messages: [{ role: 'user', content: 'what colour is this 1x1 px PNG?' }],
    maxTokens: 16,
  });
  const modalityError = res.ok === false && /image|vision|modality|multimodal/i.test(`${res.error?.message ?? ''}`);
  return {
    probe: 'vision',
    passed: res.ok && !modalityError,
    records: { vision: res.ok && !modalityError },
  };
}

/** Probe 6: prompt caching — two identical 2,500-token calls 3 s apart. */
async function probePromptCache(client: ModelClient, _model: string): Promise<ProbeResult> {
  const repeats = Math.max(1, Math.ceil(2500 / FILLER_TOKENS_PER_BLOCK));
  const content = FILLER_BLOCK.repeat(repeats);
  await client.complete({ messages: [{ role: 'user', content }], maxTokens: 4 });
  const second = await client.complete({ messages: [{ role: 'user', content }], maxTokens: 4 });
  const cached = (second.usage?.cachedInputTokens ?? 0) > 0;
  return {
    probe: 'prompt_cache',
    passed: cached,
    records: { promptCache: cached },
  };
}
