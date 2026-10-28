import assert from 'node:assert/strict';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const common = /^third-party\/shadcn-ui\.txt$/u;
const extensionFile =
  /^(?:manifest\.json|sidepanel\.html|background\.js|chunks\/[\w-]+\.js|assets\/[\w-]+\.css)$/u;
const demoFile = /^(?:index\.html|assets\/[\w-]+\.(?:js|css))$/u;

export function allowedBuildPath(kind, path) {
  return (
    typeof path === 'string' &&
    (common.test(path) || (kind === 'extension' ? extensionFile : demoFile).test(path))
  );
}

export async function readBuild(directory, kind) {
  const files = new Map();

  async function visit(relative = '') {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });

    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const info = await lstat(join(directory, path));
      assert.equal(info.isSymbolicLink(), false, 'Build output must not contain symlinks.');

      if (entry.isDirectory()) {
        assert.ok(
          ['assets', 'chunks', 'third-party'].includes(path),
          'Unexpected output directory.',
        );
        await visit(path);
        continue;
      }

      assert.ok(info.isFile() && allowedBuildPath(kind, path), 'Unexpected output file.');
      assert.ok(info.size > 0 && info.size <= 2_000_000, 'Invalid output file size.');
      files.set(path, await readFile(join(directory, path)));
      assert.ok(files.size <= 30, 'Too many build assets.');
    }
  }

  assert.ok((await lstat(directory)).isDirectory(), 'Missing output directory.');
  await visit();
  assert.ok(files.has('third-party/shadcn-ui.txt'), 'Missing bundled license.');

  return files;
}

export function verifyManifest(manifest, files) {
  const keys = [
    'manifest_version',
    'name',
    'description',
    'version',
    'minimum_chrome_version',
    'permissions',
    'optional_permissions',
    'optional_host_permissions',
    'action',
    'incognito',
    'background',
    'side_panel',
  ];
  assert.deepEqual(Object.keys(manifest).sort(), keys.sort(), 'Unexpected manifest capability.');
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'ThreadShelf');
  assert.match(manifest.version, /^\d+(?:\.\d+){0,3}$/u);
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.deepEqual(manifest.permissions, ['sidePanel']);
  assert.deepEqual(manifest.optional_permissions, ['scripting']);
  assert.deepEqual(manifest.optional_host_permissions, [
    'https://chatgpt.com/*',
    'https://www.google.com/*',
  ]);
  assert.equal(manifest.incognito, 'not_allowed');
  assert.deepEqual(manifest.background, { service_worker: 'background.js' });
  assert.deepEqual(manifest.side_panel, { default_path: 'sidepanel.html' });
  assert.deepEqual(manifest.action, { default_title: 'Open ThreadShelf' });
  assert.ok(
    files.has('background.js') && files.has('sidepanel.html'),
    'Missing extension entrypoint.',
  );
}

export function verifyHtml(html, files, base = '/') {
  assert.ok(!/<script\b[^>]*>\s*[^<\s]/iu.test(html), 'Inline script in production HTML.');
  const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/gu)].map((match) => match[1]);
  assert.ok(references.length >= 2, 'Missing production script/style references.');

  for (const reference of references) {
    assert.ok(reference.startsWith(base), 'Asset reference must use the configured local base.');
    const path = reference.slice(base.length);
    assert.ok(files.has(path), 'HTML references an absent or nonlocal asset.');
  }
}

export async function verifyBuilds() {
  const extension = await readBuild(resolve('.output/chrome-mv3'), 'extension');
  const demo = await readBuild(resolve('dist/demo'), 'demo');
  verifyManifest(JSON.parse(extension.get('manifest.json')?.toString() ?? 'null'), extension);
  verifyHtml(extension.get('sidepanel.html')?.toString() ?? '', extension);
  verifyHtml(demo.get('index.html')?.toString() ?? '', demo, process.env.DEMO_BASE ?? '/');
  process.stdout.write(
    `Verified ${extension.size} extension assets and ${demo.size} demo assets; exact manifest permissions and local HTML references.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await verifyBuilds();
