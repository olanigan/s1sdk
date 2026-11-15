import { defineConfig } from 'vitest/config';

/**
 * Coverage is scoped to `src/` — the library that `dist/` and the `exports`
 * map publish and that consumers actually depend on. Developer tooling
 * (`scripts/devx.ts`, `examples/`) is exercised manually via `just doctor`,
 * `just smoke` and `just examples`, and is not part of the release gate.
 *
 * Thresholds are a floor just below the current measurement so that organic
 * additions pass and deleting tests for a module fails. Raise them when the
 * suite grows; never lower them to make a red gate green.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        statements: 85,
        branches: 78,
        functions: 85,
        lines: 85
      }
    }
  }
});
