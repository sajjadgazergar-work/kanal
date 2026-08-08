/**
 * A MiniJinja-compatible restricted template renderer (plan §7.4).
 *
 * Rejected alternatives, per plan §7.4:
 *   - raw JS template literals        — arbitrary code execution
 *   - Handlebars helpers              — helper registration is a code path
 *   - plain string interpolation      — no loops, unusable for claim lists
 *
 * This engine is deliberately tiny and hand-rolled so the safety properties
 * are owned, not inherited from a full library:
 *
 *   - NO filesystem, network, or environment access. The only text that
 *     enters the output is the caller-supplied `context` (pre-validated
 *     against `vars.schema.json`) or a `{% include %}` resolved strictly
 *     inside the pack root. The caller (the pack loader) supplies the pack's
 *     templates as an in-memory map; the renderer never touches a path.
 *   - the variable namespace is fixed by `vars.schema.json`; referencing an
 *     undeclared variable is a *load-time* error (thrown before any output
 *     is produced, even in branches that never execute), never a silent
 *     empty string.
 *   - loop iteration cap 512, render timeout 250 ms (shared across includes),
 *     rendered output cap 120 KB.
 *
 * Supported syntax: `{{ expr }}`, `{% for x in seq %}`, `{% endfor %}`,
 * `{% if expr %}`, `{% endif %}`, `{% else %}`, `{% include "name" %}`.
 * `for`/`if` may be nested freely; `else` binds to the nearest open block.
 *
 * Expressions: dotted paths (`a.b.c`), array literals, string literals
 * (single or double quotes), integer literals, the comparison operators
 * `== != > < >= <=`, and the `in` operator against array literals or paths.
 * Everything else is rejected at parse time.
 */

import { RenderGuardError, TemplateIncludeError, TemplateLoadError } from './errors.js';

/** Runtime constraints (plan §7.4). */
export const LOOP_ITERATION_CAP = 512;
export const RENDER_TIMEOUT_MS = 250;
export const OUTPUT_SIZE_CAP = 120 * 1024; // 120 KB

export type TemplateVarType = 'string' | 'number' | 'boolean' | 'array' | 'object';

/**
 * The shape of `vars.schema.json`. Only fields that affect the renderer's
 * safety properties are interpreted; a full JSON Schema validator can refine
 * the rest.
 */
export interface VarsSchema {
  properties?: Record<string, { type?: TemplateVarType } | undefined>;
}

export interface TemplateEnv {
  /** `vars.schema.json` for this pack. */
  vars: VarsSchema;
  /** `true` when variables are restricted to the declared namespace. */
  restrictVars: boolean;
}

/**
 * Creates a template environment from a `vars.schema.json`-style declaration.
 *
 * @throws TemplateLoadError if the schema is not a usable declaration.
 */
export function createTemplateEnv(varsSchema: VarsSchema): TemplateEnv {
  if (!varsSchema || typeof varsSchema !== 'object') {
    throw new TemplateLoadError('vars.schema.json must be an object');
  }
  const props = varsSchema.properties ?? {};
  for (const key of Object.keys(props)) {
    const def = props[key];
    if (def && def.type !== undefined) {
      const t = def.type;
      if (t !== 'string' && t !== 'number' && t !== 'boolean' && t !== 'array' && t !== 'object') {
        throw new TemplateLoadError(`invalid type '${t}' for variable '${key}'`);
      }
    }
  }
  return { vars: varsSchema, restrictVars: true };
}

/**
 * Normalizes a relative template name to a canonical forward-slash path,
 * collapsing `.`/`..` segments. Throws when the path would escape the pack
 * root.
 */
function normalizeRel(name: string): string {
  let cleaned = name.replace(/\\/g, '/').replace(/^\.\//, '');
  cleaned = cleaned.replace(/\/+/g, '/');
  const parts = cleaned.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) {
        throw new TemplateIncludeError(`include escapes pack root: '${name}'`);
      }
      out.pop();
    } else {
      out.push(part);
    }
  }
  if (out.length === 0) {
    throw new TemplateIncludeError(`include resolves to pack root itself: '${name}'`);
  }
  return out.join('/');
}

