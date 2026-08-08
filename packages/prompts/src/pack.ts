/**
 * Prompt pack model (plan §7.4, §7.6).
 *
 * A pack is a semver-versioned directory of locale-scoped templates plus a
 * `vars.schema.json` that fixes the variable namespace the templates may
 * reference.
 */

import type { VarsSchema } from './renderer.js';

export interface PromptPack {
  /** Pack id, e.g. `default-editorial`. */
  id: string;
  /** Semantic version of the pack, e.g. `3.2.1`. */
  semver: string;
  /** Declared core_api range, e.g. `^1.2`; validated against CORE_API_VERSION. */
  coreApi: string;
  /** Locales shipped in this pack, e.g. `['en', 'fa']`. */
  locales: string[];
  /** Optional pack signature (plan §7.4: signature field). */
  signature?: string;
  /**
   * `vars.schema.json` — the exact variable namespace the templates may
   * reference. The renderer rejects any undeclared variable.
   */
  vars: VarsSchema;
  /** Loaded templates: `"{locale}/{template}" -> source`. */
  templates: Record<string, string>;
  /**
   * Local path or git URL this pack was resolved from (informational; used
   * for traceability in the audit log).
   */
  source?: string;
}

/** Rendered message role for the message array (plan §7.4). */
export type PromptRole = 'system' | 'user' | 'assistant';

export interface RenderedPrompt {
  role: PromptRole;
  content: string;
}

/** A loaded, renderable template inside a pack. */
export interface PackTemplate {
  locale: string;
  name: string;
  source: string;
}

/** Requested template selector. */
export interface TemplateRef {
  locale: string;
  /** Template name without extension, e.g. `writer.main`. */
  name: string;
}
