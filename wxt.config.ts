import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

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
  'demo/**',
  'tests/**',
  '**/*.png',
  '**/*.webm',
  '**/*.heapsnapshot',
];

export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'ThreadShelf',
    description:
      'Search saved ChatGPT and Google Search AI Mode conversations in your selected account.',
    minimum_chrome_version: '116',
    permissions: ['sidePanel'],
    optional_permissions: ['scripting'],
    optional_host_permissions: ['https://chatgpt.com/*', 'https://www.google.com/*'],
    action: { default_title: 'Open ThreadShelf' },
    incognito: 'not_allowed',
  },
  vite: () => ({ plugins: [tailwindcss()], build: { sourcemap: false } }),
  zip: {
    zipSources: false,
    artifactTemplate: 'threadshelf-{{version}}-chrome.zip',
    exclude: privateFiles,
    excludeSources: privateFiles,
  },
});
