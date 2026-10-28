import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const base = process.env.DEMO_BASE ?? '/';

if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/u.test(base))
  throw new Error('DEMO_BASE must be a local root or directory path with a trailing slash.');

export function forbiddenDemoModule(id: string): boolean {
  const path = id.replaceAll('\\', '/');

  return (
    /\/node_modules\/(?:wxt|@wxt-dev|webextension-polyfill)(?:\/|$)/u.test(path) ||
    /\/src\/(?:platform|providers|entrypoints|storage)\//u.test(path) ||
    /\/src\/description\/on-device\/(?:model|prompts)\./u.test(path) ||
    /\/(?:\.ai|\.agents|\.codex|\.claude)\//u.test(path) ||
    /\/AGENTS\.md(?:$|\?)/u.test(path)
  );
}

export default defineConfig({
  root: fileURLToPath(new URL('./demo', import.meta.url)),
  base,
  publicDir: false,
  plugins: [
    tailwindcss(),
    {
      name: 'demo-capability-boundary',
      generateBundle() {
        for (const id of this.getModuleIds()) {
          if (forbiddenDemoModule(id))
            this.error('The static demo imported a privileged or local-only module.');
        }

        this.emitFile({
          type: 'asset',
          fileName: 'third-party/shadcn-ui.txt',
          source: readFileSync(
            new URL('./public/third-party/shadcn-ui.txt', import.meta.url),
            'utf8',
          ),
        });
      },
    },
  ],
  oxc: { jsx: { runtime: 'automatic' } },
  build: { outDir: '../dist/demo', emptyOutDir: true, sourcemap: false },
});
