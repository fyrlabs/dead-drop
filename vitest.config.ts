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
      '@fyrlabs/dead-drop-protocol': resolvePackage('protocol'),
      '@fyrlabs/dead-drop-transport-sdk/testing': fileURLToPath(
        new URL('./packages/transport-sdk/src/testing/index.ts', import.meta.url),
      ),
      '@fyrlabs/dead-drop-transport-sdk': resolvePackage('transport-sdk'),
      '@fyrlabs/dead-drop-core': resolvePackage('core'),
      '@fyrlabs/dead-drop-runtime': resolvePackage('runtime'),
      '@fyrlabs/dead-drop-sdk': resolvePackage('sdk'),
      '@fyrlabs/dead-drop': resolvePackage('cli'),
      '@fyrlabs/dead-drop-transport-memory': resolvePackage('transports/memory'),
      '@fyrlabs/dead-drop-transport-filesystem': resolvePackage('transports/filesystem'),
      '@fyrlabs/dead-drop-transport-git': resolvePackage('transports/git'),
      '@fyrlabs/dead-drop-transport-github': resolvePackage('transports/github'),
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