/**
 * Resolves an include name, rejecting any path that is absolute or escapes
 * the pack root. Returns a canonical relative name used as a key into the
 * include map.
 *
 * @throws TemplateIncludeError when the name is absolute or escapes.
 */
export function resolveIncludeName(name: string): string {
  if (name.length === 0) throw new TemplateIncludeError('empty include name');
  if (name.includes('\0')) throw new TemplateIncludeError(`invalid include name '${name}'`);
  if (name.startsWith('/')) throw new TemplateIncludeError(`include outside pack root: '${name}'`);
  // Windows absolute drive paths and UNC
  if (/^[a-zA-Z]:[\\/]/.test(name)) throw new TemplateIncludeError(`absolute include path rejected: '${name}'`);
  if (name.startsWith('\\\\')) throw new TemplateIncludeError(`absolute include path rejected: '${name}'`);
  return normalizeRel(name);
}

export interface RenderOptions {
  /** Raw template source (never a file path). */
  source: string;
  /** Pre-validated variable values (the namespace is enforced via varsSchema). */
  context: Record<string, unknown>;
  /** `vars.schema.json` for the pack. When present, the namespace is restricted to its `properties`. */
  varsSchema?: VarsSchema;
  /**
   * In-memory map of template name -> source for `{% include %}`. Keys are
   * canonical relative names inside the pack root (e.g. `en/header.tmpl`).
   * Includes are resolved only against this map; names that escape the pack
   * root are rejected before lookup.
   */
  includeSources?: Record<string, string>;
  /** Override the loop iteration cap (defaults to {@link LOOP_ITERATION_CAP}). */
  loopCap?: number;
  /** Override the render timeout in ms (defaults to {@link RENDER_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Override the output size cap in bytes (defaults to {@link OUTPUT_SIZE_CAP}). */
  outputSizeCap?: number;
}

export interface RenderResult {
  output: string;
  /** Template names pulled in via `{% include %}`, in resolution order. */
  included: string[];
}

/**
 * Load-time validation only: parses the template and checks every referenced
 * variable against the vars schema, without producing any output. Throws
 * TemplateLoadError (undeclared variable, syntax error) or TemplateIncludeError.
 *
 * This is what the pack loader calls at install time so a pack that references
 * an undeclared variable is rejected on load, not at first render.
 */
export function validateTemplate(source: string, varsSchema?: VarsSchema): void {
  const env: TemplateEnv = createTemplateEnv(varsSchema ?? { properties: {} });
  // The RenderEngine constructor parses and validates; no render occurs.
  void new RenderEngine(
    source,
    {},
    env,
    {},
    {
      loopCap: LOOP_ITERATION_CAP,
      timeoutMs: RENDER_TIMEOUT_MS,
      outputSizeCap: OUTPUT_SIZE_CAP,
      deadline: performance.now() + RENDER_TIMEOUT_MS,
    },
    [],
  );
}

/**
 * Renders a template against a context.
 *
 * Load-time errors (undeclared variable, unknown include, syntax) are thrown
 * before any output is produced. Runtime guards (loop cap, timeout, output
 * size cap) are enforced while rendering.
 */
