/**
 * @kanal/prompts — the prompt subsystem (plan §7.4, §7.6, §16.1).
 *
 * Restricted MiniJinja-compatible template renderer, prompt packs, the pack
 * loader, and zone-aware prompt assembly. The zone boundary is structural:
 * raw untrusted `body_text` cannot reach a trusted-zone prompt.
 */

export * from './errors.js';
export * from './renderer.js';
export * from './pack.js';
export * from './loader.js';
export * from './sanitize.js';
export * from './zones.js';
export * from './assemble.js';
