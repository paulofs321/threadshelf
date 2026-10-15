import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    globals: false,
    passWithNoTests: false,
    allowOnly: false,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      reporter: ['text', 'html', 'json', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 98,
        branches: 97,
        'src/contracts/**/*.ts': { lines: 100, functions: 100, statements: 100, branches: 100 },
      },
    },
  },
  oxc: { jsx: { runtime: 'automatic' } },
});
