// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const root = vi.hoisted(() => ({ render: vi.fn() }));
const createRoot = vi.hoisted(() => vi.fn(() => root));
vi.mock('react-dom/client', () => ({ createRoot }));
// Composition is tested separately with the real component/client.
vi.mock('../../src/entrypoints/sidepanel/AccessPanel', () => ({ AccessPanel: () => null }));
beforeEach(() => {
  vi.resetModules();
  createRoot.mockClear();
  root.render.mockClear();
  document.body.replaceChildren();
});
afterEach(() => {
  document.body.replaceChildren();
});
describe('side-panel mounting boundary', () => {
  it('mounts the panel into the existing root element', async () => {
    const element = document.createElement('div');
    element.id = 'root';
    document.body.append(element);
    await import('../../src/entrypoints/sidepanel/main');
    expect(createRoot).toHaveBeenCalledWith(element);
    expect(root.render).toHaveBeenCalledOnce();
  });
  it('fails explicitly when the root is missing rather than mounting elsewhere', async () => {
    await expect(import('../../src/entrypoints/sidepanel/main')).rejects.toThrow(
      'ThreadShelf root element is missing.',
    );
    expect(createRoot).not.toHaveBeenCalled();
  });
});
