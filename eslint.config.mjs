import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.codegraph/**',
      'design-previews/**',
      'coverage/**',
      'node_modules/**',
      'out/**',
      'playwright-report/**',
      'release/**',
      'build-resources/generated/**',
      'test-results/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    files: ['**/*.cjs'],
    languageOptions: { globals: { require: 'readonly', module: 'readonly', process: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'electron',
                'node:*',
                '@aws-sdk/*',
                'better-sqlite3',
                'ssh2',
                '@main/*',
                '@preload/*',
              ],
              message: 'Renderer may only use the typed preload API and shared contracts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/main/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@renderer/*', '@preload/*'],
              message: 'Main process must not depend on renderer or preload implementation.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aws-sdk/*', 'better-sqlite3', 'ssh2', '@renderer/*', '@main/*'],
              message: 'Preload may only depend on Electron and shared contracts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'node:*', '@aws-sdk/*', 'better-sqlite3', 'ssh2'],
              message: 'Shared contracts must remain process-neutral.',
            },
          ],
        },
      ],
    },
  },
);
