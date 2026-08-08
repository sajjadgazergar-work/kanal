/**
 * Error taxonomy for the prompt subsystem (plan §7.4, §16.1).
 *
 * Every failure mode the renderer, loader, or zone assembler can hit is a
 * named error class with a `code`. Callers can branch on `code` without
 * string-matching.
 */

/** Base class for all errors thrown by @kanal/prompts. */
export class PromptsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Undeclared variable or a schema violation. */
export class TemplateLoadError extends PromptsError {
  constructor(message: string) {
    super('template_load_error', message);
  }
}

/** Loop iteration cap, render timeout, or output size cap exceeded. */
export class RenderGuardError extends PromptsError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** `{% include %}` resolved outside the pack root, or an unknown include. */
export class TemplateIncludeError extends PromptsError {
  constructor(message: string) {
    super('template_include_error', message);
  }
}

/** Pack metadata invalid or core_api range not satisfied. */
export class PackLoadError extends PromptsError {
  constructor(message: string) {
    super('pack_load_error', message);
  }
}

/** A requested pack template/locale does not exist in the pack. */
export class PackTemplateError extends PromptsError {
  constructor(message: string) {
    super('pack_template_error', message);
  }
}

/** A pack's locale directory is missing or has no templates. */
export class PackLocaleError extends PromptsError {
  constructor(message: string) {
    super('pack_locale_error', message);
  }
}

/** A trusted-zone prompt was constructed from raw untrusted text. */
export class ZoneViolationError extends PromptsError {
  constructor(message: string) {
    super('zone_violation_error', message);
  }
}
