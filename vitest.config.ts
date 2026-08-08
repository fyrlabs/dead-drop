import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolvePackage = (path: string): string =>
  fileURLToPath(new URL(`./packages/${path}/src/index.ts`, import.meta.url));

/**
 * Tests run against TypeScript sources, not `dist`, so a failing build never
 * masks a failing test and vice versa. `npm run verify` runs both.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@dead-drop/protocol': resolvePackage('protocol'),
      '@dead-drop/transport-sdk/testing': fileURLToPath(
        new URL('./packages/transport-sdk/src/testing/index.ts', import.meta.url),
      ),
      '@dead-drop/transport-sdk': resolvePackage('transport-sdk'),
      '@dead-drop/core': resolvePackage('core'),
      '@dead-drop/runtime': resolvePackage('runtime'),
      '@dead-drop/sdk': resolvePackage('sdk'),
      '@dead-drop/cli': resolvePackage('cli'),
      '@dead-drop/transport-memory': resolvePackage('transports/memory'),
      '@dead-drop/transport-filesystem': resolvePackage('transports/filesystem'),
      '@dead-drop/transport-git': resolvePackage('transports/git'),
      '@dead-drop/transport-github': resolvePackage('transports/github'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
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
        'packages/cli/src/bin.ts',
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
