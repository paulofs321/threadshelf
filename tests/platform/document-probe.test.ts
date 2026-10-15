import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectSelectedDocument } from '../../src/platform/document-probe';

afterEach(() => {
  vi.unstubAllGlobals();
});
describe('self-contained read-only document probe', () => {
  it('returns only structural origin/top-level metadata and never reads DOM text or performs network work', () => {
    const page: { top?: unknown } = {};
    page.top = page;
    const read = vi.fn(() => {
      throw new Error('fiction-private-dom');
    });
    const fetch = vi.fn();
    vi.stubGlobal('window', page);
    vi.stubGlobal('location', { origin: 'https://chatgpt.com' });
    vi.stubGlobal('document', new Proxy({}, { get: read }));
    vi.stubGlobal('fetch', fetch);
    expect(inspectSelectedDocument('https://chatgpt.com')).toEqual({
      origin: 'https://chatgpt.com',
      topLevel: true,
    });
    expect(read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects subframes even when they share the correct origin', () => {
    vi.stubGlobal('window', { top: {} });
    vi.stubGlobal('location', { origin: 'https://chatgpt.com' });
    expect(inspectSelectedDocument('https://chatgpt.com')).toBeNull();
  });
  it('rejects a redirected top-level origin', () => {
    const page: { top?: unknown } = {};
    page.top = page;
    vi.stubGlobal('window', page);
    vi.stubGlobal('location', { origin: 'https://login.invalid' });
    expect(inspectSelectedDocument('https://chatgpt.com')).toBeNull();
  });
  it('still works when serialized without imported module closures, as Chrome requires', () => {
    const page: { top?: unknown } = {};
    page.top = page;
    const result: unknown = runInNewContext(
      `(${inspectSelectedDocument.toString()})('https://www.google.com')`,
      {
        window: page,
        location: { origin: 'https://www.google.com' },
      },
    );
    expect(result).toEqual({ origin: 'https://www.google.com', topLevel: true });
  });
});