export function renderTemplate(opts: RenderOptions): RenderResult {
  const { source, context, varsSchema } = opts;
  const includeSources = opts.includeSources ?? {};
  const loopCap = opts.loopCap ?? LOOP_ITERATION_CAP;
  const timeoutMs = opts.timeoutMs ?? RENDER_TIMEOUT_MS;
  const outputSizeCap = opts.outputSizeCap ?? OUTPUT_SIZE_CAP;
  if (loopCap <= 0) throw new TemplateLoadError('loopCap must be positive');

  // When no vars schema is given the namespace is unrestricted (callers that
  // need the safety property always pass the pack's vars.schema.json).
  const env: TemplateEnv =
    varsSchema !== undefined
      ? createTemplateEnv(varsSchema)
      : { vars: { properties: {} }, restrictVars: false };
  // performance.now() has sub-millisecond resolution, which makes the timeout
  // deterministic for tests and precise in production.
  const deadline = performance.now() + timeoutMs;
  const engine = new RenderEngine(source, context, env, includeSources, {
    loopCap,
    timeoutMs,
    outputSizeCap,
    deadline,
  });
  return engine.run();
}

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'expr'; value: Expr }
  | { kind: 'for'; variable: string; sequence: Expr; body: Node[]; elseBody: Node[] }
  | { kind: 'if'; condition: Expr; body: Node[]; elseBody: Node[] }
  | { kind: 'include'; name: string };

type Expr =
  | { kind: 'path'; name: string }
  | { kind: 'lit'; value: unknown }
  | { kind: 'arr'; items: Expr[] }
  | { kind: 'compare'; op: string; left: Expr; right: Expr }
  | { kind: 'in'; left: Expr; right: Expr }
  | { kind: 'filter'; name: string; args: Expr[]; base: Expr };

/**
 * The fixed, built-in filter set (MiniJinja-compatible restricted feature
 * set). Pure data transforms only — no helpers can be registered at runtime,
 * which is what keeps filters non-escapable.
 */
const FILTERS: Record<string, (value: unknown, args: unknown[]) => unknown> = {
  join(value, args) {
    const sep = args[0] === undefined ? ', ' : String(args[0]);
    if (Array.isArray(value)) {
      return value
        .map((v) => (v === null || v === undefined ? '' : String(v)))
        .join(sep);
    }
    return value === null || value === undefined ? '' : String(value);
  },
  tojson(value) {
    if (value === undefined) return 'null';
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  },
  lower(value) {
    return value === null || value === undefined ? '' : String(value).toLowerCase();
  },
  upper(value) {
    return value === null || value === undefined ? '' : String(value).toUpperCase();
  },
  trim(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  },
  length(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'string' || Array.isArray(value)) return value.length;
    return 0;
  },
  default(value, args) {
    const fallback = args[0];
    const empty =
      value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    return empty ? fallback : value;
  },
};

interface EngineOpts {
  loopCap: number;
  timeoutMs: number;
  outputSizeCap: number;
  /** Absolute deadline; shared across includes so the budget cannot be reset. */
  deadline: number;
}

/** Loop variables that the template introduces itself. */
const BUILTIN_ROOTS = new Set(['loop']);

class RenderEngine {
  private readonly opts: EngineOpts;
  private readonly context: Record<string, unknown>;
  private readonly env: TemplateEnv;
  private readonly includeSources: Record<string, string>;
  private readonly root: Node[];
  private readonly declaredVars: Set<string>;
  private iterationCount = 0;
  private outputSize = 0;
  /**
   * Include stack shared across the whole include tree so a cycle cannot be
   * hidden by creating a fresh engine per include.
   */
  private readonly includeStack: string[];

  constructor(
    source: string,
    context: Record<string, unknown>,
    env: TemplateEnv,
    includeSources: Record<string, string>,
    opts: EngineOpts,
    includeStack?: string[],
  ) {
    this.opts = opts;
    this.context = context;
    this.env = env;
    this.includeSources = includeSources;
    this.includeStack = includeStack ?? [];
    const declared = new Set<string>();
    const props = env.vars.properties ?? {};
    for (const key of Object.keys(props)) declared.add(key);
    this.declaredVars = declared;
    this.root = new Parser(source, opts.loopCap).parse();
    this.validateVariables();
  }

  /** Load-time check: every referenced variable root must be declared or a loop variable. */
  private validateVariables(): void {
    if (!this.env.restrictVars) return;
    const roots = new Set<string>();
    collectVarRoots(this.root, roots, new Set());
    for (const root of roots) {
      if (!this.declaredVars.has(root) && !BUILTIN_ROOTS.has(root)) {
        throw new TemplateLoadError(
          `undeclared variable '${root}' referenced in template; ` +
            `declared variables: ${[...this.declaredVars].join(', ') || '(none)'}`,
        );
      }
    }
  }

