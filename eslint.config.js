import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      '**/*.d.ts',
      // Vendored, minified and not ours to lint.
      'packages/dead-drop/static/lume.min.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: 'Import from node:timers/promises or use a Clock.' },
      ],
    },
  },
  {
    // Tests may reach for the loose escape hatches the runtime code may not.
    // Everything under a `test/` directory counts, not only `*.test.ts`, so the
    // shared doubles in `packages/dead-drop/test/core/testing.ts` get the same
    // latitude as the suites they exist for.
    files: ['**/test/**/*.ts', '**/*.test.ts', '**/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
      'no-restricted-globals': 'off',
    },
  },
  {
    files: ['packages/dead-drop/src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Layering used to be enforced by package boundaries: protocol could not
    // import core because it was not a dependency. Now that everything ships in
    // one package, only this rule stops the direction of dependency inverting.
    // The order is protocol <- core <- runtime <- {sdk, cli}; transports sit on
    // protocol and the transport SDK. See AGENTS.md.
    //
    // Every layering rule below scopes itself to `src/`, which is what exempts
    // the tests: they live in `packages/*/test/` and reach across layers freely.
    files: ['packages/dead-drop/src/protocol/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/core/**', '**/runtime/**', '**/sdk/**', '**/cli/**', '**/transports/**'],
              message:
                'protocol is the bottom layer: it must not import from core, runtime, sdk, cli or a transport.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/dead-drop/src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/runtime/**', '**/sdk/**', '**/cli/**', '**/transports/**'],
              message:
                'core is policy, not product: it must not import from runtime, sdk, cli or a transport. Naming a transport here breaks transport independence.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/dead-drop/src/runtime/**/*.ts'],
    ignores: ['packages/dead-drop/src/runtime/plugins.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/sdk/**', '**/cli/**', '**/transports/**'],
              message:
                'runtime must not import from sdk, cli or a transport. plugins.ts is the single exception: it owns the built-in transport table.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/dead-drop/src/transports/**/*.ts'],
    ignores: ['packages/dead-drop/src/transports/github/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/core/**', '**/runtime/**', '**/sdk/**', '**/cli/**', '**/transports/**'],
              message:
                'a transport sees only the protocol and the transport SDK, exactly as a third-party adapter does. The github transport is the one exception: it delegates to the git transport.',
            },
          ],
        },
      ],
    },
  },
  {
    // The dashboard page. Browser code, so the Node-oriented rules below do not
    // describe it: `document` and `fetch` are ambient rather than undefined, and
    // there is no injected Clock in a browser to prefer over a timer.
    files: ['packages/dead-drop/static/**/*.js'],
    languageOptions: { sourceType: 'module', ecmaVersion: 2023 },
    rules: {
      'no-undef': 'off',
      'no-restricted-globals': 'off',
    },
  },
  {
    // Examples are plain Node scripts meant to be read and run, not linted for
    // library discipline: printing to the console is their entire purpose.
    files: ['examples/**/*.js'],
    languageOptions: { sourceType: 'module', ecmaVersion: 2023 },
    rules: {
      'no-undef': 'off',
      'no-console': 'off',
      'no-restricted-globals': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
