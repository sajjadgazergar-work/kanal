import { type ProviderConfig } from './config.js';
import { type Transport, headersForProvider } from './transport.js';
import {
  type ProbeCompletionRequest,
  type ProbeCompletionResponse,
} from './probe/index.js';

/**
 * Model client: a thin dialect layer over an injectable transport. Given the
 * constraint of no network in tests, everything goes through `Transport`, so a
 * fake transport satisfies the whole client surface.
 */

export interface CompletionRequest extends ProbeCompletionRequest {
  model: string;
}

export interface CompletionResult extends ProbeCompletionResponse {
  /** The model that actually served this call (for cost ledger + fallback tags). */
  model?: string;
}

export class ModelClient {
  constructor(
    private readonly cfg: ProviderConfig,
    private readonly transport: Transport,
    private readonly decryptKey: () => string | undefined,
  ) {}

  /** Path building per dialect. */
  private completionPath(): string {
    switch (this.cfg.dialect) {
      case 'anthropic':
        return '/v1/messages';
      case 'ollama':
        return '/api/chat';
      default:
        return '/v1/chat/completions';
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const key = this.decryptKey();
    const headers = headersForProvider(this.cfg, key);
    const path = this.completionPath();
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}${path}`;
    const body = this.serializeBody(req);
    let resp;
    try {
      resp = await this.transport.request({
        method: 'POST',
        url,
        headers: { ...headers, 'content-type': 'application/json' },
        body,
        timeoutMs: this.cfg.timeoutMs,
      });
    } catch (e) {
      return {
        ok: false,
        error: { type: 'transport', message: e instanceof Error ? e.message : String(e) },
      };
    }
    return this.parseResponse(resp.body, req.model);
  }

  private serializeBody(req: CompletionRequest): string {
    const base: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
    };
    if (req.temperature !== undefined) base.temperature = req.temperature;
    if (req.tools && req.tools.length > 0) base.tools = req.tools;
    if (req.stream) base.stream = true;
    if (req.responseFormat) {
      if (this.cfg.dialect === 'anthropic') {
        // Anthropic expresses structured output as a tool-free "json" type.
        base.response_format = { type: 'json' };
      } else {
        base.response_format = { type: 'json_object', schema: req.responseFormat.schema };
      }
    }
    return JSON.stringify(base);
  }

  private parseResponse(raw: string, model: string): CompletionResult {
    const out: CompletionResult = { ok: false, model };
    if (!raw) return out;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      out.ok = false;
      out.error = { type: 'parse', message: 'response body was not JSON' };
      return out;
    }
    if (json === null || typeof json !== 'object') return out;

    const j = json as Record<string, unknown>;

    // OpenAI-compatible shape: { choices: [{ message: { content, tool_calls } }], usage }
    if (this.cfg.dialect !== 'anthropic') {
      const choices = Array.isArray(j.choices) ? j.choices : [];
      const choice = choices[0];
      if (choice !== undefined && typeof choice === 'object') {
        const c = choice as Record<string, unknown>;
        const message = (c.message ?? {}) as Record<string, unknown>;
        if (typeof message.content === 'string') out.text = message.content;
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        out.toolCalls = toolCalls.map((tc) => {
          const t = tc as Record<string, unknown>;
          const fn = (t.function ?? {}) as Record<string, unknown>;
          return {
            name: typeof fn.name === 'string' ? fn.name : '',
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments),
          };
        });
        out.streamed = c.finish_reason === 'length' || c.finish_reason === 'stop' ? Boolean((c as { streamed?: boolean }).streamed) : false;
      }
      const usage = (j.usage ?? {}) as Record<string, unknown>;
      if (typeof usage.prompt_tokens === 'number') {
        const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
        out.usage = {
          inputTokens: usage.prompt_tokens,
          outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
          cachedInputTokens: typeof details.cached_tokens === 'number' ? details.cached_tokens : 0,
        };
      }
      out.ok = true;
      return out;
    }

    // Anthropic shape: { content: [{ type: 'text' | 'tool_use', ... }], usage }
    const content = Array.isArray(j.content) ? j.content : [];
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        out.text = (out.text ?? '') + b.text;
      }
      if (b.type === 'tool_use') {
        const tc = out.toolCalls ?? [];
        tc.push({ name: typeof b.name === 'string' ? b.name : '', arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}) });
        out.toolCalls = tc;
      }
    }
    const usage = (j.usage ?? {}) as Record<string, unknown>;
    out.usage = {
      inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
      outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      cachedInputTokens: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0,
    };
    out.ok = true;
    return out;
  }
}