  run(): RenderResult {
    const included: string[] = [];
    const out = this.renderNodes(this.root, this.context, undefined, included);
    this.checkTimeout();
    if (this.outputSize > this.opts.outputSizeCap) {
      throw new RenderGuardError(
        'render_output_too_large',
        `rendered output ${this.outputSize} bytes exceeds cap ${this.opts.outputSizeCap}`,
      );
    }
    return { output: out, included };
  }

  private renderNodes(
    nodes: Node[],
    scope: Record<string, unknown>,
    parentScope: Record<string, unknown> | undefined,
    included: string[],
  ): string {
    let out = '';
    for (const node of nodes) {
      if (node.kind === 'text') {
        out += node.value;
      } else if (node.kind === 'expr') {
        const value = this.evalExpr(node.value, scope, parentScope);
        out += this.stringify(value);
      } else if (node.kind === 'for') {
        const seq = this.evalExpr(node.sequence, scope, parentScope);
        const arr = Array.isArray(seq) ? seq : [];
        let renderedElse = true;
        for (let i = 0; i < arr.length; i++) {
          this.iterationCount += 1;
          if (this.iterationCount > this.opts.loopCap) {
            throw new RenderGuardError(
              'loop_iteration_cap_exceeded',
              `loop iteration cap of ${this.opts.loopCap} exceeded`,
            );
          }
          this.checkTimeout();
          const childScope: Record<string, unknown> = {};
          childScope[node.variable] = arr[i];
          childScope['loop'] = {
            index: i + 1,
            index0: i,
            first: i === 0,
            last: i === arr.length - 1,
            length: arr.length,
          };
          out += this.renderNodes(node.body, childScope, scope, included);
          renderedElse = false;
        }
        if (renderedElse) {
          out += this.renderNodes(node.elseBody, scope, parentScope, included);
        }
      } else if (node.kind === 'if') {
        if (this.truthy(this.evalExpr(node.condition, scope, parentScope))) {
          out += this.renderNodes(node.body, scope, parentScope, included);
        } else {
          out += this.renderNodes(node.elseBody, scope, parentScope, included);
        }
      } else if (node.kind === 'include') {
        const name = this.resolveIncludeName(node.name, scope, parentScope);
        const canonical = resolveIncludeName(name);
        if (this.includeStack.includes(canonical)) {
          throw new TemplateIncludeError(`circular include detected: '${name}'`);
        }
        if (this.includeStack.length >= 16) {
          throw new TemplateIncludeError('include depth exceeds 16 (possible cycle)');
        }
        const subSource = this.includeSources[canonical];
        if (subSource === undefined) {
          throw new TemplateIncludeError(`unknown include '${name}'`);
        }
        this.includeStack.push(canonical);
        try {
          // Share the deadline and the include stack so a chain of includes
          // cannot reset the 250ms budget nor hide a cycle.
          const sub = new RenderEngine(
            subSource,
            this.context,
            this.env,
            this.includeSources,
            this.opts,
            this.includeStack,
          );
          const subOut = sub.renderNodes(sub.root, scope, parentScope, included);
          out += subOut;
          this.iterationCount += sub.iterationCount;
          this.checkTimeout();
          if (!included.includes(canonical)) included.push(canonical);
        } finally {
          this.includeStack.pop();
        }
      }
      this.checkOutputCap(out);
    }
    return out;
  }

