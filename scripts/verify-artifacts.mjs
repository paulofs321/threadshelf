import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { allowedBuildPath, readBuild, verifyHtml, verifyManifest } from './verify-builds.mjs';

const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
export const archivePath = resolve(`.output/threadshelf-${metadata.version}-chrome.zip`);

export function verifyArtifactContent(files) {
  for (const bytes of files.values()) {
    const text = bytes.toString();
    assert.ok(
      !/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/u.test(text),
      'Private key material in output.',
    );
    assert.ok(
      !/\bsk-(?:proj|live)-[A-Za-z0-9_-]{20,}/u.test(text),
      'Private service key in output.',
    );
    assert.ok(
      !text.includes('BEGIN:global-development-skills') &&
        !text.includes('# ThreadShelf repository instructions'),
      'Local agent content in output.',
    );
    assert.ok(
      !text.includes('Floating library login security') && !text.includes('synthetic-panel-driver'),
      'Demo or test content in extension output.',
    );
  }
}

/** Inspect the simple single-disk ZIP format produced by the locked WXT writer.
 * PKWARE APPNOTE 4.3.12/4.3.16; reject alternate extraction metadata before decompression.
 */
function verifyArchiveHeaders(input) {
  const bytes = Buffer.from(input);
  const end = bytes.length - 22;
  assert.ok(end >= 0 && bytes.readUInt32LE(end) === 0x06054b50, 'Invalid ZIP end record.');
  assert.ok(
    bytes.readUInt16LE(end + 4) === 0 &&
      bytes.readUInt16LE(end + 6) === 0 &&
      bytes.readUInt16LE(end + 20) === 0,
    'Unsupported ZIP disks or comment.',
  );
  const count = bytes.readUInt16LE(end + 10);
  assert.ok(
    count > 0 && count <= 30 && bytes.readUInt16LE(end + 8) === count,
    'Invalid ZIP entry count.',
  );
  const start = bytes.readUInt32LE(end + 16);
  assert.equal(start + bytes.readUInt32LE(end + 12), end, 'Invalid central directory bounds.');
  let position = start;
  let localEnd = 0;

  for (let n = 0; n < count; n++) {
    assert.ok(
      position + 46 <= end && bytes.readUInt32LE(position) === 0x02014b50,
      'Invalid central entry.',
    );
    const mode = bytes.readUInt32LE(position + 38);
    assert.ok(
      [0, 0x8000].includes((mode >>> 16) & 0xf000) && (mode & 0x10) === 0,
      'ZIP entries must be regular files.',
    );
    const flags = bytes.readUInt16LE(position + 8);
    assert.ok((flags & ~0x0800) === 0, 'Unsupported encryption or streamed ZIP entry.');
    const nameLength = bytes.readUInt16LE(position + 28);
    const extraLength = bytes.readUInt16LE(position + 30);
    const commentLength = bytes.readUInt16LE(position + 32);
    const next = position + 46 + nameLength + extraLength + commentLength;
    assert.ok(
      next <= end &&
        extraLength === 0 &&
        commentLength === 0 &&
        bytes.readUInt16LE(position + 34) === 0,
      'Unexpected ZIP entry metadata.',
    );
    const local = bytes.readUInt32LE(position + 42);
    assert.ok(
      local === localEnd && local + 30 <= start && bytes.readUInt32LE(local) === 0x04034b50,
      'Invalid local entry.',
    );
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    assert.ok(
      localNameLength === nameLength &&
        localExtraLength === 0 &&
        bytes
          .subarray(local + 30, local + 30 + localNameLength)
          .equals(bytes.subarray(position + 46, position + 46 + nameLength)),
      'ZIP local and central entry names must agree.',
    );
    assert.ok(
      bytes.readUInt16LE(local + 6) === flags &&
        bytes.readUInt16LE(local + 8) === bytes.readUInt16LE(position + 10) &&
        bytes.readUInt32LE(local + 14) === bytes.readUInt32LE(position + 16) &&
        bytes.readUInt32LE(local + 18) === bytes.readUInt32LE(position + 20) &&
        bytes.readUInt32LE(local + 22) === bytes.readUInt32LE(position + 24),
      'ZIP entry metadata disagrees.',
    );
    localEnd = local + 30 + localNameLength + bytes.readUInt32LE(position + 20);
    assert.ok(localEnd <= start, 'ZIP data exceeds its bounds.');
    position = next;
  }

  assert.ok(position === end && localEnd === start, 'Unexpected unlisted ZIP data.');
}

/** Bounded ZIP inspection, then exact equality with the allowlisted production build. No extraction. */
export function inspectArchive(bytes, expected) {
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= 5_000_000, 'Invalid archive size.');
  verifyArchiveHeaders(bytes);
  const seen = new Set();
  let total = 0;
  const entries = unzipSync(bytes, {
    filter(file) {
      assert.ok(allowedBuildPath('extension', file.name), 'Unapproved archive entry.');
      assert.ok(!seen.has(file.name), 'Duplicate archive entry.');
      seen.add(file.name);
      total += file.originalSize;
      assert.ok(
        file.originalSize > 0 &&
          file.originalSize <= 2_000_000 &&
          total <= 5_000_000 &&
          seen.size <= 30,
        'Archive expands beyond its budget.',
      );

      return true;
    },
  });
  const files = new Map(Object.entries(entries).map(([path, data]) => [path, Buffer.from(data)]));
  assert.deepEqual(
    [...files.keys()].sort(),
    [...expected.keys()].sort(),
    'ZIP must contain exactly the production extension files.',
  );

  for (const [path, content] of files)
    assert.ok(content.equals(expected.get(path)), 'ZIP bytes differ from the inspected build.');

  verifyManifest(JSON.parse(files.get('manifest.json')?.toString() ?? 'null'), files);
  verifyHtml(files.get('sidepanel.html')?.toString() ?? '', files);
  verifyArtifactContent(files);

  return files;
}

export async function verifyArchive(path = archivePath) {
  const info = await lstat(path);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size <= 5_000_000,
    'Invalid archive file.',
  );
  const expected = await readBuild(resolve('.output/chrome-mv3'), 'extension');
  const bytes = await readFile(path);
  const files = inspectArchive(bytes, expected);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  process.stdout.write(
    `Verified ${files.size} ZIP entries (${bytes.byteLength} bytes), manifest at root, no source/demo/test/private assets. SHA-256 ${sha256}\n`,
  );

  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await verifyArchive();
