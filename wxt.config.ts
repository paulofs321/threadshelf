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
    description: 'Select site access for ThreadShelf. Conversation search is not implemented yet.',
    minimum_chrome_version: '116',
    permissions: ['sidePanel'],
    optional_permissions: ['scripting'],
    optional_host_permissions: ['https://chatgpt.com/*', 'https://www.google.com/*'],
    action: { default_title: 'Open ThreadShelf' },
    incognito: 'not_allowed',
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