  private evalExpr(
    expr: Expr,
    scope: Record<string, unknown>,
    parentScope: Record<string, unknown> | undefined,
  ): unknown {
    switch (expr.kind) {
      case 'lit':
        return expr.value;
      case 'arr':
        return expr.items.map((i) => this.evalExpr(i, scope, parentScope));
      case 'path':
        return this.lookupPath(expr.name, scope, parentScope);
      case 'filter': {
        const base = this.evalExpr(expr.base, scope, parentScope);
        const fn = FILTERS[expr.name];
        if (!fn) {
          throw new TemplateLoadError(`unknown filter '${expr.name}'`);
        }
        const args = expr.args.map((a) => this.evalExpr(a, scope, parentScope));
        return fn(base, args);
      }
      case 'compare': {
        const l = this.evalExpr(expr.left, scope, parentScope);
        const r = this.evalExpr(expr.right, scope, parentScope);
        switch (expr.op) {
          case '==':
            return l === r;
          case '!=':
            return l !== r;
          case '>':
            return (l as number) > (r as number);
          case '<':
            return (l as number) < (r as number);
          case '>=':
            return (l as number) >= (r as number);
          case '<=':
            return (l as number) <= (r as number);
          default:
            return false;
        }
      }
      case 'in': {
        const l = this.evalExpr(expr.left, scope, parentScope);
        const r = this.evalExpr(expr.right, scope, parentScope);
        return Array.isArray(r) ? r.includes(l) : false;
      }
    }
  }

  private lookupPath(
    name: string,
    scope: Record<string, unknown>,
    parentScope: Record<string, unknown> | undefined,
  ): unknown {
    const segments = name.split('.');
    const head = segments[0]!;
    let value: unknown = undefined;
    if (head in scope) {
      value = scope[head];
    } else if (parentScope !== undefined && head in parentScope) {
      value = parentScope[head];
    } else if (head in this.context) {
      value = this.context[head];
    }
    if (segments.length === 1) return value;
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i]!;
      if (value === null || value === undefined) return undefined;
      if (Array.isArray(value) && seg === 'length') {
        value = value.length;
      } else if (typeof value === 'object') {
        value = (value as Record<string, unknown>)[seg];
      } else {
        return undefined;
      }
    }
    return value;
  }

  private resolveIncludeName(
    name: string,
    scope: Record<string, unknown>,
    parentScope: Record<string, unknown> | undefined,
  ): string {
    if (
      (name.startsWith('"') && name.endsWith('"')) ||
      (name.startsWith("'") && name.endsWith("'"))
    ) {
      return name.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(name)) {
      const v = this.lookupPath(name, scope, parentScope);
      if (typeof v === 'string') return v;
      throw new TemplateLoadError(`include name expression '${name}' did not resolve to a string`);
    }
    return name;
  }

  private stringify(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      return value.map((v) => (v === null || v === undefined ? '' : String(v))).join(', ');
    }
    return String(value);
  }

  private truthy(v: unknown): boolean {
    if (v === undefined || v === null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  }

  private checkTimeout(): void {
    if (performance.now() > this.opts.deadline) {
      throw new RenderGuardError('render_timeout', `render exceeded ${this.opts.timeoutMs}ms timeout`);
    }
  }

  private checkOutputCap(out: string): void {
    this.outputSize = out.length;
    // Timeout is re-checked at every node boundary so a long render cannot run
    // unbounded even when individual iterations are cheap.
    this.checkTimeout();
    if (this.outputSize > this.opts.outputSizeCap) {
      throw new RenderGuardError(
        'render_output_too_large',
        `rendered output ${this.outputSize} bytes exceeds cap ${this.opts.outputSizeCap}`,
      );
    }
  }
}

/** Collects all referenced variable roots for load-time validation. */
function collectVarRoots(nodes: Node[], roots: Set<string>, loopVars: Set<string>): void {
  for (const node of nodes) {
    if (node.kind === 'expr') {
      collectExprRoots(node.value, roots, loopVars);
    } else if (node.kind === 'for') {
      collectExprRoots(node.sequence, roots, loopVars);
      const inner = new Set(loopVars);
      inner.add(node.variable);
      collectVarRoots(node.body, roots, inner);
      collectVarRoots(node.elseBody, roots, inner);
    } else if (node.kind === 'if') {
      collectExprRoots(node.condition, roots, loopVars);
      collectVarRoots(node.body, roots, loopVars);
      collectVarRoots(node.elseBody, roots, loopVars);
    } else if (node.kind === 'include') {
      const name = node.name;
      if (!(name.startsWith('"') || name.startsWith("'"))) {
        if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(name) && !loopVars.has(name)) {
          roots.add(name.split('.')[0]!);
        }
      }
    }
  }
}

