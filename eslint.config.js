import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import babelParser from '@babel/eslint-parser';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores([
    '.ai/**',
    '.agents/**',
    '.codex/**',
    '.claude/**',
    '**/AGENTS.md',
    'node_modules/**',
    '.wxt/**',
    '.output/**',
    'dist/**',
    'coverage/**',
    '.vitest/**',
  ]),
  { files: ['**/*.js'], extends: [js.configs.recommended] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          plugins: [['@babel/plugin-syntax-typescript', { isTSX: true }]],
        },
      },
    },
    rules: {
      // Babel supplies syntax linting without a legacy TypeScript compiler dependency.
      // Strict tsc owns name resolution and unused declarations, including types and JSX.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-restricted-syntax': [
        'error',
        { selector: 'TSAnyKeyword', message: 'Use unknown and validate boundary data.' },
        { selector: 'TSNonNullExpression', message: 'Check missing values explicitly.' },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'],
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'never', prev: 'import', next: 'import' },
        { blankLine: 'always', prev: '*', next: 'block-like' },
        { blankLine: 'always', prev: 'block-like', next: '*' },
        { blankLine: 'always', prev: '*', next: ['if', 'switch', 'for', 'while', 'do', 'try'] },
        { blankLine: 'always', prev: ['if', 'switch', 'for', 'while', 'do', 'try'], next: '*' },
        { blankLine: 'always', prev: '*', next: 'return' },
      ],
    },
  },
  {
    files: ['src/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['wxt', 'wxt/*', 'chrome', 'webextension-polyfill', '@wxt-dev/*'],
              message: 'Contracts must remain browser-independent.',
            },
            {
              group: ['**/platform/**', '**/providers/**', '**/entrypoints/**'],
              message:
                'Inject normalized ports; keep browser and transport code outside contracts.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'chrome', 'browser', 'window', 'document', 'fetch'],
    },
  },
]);
