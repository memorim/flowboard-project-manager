import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const unused = { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' };
export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-*/**',
      'data/**',
      'docs/**',
      'hosting/**',
      '.upgrade-test-*/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  {
    ...js.configs.recommended,
    files: ['**/*.{js,mjs}'],
    rules: { ...js.configs.recommended.rules, 'no-unused-vars': ['error', unused] },
  },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ['**/*.{ts,tsx}'] })),
  { files: ['**/*.{ts,tsx}'], rules: { '@typescript-eslint/no-unused-vars': ['error', unused] } },
  { files: ['**/*.{js,mjs,ts,tsx}'], languageOptions: { globals: globals.node } },
  {
    files: [
      'src/**/*.{ts,tsx}',
      'public/**/*.js',
      'tests/browser/**/*.mjs',
      'tests/e2e/**/*.mjs',
      'tests/zoom-extension/*.js',
    ],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
  },
];
