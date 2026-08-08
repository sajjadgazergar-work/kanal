import type { Zone, GateVerdict, RunState } from '@kanal/contracts';

/**
 * The stage contract (plan §9.1). Every stage implements one signature.
 * Non-LLM stages are the same shape with no `model` field, which is what lets
 * the trace viewer render all of them identically.
 */
export interface Stage<I, O> {
  id: string; // 'editorial.critique'
  optional: boolean;
  zone: Zone;
  inputContract: string; // contract id
  outputContract: string;
  run(input: I, ctx: RunCtx): Promise<StageResult<O>>;
  gate?: (out: O, ctx: RunCtx) => GateVerdict; // 'pass' | 'revise' | 'block' | 'human'
}

export type StageResult<O> = { ok: true; output: O } | { ok: false; error: StageError };

export interface StageError {
  code: string;
  message: string;
  /** only the schema validation error, never the model's previous free text */
  repairHint?: string;
}

/** Context handed to every stage. Holds the run, budget guard, and capability access. */
export interface RunCtx {
  run: {
    id: string;
    orgId: string;
    channelId: string;
    lane: 'auto' | 'copilot' | 'manual';
    state: RunState;
    brief: Record<string, unknown>;
    budgetCapUsd: number;
    spentUsd: number;
    cancelRequested: boolean;
  };
  /** the budget guard from §7.8 — every model call goes through it */
  model: (req: ModelRequest) => Promise<ModelResponse>;
  tool: (capabilityId: string, args: unknown) => Promise<unknown>;
  /** returns memoized output or runs fresh */
  memoized: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  log: (evt: RunCtxEvent) => void;
}

export interface ModelRequest {
  stage: string;
  modelRef?: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  /** forces structured output against this zod schema — probe must confirm support */
  structuredOutputSchema?: Record<string, unknown>;
  cacheControl?: 'stable-prefix' | 'none';
}

export interface ModelResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  modelRef: string;
  finishReason?: string;
}

/** Narrow events a stage can emit — these become spans and LiveEvents (§13.3). */
export type RunCtxEvent =
  | { t: 'model.call'; model: string; inTok: number; outTok: number; ms: number; costUsd: number }
  | { t: 'tool.call'; capability: string; ok: boolean }
  | { t: 'note'; stage: string; message: string };