function collectExprRoots(expr: Expr, roots: Set<string>, loopVars: Set<string>): void {
  switch (expr.kind) {
    case 'path': {
      const head = expr.name.split('.')[0]!;
      if (!loopVars.has(head)) roots.add(head);
      break;
    }
    case 'arr':
      for (const item of expr.items) collectExprRoots(item, roots, loopVars);
      break;
    case 'compare':
      collectExprRoots(expr.left, roots, loopVars);
      collectExprRoots(expr.right, roots, loopVars);
      break;
    case 'in':
      collectExprRoots(expr.left, roots, loopVars);
      collectExprRoots(expr.right, roots, loopVars);
      break;
    case 'filter':
      collectExprRoots(expr.base, roots, loopVars);
      for (const arg of expr.args) collectExprRoots(arg, roots, loopVars);
      break;
    case 'lit':
      break;
  }
}

type Tok =
  | { type: 'text'; value: string }
  | { type: 'expr'; value: string }
  | { type: 'tag'; value: string };

function tokenize(source: string): Tok[] {
  const toks: Tok[] = [];
  let pos = 0;
  let textStart = 0;
  const n = source.length;
  while (pos < n) {
    const open = source.indexOf('{{', pos);
    const tagOpen = source.indexOf('{%', pos);
    let next = -1;
    let isExpr = true;
    if (open === -1 && tagOpen === -1) break;
    if (open !== -1 && (tagOpen === -1 || open < tagOpen)) {
      next = open;
      isExpr = true;
    } else {
      next = tagOpen;
      isExpr = false;
    }
    if (next > textStart) {
      toks.push({ type: 'text', value: source.slice(textStart, next) });
    }
    const closer = isExpr ? '}}' : '%}';
    const closeAt = source.indexOf(closer, next + 2);
    if (closeAt === -1) {
      throw new TemplateLoadError(`unterminated ${isExpr ? 'expression' : 'tag'} at position ${next}`);
    }
    const inner = source.slice(next + 2, closeAt).trim();
    if (isExpr) {
      toks.push({ type: 'expr', value: inner });
    } else {
      toks.push({ type: 'tag', value: inner });
    }
    pos = closeAt + 2;
    textStart = pos;
  }
  if (textStart < n) {
    toks.push({ type: 'text', value: source.slice(textStart) });
  }
  return toks;
}

interface ParsedTag {
  name: string;
  args: string[];
}

function parseTag(raw: string): ParsedTag {
  const trimmed = raw.trim();
  const m = trimmed.match(/^(\w+)([\s\S]*)$/);
  if (!m) return { name: '', args: [] };
  const name = m[1]!;
  const rest = (m[2] ?? '').trim();
  if (rest.length === 0) return { name, args: [] };
  const args: string[] = [];
  let cur = '';
  let inStr: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (inStr) {
      cur += c;
      if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") {
      inStr = c;
      cur += c;
    } else if (/\s/.test(c)) {
      if (cur.length > 0) {
        args.push(cur);
        cur = '';
      }
    } else {
      cur += c;
    }
  }
  if (cur.length > 0) args.push(cur);
  return { name, args };
}

class Parser {
  private readonly toks: Tok[];
  private i = 0;

  constructor(source: string, _loopCap: number) {
    this.toks = tokenize(source);
  }

  parse(): Node[] {
    return this.parseUntil([]);
  }

