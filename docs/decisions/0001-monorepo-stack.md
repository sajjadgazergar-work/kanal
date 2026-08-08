# 0001 — Monorepo stack and package layout

- Status: accepted
- Deciders: maintainers
- Date: 2026-08-08

## Context

The plan (§18.2) specifies the stack: TypeScript 5.6 / Node 22, pnpm 9
workspaces + Turborepo, Fastify 5, Postgres 16 + pgvector, Drizzle, Redis 7,
Vercel AI SDK, Zod 3, Next.js 15, Vitest + Testcontainers. The monorepo layout
is fixed in §18.1. This record pins the implementation choices that the plan
leaves open.

## Decision

1. **Strict ESM everywhere** — every package is `"type": "module"` with
   `moduleResolution: NodeNext`; imports carry `.js` extensions. This matches
   Node 22 native ESM and avoids a CJS/ESM split across packages.
2. **`strict` TypeScript with `noUncheckedIndexedAccess`** at the base config;
   `noEmitOnError` so a failed typecheck cannot ship a stale `dist`.
3. **`@kanal/*` scoped workspace packages**; `packages/adapters/*` are nested
   workspace packages (the plan's `packages/adapters/core` + per-platform
   layout) — `pnpm-workspace.yaml` globs `packages/adapters/*`.
4. **Lint is flat-config ESLint 9** (root `eslint.config.js`, `@eslint/js` +
   `typescript-eslint`, non-type-checked). Type checking is the `typecheck`
   task's job; lint enforces hygiene. All `lint` scripts are `eslint src`.
5. **AGPL at the root; Apache-2.0 carve-out** for `packages/contracts` and
   `packages/adapters/core` (plan §19.1).
6. **DCO, no CLA** — commits must carry `Signed-off-by`.

## Consequences

- New packages follow the same `package.json` / `tsconfig.json` shape; the
  build is cacheable by Turborepo.
- `moduleResolution: NodeNext` + `.js` extensions is slightly more
  verbose than bundler resolution but keeps every runtime (node, vitest,
  tsx) on one resolution mode.
- The `noUncheckedIndexedAccess` strictness surfaced real bugs early
  (e.g. `rows[0]` access in the runtime, `parts[0]` in the IP parser) at
  the cost of occasional non-null assertions at known-safe boundaries.
- Non-type-checked lint is a deliberate trade: per-package
  `parserOptions.project` would slow CI for marginal value since
  `tsc --noEmit` already gates types.
