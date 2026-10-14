import { defineConfig } from 'wxt';

const privateFiles = [
  '.ai/**',
  '.agents/**',
  '.codex/**',
  '.claude/**',
  '**/AGENTS.md',
  '**/.env*',
  '**/*.har',
  '**/*.log',
  '**/*.map',
];

export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'ThreadShelf',
    description: 'ThreadShelf setup baseline. Conversation search is not implemented yet.',
    minimum_chrome_version: '114',
    permissions: ['sidePanel'],
  },
  vite: () => ({ build: { sourcemap: false } }),
  zip: {
    zipSources: false,
    exclude: privateFiles,
    excludeSources: privateFiles,
    includeSources: [
      'src/**',
      'public/**',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'wxt.config.ts',
      'README.md',
      'docs/**',
    ],
  },
});
