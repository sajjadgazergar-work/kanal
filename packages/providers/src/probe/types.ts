import { z } from 'zod';

/**
 * Capability probe model (plan §11.4). Six probes, run once per (provider,
 * model) and cached with a 14-day TTL. Total probe cost < $0.002 per model.
 */

export const probeIdSchema = z.enum([
  'liveness',
  'tool_calling',
  'structured_output',
  'context_ceiling',
  'vision',
  'prompt_cache',
]);
export type ProbeId = z.infer<typeof probeIdSchema>;

export const structuredOutputKindSchema = z.enum(['native', 'prompted', 'none']);
export type StructuredOutputKind = z.infer<typeof structuredOutputKindSchema>;

export const modelCapabilitiesSchema = z.object({
  streaming: z.boolean().optional(),
  usageReported: z.boolean().optional(),
  toolCalling: z.boolean().optional(),
  parallelToolCalls: z.boolean().optional(),
  structuredOutput: structuredOutputKindSchema.optional(),
  observedContextWindow: z.number().int().positive().optional(),
  vision: z.boolean().optional(),
  promptCache: z.boolean().optional(),
  probedAt: z.string().optional(),
  drift: z.boolean().optional(),
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

/** Cache TTL for probe results (plan §11.4). */
export const PROBE_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface ProbeResult {
  probe: ProbeId;
  passed: boolean;
  /** Freeform record written to model.capabilities. */
  records: Record<string, unknown>;
  /** Failure code when the probe did not pass. */
  failureCode?:
    | 'probe_no_tool_calling'
    | 'probe_no_structured_output'
    | 'probe_context_short';
  detail?: string;
}
