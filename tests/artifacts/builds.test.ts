import { describe, expect, it } from 'vitest';
import { allowedBuildPath, verifyHtml, verifyManifest } from '../../scripts/verify-builds.mjs';

describe('production output boundaries', () => {
  it.each([
    '.ai/notes.md',
    '.agents/skill.md',
    '.codex/config.json',
    '.claude/log',
    'AGENTS.md',
    '.env',
    'assets/main.js.map',
    'capture.png',
    'demo/index.html',
    'tests/fixture.json',
    '../manifest.json',
    '/manifest.json',
    'background.js/private',
    'public/secret.txt',
  ])('rejects unapproved output %s', (path) => {
    expect(allowedBuildPath('extension', path)).toBe(false);
    expect(allowedBuildPath('demo', path)).toBe(false);
  });

  it('keeps extension code out of the static demo allowlist', () => {
    expect(allowedBuildPath('demo', 'background.js')).toBe(false);
    expect(allowedBuildPath('demo', 'manifest.json')).toBe(false);
    expect(allowedBuildPath('extension', 'chunks/sidepanel-abc.js')).toBe(true);
    expect(allowedBuildPath('demo', 'assets/index-abc.js')).toBe(true);
  });

  it('rejects missing or remote production HTML references', () => {
    const files = new Map([
      ['assets/main.js', Buffer.from('fiction')],
      ['assets/main.css', Buffer.from('fiction')],
    ]);
    expect(() =>
      verifyHtml(
        '<script src="https://example.invalid/a.js"></script><link href="/assets/main.css">',
        files,
      ),
    ).toThrow();
    expect(() =>
      verifyHtml('<script src="/assets/missing.js"></script><link href="/assets/main.css">', files),
    ).toThrow();
    expect(() => verifyHtml('<script>alert(1)</script>', files)).toThrow();
    expect(() =>
      verifyHtml(
        '<script src="/project/assets/main.js"></script><link href="/project/assets/main.css">',
        files,
        '/project/',
      ),
    ).not.toThrow();
  });

  it('rejects extra manifest capabilities', () => {
    expect(() =>
      verifyManifest(
        { manifest_version: 3, externally_connectable: { matches: ['<all_urls>'] } },
        new Map(),
      ),
    ).toThrow();
  });
});
