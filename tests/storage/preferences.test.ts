import { describe, expect, it, vi } from 'vitest';
import { LocalPreferences, defaultPreferences } from '../../src/storage/preferences';

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };

  return { preferences: new LocalPreferences(storage), storage, values };
}

describe('safe local preferences without private persistence', () => {
  it('persists only a versioned mode and clears it without touching other application keys', () => {
    const h = fixture();
    h.values.set('unrelated', 'preserved');
    expect(h.preferences.read()).toEqual(defaultPreferences);
    h.preferences.write({ version: 1, mode: 'description' });
    expect(h.preferences.read()).toEqual({ version: 1, mode: 'description' });
    expect(h.storage.setItem).toHaveBeenCalledWith(
      'threadshelf:preferences:v1',
      '{"version":1,"mode":"description"}',
    );
    h.preferences.clear();
    expect(h.preferences.read()).toEqual(defaultPreferences);
    expect(h.values.get('unrelated')).toBe('preserved');
  });
  it.each([
    'invalid json',
    'null',
    '{}',
    '{"version":2,"mode":"keyword"}',
    '{"version":1,"mode":"description","query":"fiction-private"}',
    '{"version":1,"mode":"unknown"}',
  ])('rejects malformed or private persisted value %s', (value) => {
    const h = fixture();
    h.storage.getItem.mockReturnValue(value);
    expect(h.preferences.read()).toEqual(defaultPreferences);
  });
  it('rejects private data on writes and handles denied storage without logging it', () => {
    const h = fixture();
    h.preferences.write({ version: 1, mode: 'keyword', excerpt: 'fiction' } as never);
    expect(h.storage.setItem).not.toHaveBeenCalled();
    h.storage.getItem.mockImplementation(() => {
      throw new Error('fiction-private');
    });
    h.storage.setItem.mockImplementation(() => {
      throw new Error('fiction-private');
    });
    h.storage.removeItem.mockImplementation(() => {
      throw new Error('fiction-private');
    });
    expect(h.preferences.read()).toEqual(defaultPreferences);
    expect(() => h.preferences.write(defaultPreferences)).not.toThrow();
    expect(() => h.preferences.clear()).not.toThrow();
  });
});
