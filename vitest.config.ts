import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string): string => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

/**
 * Tests run against TypeScript sources, not `dist`, so a failing build never
 * masks a failing test and vice versa. `npm run verify` runs both.
 *
 * The aliases mirror the published `exports` map. Root tests and examples
 * import the package the way a consumer does, so a subpath that is exported
 * but not wired here fails the same way it would for a user.
 *
 * Each package keeps its tests in a `test` tree mirroring `src`, and they reach
 * their subject by relative path. Coverage is measured over `src` alone, so
 * test files and the shared doubles in `test/core/testing.ts` fall outside it
 * by location rather than by an exclude rule.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Tests address their subject from the package root, never by walking up
      // out of `test/`. `#dead-drop/core/mailbox.js` says what it reaches for;
      // `../../src/core/mailbox.js` only says how far away it is, and it has to
      // be recounted every time a file moves.
      '#dead-drop': src('dead-drop/src'),
      '#transport-sdk': src('transport-sdk/src'),
      '@fyrlabs/dead-drop-transport-sdk/testing': src('transport-sdk/src/testing/index.ts'),
      '@fyrlabs/dead-drop-transport-sdk': src('transport-sdk/src/index.ts'),
      '@fyrlabs/dead-drop/transports/filesystem': src(
        'dead-drop/src/transports/filesystem/index.ts',
      ),
      '@fyrlabs/dead-drop/transports/memory': src('dead-drop/src/transports/memory/index.ts'),
      '@fyrlabs/dead-drop/transports/github': src('dead-drop/src/transports/github/index.ts'),
      '@fyrlabs/dead-drop/transports/git': src('dead-drop/src/transports/git/index.ts'),
      '@fyrlabs/dead-drop/cli': src('dead-drop/src/cli/index.ts'),
      '@fyrlabs/dead-drop/protocol': src('dead-drop/src/protocol/index.ts'),
      '@fyrlabs/dead-drop/runtime': src('dead-drop/src/runtime/index.ts'),
      '@fyrlabs/dead-drop/core': src('dead-drop/src/core/index.ts'),
      '@fyrlabs/dead-drop/sdk': src('dead-drop/src/sdk/index.ts'),
      '@fyrlabs/dead-drop': src('dead-drop/src/index.ts'),
    },
  },
  test: {
    // Deliberately wider than the layout: tests live in `packages/*/test/` and
    // the root `test/`, but a stray `.test.ts` anywhere under `packages/` still
    // runs. A file that stops matching this glob vanishes from the run with no
    // failure, so the glob errs towards collecting too much rather than too
    // little. Check the test count, not just a green suite, after moving files.
    include: ['packages/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['packages/**/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/types.ts',
        'packages/dead-drop/src/cli/bin.ts',
        'packages/**/testing/**',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