  private parseUntil(endTags: string[]): Node[] {
    const nodes: Node[] = [];
    while (this.i < this.toks.length) {
      const tok = this.toks[this.i]!;
      if (tok.type === 'text') {
        nodes.push({ kind: 'text', value: tok.value });
        this.i++;
        continue;
      }
      if (tok.type === 'expr') {
        nodes.push({ kind: 'expr', value: parseExpr(tok.value) });
        this.i++;
        continue;
      }
      const tag = parseTag(tok.value);
      if (tag.name === 'endfor' || tag.name === 'endif') {
        if (!endTags.includes(tag.name)) {
          throw new TemplateLoadError(`unexpected '${tag.name}' — no open '${tag.name.slice(3)}' block`);
        }
        return nodes;
      }
      if (tag.name === 'else') {
        // `else` belongs to the enclosing block; stop here and let the caller
        // consume it. A stray top-level `else` is an error.
        if (endTags.length > 0) return nodes;
        throw new TemplateLoadError("unexpected 'else' outside a block");
      }
      if (tag.name === 'for') {
        this.i++;
        const variable = tag.args[0];
        if (!variable || tag.args.length !== 3 || tag.args[1] !== 'in') {
          throw new TemplateLoadError('malformed for tag: expected {% for x in seq %}');
        }
        const sequence = parseExpr(tag.args[2]!);
        const body = this.parseUntil(['endfor']);
        let elseBody: Node[] = [];
        let nxt = this.toks[this.i];
        if (nxt?.type === 'tag' && parseTag(nxt.value).name === 'else') {
          this.i++;
          elseBody = this.parseUntil(['endfor']);
          nxt = this.toks[this.i];
        }
        if (nxt?.type !== 'tag' || parseTag(nxt.value).name !== 'endfor') {
          throw new TemplateLoadError('unterminated for block');
        }
        this.i++;
        nodes.push({ kind: 'for', variable, sequence, body, elseBody });
        continue;
      }
      if (tag.name === 'if') {
        this.i++;
        const condition = parseExpr(tag.args.join(' '));
        const body = this.parseUntil(['endif']);
        let elseBody: Node[] = [];
        let nxt = this.toks[this.i];
        if (nxt?.type === 'tag' && parseTag(nxt.value).name === 'else') {
          this.i++;
          elseBody = this.parseUntil(['endif']);
          nxt = this.toks[this.i];
        }
        if (nxt?.type !== 'tag' || parseTag(nxt.value).name !== 'endif') {
          throw new TemplateLoadError('unterminated if block');
        }
        this.i++;
        nodes.push({ kind: 'if', condition, body, elseBody });
        continue;
      }
      if (tag.name === 'include') {
        this.i++;
        if (tag.args.length !== 1) {
          throw new TemplateLoadError('malformed include tag: expected {% include "name" %}');
        }
        nodes.push({ kind: 'include', name: tag.args[0]! });
        continue;
      }
      if (tag.name === 'set') {
        throw new TemplateLoadError('{% set %} is not supported by the restricted renderer');
      }
      throw new TemplateLoadError(`unsupported tag '${tag.name}'`);
    }
    if (endTags.length > 0) {
      throw new TemplateLoadError(`unterminated block: expected '${endTags[endTags.length - 1]}'`);
    }
    return nodes;
  }
}

// --- expression parsing ---------------------------------------------------

function parseExpr(src: string): Expr {
  const s = src.trim();
  if (s.length === 0) throw new TemplateLoadError('empty expression');
  const tokens = tokenizeExpr(s);
  const p = new ExprParser(tokens);
  const expr = p.parseComparison();
  if (p.pos < tokens.length) {
    throw new TemplateLoadError(`unexpected token '${tokens[p.pos]!}' in expression`);
  }
  return expr;
}

