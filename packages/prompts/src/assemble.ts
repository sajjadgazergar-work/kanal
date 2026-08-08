/**
 * Prompt assembly from packs (plan §7.4).
 *
 * Rendered output is inserted into the message array at a DECLARED role and
 * position. A pack cannot invent a system message after untrusted content —
 * the caller (core) decides the message order and the roles; the pack only
 * supplies template text. This module enforces that: the role comes from the
 * assembly spec, never from the template content.
 */

import type { PromptPack, PromptRole, RenderedPrompt, TemplateRef } from './pack.js';
import { getTemplate } from './loader.js';
import { renderTemplate, type RenderResult } from './renderer.js';
import { TemplateLoadError } from './errors.js';

/** One step in a prompt assembly: a template rendered into a declared slot. */
export interface PromptStep {
  ref: TemplateRef;
  role: PromptRole;
  /** Position among same-role messages; lower renders earlier. */
  order: number;
  context: Record<string, unknown>;
}

export interface AssembleOptions {
  pack: PromptPack;
  steps: PromptStep[];
}

export interface AssembleResult {
  messages: RenderedPrompt[];
  /** Include resolution order, for traceability. */
  included: string[];
}

/**
 * Renders a set of template steps into an ordered message array.
 *
 * Validation performed:
 *   - duplicate (role, order) slots are rejected;
 *   - a system message may not follow a user/assistant message (a pack cannot
 *     inject a system prompt after untrusted content).
 *
 * @throws TemplateLoadError when a template references an undeclared variable
 *   or a step's template is missing.
 */
export function assemblePrompt(opts: AssembleOptions): AssembleResult {
  const { pack, steps } = opts;

  // Validate the slot layout before rendering anything.
  const seenSlots = new Set<string>();
  const ordered = [...steps].sort((a, b) => a.order - b.order);
  let sawNonSystem = false;
  for (const step of ordered) {
    const slot = `${step.role}:${step.order}`;
    if (seenSlots.has(slot)) {
      throw new TemplateLoadError(`duplicate prompt slot '${slot}'`);
    }
    seenSlots.add(slot);
    if (step.role === 'system' && sawNonSystem) {
      throw new TemplateLoadError(
        `system message at slot '${slot}' appears after non-system content; ` +
          'a pack cannot invent a system message after untrusted content',
      );
    }
    if (step.role !== 'system') sawNonSystem = true;
  }

  const messages: RenderedPrompt[] = [];
  const included: string[] = [];
  for (const step of ordered) {
    const source = getTemplate(pack, step.ref);
    const result: RenderResult = renderTemplate({
      source,
      context: step.context,
      varsSchema: pack.vars,
      includeSources: pack.templates,
    });
    for (const inc of result.included) {
      if (!included.includes(inc)) included.push(inc);
    }
    messages.push({ role: step.role, content: result.output });
  }
  return { messages, included };
}
