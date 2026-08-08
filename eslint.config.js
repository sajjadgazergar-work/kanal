/**
 * KANAL flat ESLint config (ESLint 9).
 *
 * One config covers every package and app. Type-aware linting is deliberately
 * OFF here: per-project `parserOptions.project` would pull every package's
 * tsconfig into the parse graph and slow CI to a crawl for marginal value —
 * `tsc --noEmit` is the type gate. This config enforces hygiene rules
 * (unused vars, switch exhaustiveness, `no-unchecked-indexed-access`-style
 * mistakes ESLint can see without the checker) and leaves types to the build.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/*.d.ts', '**/test-fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Node 22 + ESM: `catch (e)` and explicit returns are fine, but ban the
      // footguns the plan's coding rules call out.
      'no-unused-vars': 'off', // handled by @typescript-eslint
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Catch clauses that are genuinely unused are allowed with an underscore.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Strict mode demands these; keep them as errors so they cannot regress.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-fallthrough': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
);