function tokenizeExpr(s: string): string[] {
  const toks: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '[' || c === ']' || c === ',') {
      toks.push(c);
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let cur = c;
      i++;
      let closed = false;
      while (i < n) {
        const ch = s[i]!;
        cur += ch;
        i++;
        if (ch === '\\') {
          if (i < n) {
            cur += s[i]!;
            i++;
          }
          continue;
        }
        if (ch === c) {
          closed = true;
          break;
        }
      }
      if (!closed) throw new TemplateLoadError(`unterminated string literal in expression: ${s}`);
      toks.push(cur);
      continue;
    }
    if (/[0-9]/.test(c)) {
      let cur = c;
      i++;
      while (i < n && /[0-9]/.test(s[i]!)) {
        cur += s[i]!;
        i++;
      }
      toks.push(cur);
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let cur = c;
      i++;
      while (i < n && /[a-zA-Z0-9_.]/.test(s[i]!)) {
        cur += s[i]!;
        i++;
      }
      toks.push(cur);
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '!=' || two === '==' || two === '>=' || two === '<=') {
      toks.push(two);
      i += 2;
      continue;
    }
    if (c === '|') {
      toks.push('|');
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      toks.push(c);
      i++;
      continue;
    }
    if (c === '>' || c === '<' || c === '!' || c === '=') {
      toks.push(c);
      i++;
      continue;
    }
    throw new TemplateLoadError(`unexpected character '${c}' in expression`);
  }
  return toks;
}

class ExprParser {
  pos = 0;
  constructor(private readonly toks: string[]) {}

  parseComparison(): Expr {
    let left = this.parsePrimary();
    // Postfix filters bind tighter than comparisons: `a.b | join(', ')`.
    for (;;) {
      const f = this.toks[this.pos];
      if (f === '|') {
        this.pos++;
        const nameTok = this.toks[this.pos];
        if (!nameTok || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(nameTok)) {
          throw new TemplateLoadError('expected filter name after "|"');
        }
        this.pos++;
        const args: Expr[] = [];
        if (this.toks[this.pos] === '(') {
          this.pos++;
          if (this.toks[this.pos] !== ')') {
            for (;;) {
              args.push(this.parseComparison());
              const nxt = this.toks[this.pos];
              if (nxt === ',') {
                this.pos++;
                continue;
              }
              break;
            }
          }
          if (this.toks[this.pos] !== ')') {
            throw new TemplateLoadError('unterminated filter argument list');
          }
          this.pos++;
        }
        left = { kind: 'filter', name: nameTok, args, base: left };
        continue;
      }
      break;
    }
    for (;;) {
      const t = this.toks[this.pos];
      if (t === 'in') {
        this.pos++;
        const right = this.parsePrimary();
        left = { kind: 'in', left, right };
        continue;
      }
      if (t === '==' || t === '!=' || t === '>' || t === '<' || t === '>=' || t === '<=') {
        this.pos++;
        const right = this.parsePrimary();
        left = { kind: 'compare', op: t, left, right };
        continue;
      }
      break;
    }
    return left;
  }

  private parsePrimary(): Expr {
    const t = this.toks[this.pos];
    if (t === undefined) throw new TemplateLoadError('unexpected end of expression');
    if (t === '[') {
      this.pos++;
      const items: Expr[] = [];
      if (this.toks[this.pos] === ']') {
        this.pos++;
        return { kind: 'arr', items };
      }
      for (;;) {
        items.push(this.parseComparison());
        const nxt = this.toks[this.pos];
        if (nxt === ',') {
          this.pos++;
          continue;
        }
        if (nxt === ']') {
          this.pos++;
          return { kind: 'arr', items };
        }
        throw new TemplateLoadError('malformed array literal');
      }
    }
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      this.pos++;
      const inner = t.slice(1, -1);
      return { kind: 'lit', value: inner.replace(/\\(.)/g, '$1') };
    }
    if (/^\d+$/.test(t)) {
      this.pos++;
      return { kind: 'lit', value: Number(t) };
    }
    if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(t)) {
      this.pos++;
      if (t === 'true') return { kind: 'lit', value: true };
      if (t === 'false') return { kind: 'lit', value: false };
      return { kind: 'path', name: t };
    }
    throw new TemplateLoadError(`unexpected token '${t}' in expression`);
  }
}
