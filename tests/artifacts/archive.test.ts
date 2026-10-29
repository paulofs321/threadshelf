import { beforeAll, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { inspectArchive, verifyArtifactContent } from '../../scripts/verify-artifacts.mjs';

const encode = (text: string) => Buffer.from(text);
const expected = new Map<string, Buffer>([
  [
    'manifest.json',
    encode(
      JSON.stringify({
        manifest_version: 3,
        name: 'ThreadShelf',
        description: 'Fictional packaging fixture',
        version: '0.0.0',
        minimum_chrome_version: '116',
        permissions: ['sidePanel'],
        optional_permissions: ['scripting'],
        optional_host_permissions: ['https://chatgpt.com/*', 'https://www.google.com/*'],
        action: { default_title: 'Open ThreadShelf' },
        incognito: 'not_allowed',
        background: { service_worker: 'background.js' },
        side_panel: { default_path: 'sidepanel.html' },
      }),
    ),
  ],
  ['background.js', encode('/* fictional background */')],
  [
    'sidepanel.html',
    encode('<script src="/chunks/panel-abc.js"></script><link href="/assets/panel-abc.css">'),
  ],
  ['chunks/panel-abc.js', encode('/* fictional panel */')],
  ['assets/panel-abc.css', encode('body { color: black; }')],
  ['third-party/shadcn-ui.txt', encode('Fictional license fixture')],
]);
const contents = () => Object.fromEntries(expected);

describe('bounded production ZIP verification', () => {
  beforeAll(() => {
    expect(expected.size).toBe(6);
  });

  it('accepts a root-manifest archive whose bytes exactly equal the inspected build', () => {
    expect([...inspectArchive(zipSync(contents()), expected).keys()].sort()).toEqual(
      [...expected.keys()].sort(),
    );
  });

  it.each([
    '.ai/plan.md',
    '.agents/skill.md',
    '.codex/config.json',
    '.claude/private.txt',
    'AGENTS.md',
    '.env',
    'private.log',
    'capture.har',
    'capture.png',
    'assets/main.js.map',
    'demo/index.html',
    'tests/fixture.json',
    '../manifest.json',
    '/manifest.json',
    'source/src/app.ts',
    'nested/manifest.json',
  ])('rejects forbidden entry %s even alongside valid production assets', (name) => {
    expect(() =>
      inspectArchive(zipSync({ ...contents(), [name]: strToU8('fiction') }), expected),
    ).toThrow();
  });

  it('rejects a tampered bundled file and missing entry', () => {
    expect(() =>
      inspectArchive(zipSync({ ...contents(), 'background.js': strToU8('changed') }), expected),
    ).toThrow('ZIP bytes differ');
    const missing = contents();
    delete missing['manifest.json'];
    expect(() => inspectArchive(zipSync(missing), expected)).toThrow(
      'exactly the production extension files',
    );
  });

  it('rejects oversized expansion before accepting a compressed asset', () => {
    expect(() =>
      inspectArchive(
        zipSync({ ...contents(), 'chunks/large.js': new Uint8Array(2_000_001) }),
        expected,
      ),
    ).toThrow('budget');
  });

  it('rejects malformed archives', () => {
    expect(() => inspectArchive(strToU8('not a ZIP'), expected)).toThrow();
    expect(() => inspectArchive(new Uint8Array(), expected)).toThrow('archive size');
  });

  it('rejects symlink metadata even when the archived bytes match the build', () => {
    const bytes = Buffer.from(zipSync(contents()));
    const central = bytes.readUInt32LE(bytes.length - 6);
    bytes.writeUInt32LE(0xa000 * 65536, central + 38);
    expect(() => inspectArchive(bytes, expected)).toThrow('regular files');
  });

  it('rejects different local and central entry names before OS extraction', () => {
    const bytes = Buffer.from(zipSync(contents()));
    bytes[30] = 'x'.charCodeAt(0);
    expect(() => inspectArchive(bytes, expected)).toThrow('entry names');
  });

  it.each([
    '-----BEGIN PRIVATE KEY-----',
    'sk-proj-' + 'x'.repeat(30),
    'BEGIN:global-development-skills',
    '# ThreadShelf repository instructions',
    'Floating library login security',
    'synthetic-panel-driver',
  ])('rejects private, agent or demo/test content in an otherwise allowlisted asset', (text) => {
    expect(() => verifyArtifactContent(new Map([['background.js', encode(text)]]))).toThrow();
  });
});
