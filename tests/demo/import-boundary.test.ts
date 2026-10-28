import { expect, it } from 'vitest';
import { build } from 'vite';
import config from '../../vite.demo.config';

it.each(['static', 'dynamic'])(
  'fails the actual demo build for a transitive %s capability import',
  async (kind) => {
    const entry = '\0demo-boundary-entry';
    const capability = '/synthetic/src/platform/forbidden.ts';
    await expect(
      build({
        ...config,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          ...(config.plugins ?? []),
          {
            name: 'synthetic-boundary-probe',
            resolveId(id) {
              if (id === entry || id === capability) return id;
            },
            load(id) {
              if (id === entry)
                return kind === 'static' ? `import '${capability}';` : `import('${capability}');`;

              if (id === capability) return 'globalThis.syntheticBoundaryProbe = true;';
            },
          },
        ],
        build: { write: false, rolldownOptions: { input: entry } },
      }),
    ).rejects.toThrow('The static demo imported a privileged or local-only module.');
  },
);
