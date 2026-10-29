import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { archivePath, verifyArchive } from './verify-artifacts.mjs';

// Clean only this generated production output and the archive this command owns.
await rm(resolve('.output/chrome-mv3'), { recursive: true, force: true });
await rm(archivePath, { force: true });
const result = spawnSync(
  process.execPath,
  [resolve('node_modules/wxt/bin/wxt.mjs'), 'zip', '-b', 'chrome', '--level', 'info'],
  { stdio: 'inherit' },
);
assert.equal(result.status, 0, 'Chrome packaging failed.');
await verifyArchive();
process.stdout.write(
  `Local archive: ${archivePath}\nExtract it before using Chrome’s Load unpacked.\n`,
);
