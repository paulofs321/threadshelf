import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const files = [
  'README.md',
  ...(await readdir('docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`),
];
let count = 0;

for (const file of files) {
  const text = await readFile(file, 'utf8');

  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
    const target = match[1];

    if (/^(?:https?:|mailto:|#)/u.test(target)) continue;

    const path = resolve(dirname(file), decodeURIComponent(target.split('#')[0]));
    const name = relative(process.cwd(), path);
    assert.ok(
      !name.startsWith('..') &&
        !/(?:^|\/)(?:\.ai|\.agents|\.codex|\.claude|AGENTS\.md)(?:\/|$)/u.test(name),
      'Public docs reference private/local-only material.',
    );
    await access(path);
    count++;
  }
}

process.stdout.write(
  `Verified ${count} local links across ${files.length} public Markdown documents.\n`,
);
